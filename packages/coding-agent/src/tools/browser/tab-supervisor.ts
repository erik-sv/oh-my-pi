import { getPuppeteerDir, logger, postmortem, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import type { Page, Target } from "puppeteer-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { hasSecretBearingEnv } from "../../exec/child-env";
import { webpExclusionForModel } from "../../utils/image-loading";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { ToolAbortError, ToolError } from "../tool-errors";
import { pickElectronTarget } from "./attach";
import { CmuxTab, runCmuxCode } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { DEFAULT_VIEWPORT } from "./launch";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CmuxBrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "./registry";
import type {
	ReadyInfo,
	RunErrorPayload,
	RunResultOk,
	SessionSnapshot,
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "./tab-protocol";
import type { WorkerHandle } from "./tab-worker-host";
import * as tabWorkerHost from "./tab-worker-host";

export type DialogPolicy = "accept" | "dismiss";

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
	/**
	 * Worker generation this run was dispatched to (worker backend only).
	 * Cancellation and tool replies address THIS handle, never `tab.worker`:
	 * a recycle terminates the timed-out generation and installs a
	 * replacement, so a late abort would otherwise post to a terminated
	 * worker (fatal `InvalidStateError`) or cancel an unrelated run on the
	 * replacement.
	 */
	worker?: WorkerHandle;
	/**
	 * Fires when `releaseTab` closes the tab out from under an in-flight run
	 * (sibling `browser close --all`, session-scoped reap, etc.). Composed
	 * into the cmux run's signal so `wait(...)`, cmux socket calls, and the
	 * facade proxies unwind promptly instead of blocking to the run's
	 * timeout. `pending.reject` still fires first so the awaiting caller
	 * sees the tab-close error immediately; `closeAc` propagates the
	 * cancellation into the still-running `runCmuxCode` body (issue #4499).
	 */
	closeAc?: AbortController;
}

interface TabSessionBase<TBrowser extends BrowserHandle = BrowserHandle> {
	name: string;
	browser: TBrowser;
	targetId: string;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	dialogPolicy?: DialogPolicy;
	kindTag: BrowserKindTag;
	/**
	 * Session id of the caller that CREATED the tab. Preserved across reuse so
	 * that dispose of the creating session can reap browser resources without
	 * yanking the tab out from under a subagent that only reused it.
	 * Undefined when the acquirer did not identify itself.
	 */
	ownerSessionId?: string;
}

export interface WorkerTabSession extends TabSessionBase<PuppeteerBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
}

export interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

export type TabSession = WorkerTabSession | CmuxTabSession;

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	dialogs?: DialogPolicy;
	cmuxSurface?: string;
	/**
	 * Session id of the acquirer. Recorded on the tab when created (never on
	 * reuse) so `releaseTabsForOwner` can walk the shared tabs map on session
	 * dispose. Optional — omitting it opts the tab out of session-scoped reap.
	 */
	ownerSessionId?: string;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
}

export interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
}

export interface ReleaseTabOptions {
	kill?: boolean;
	/** Maximum time for each asynchronous cleanup resource before close fails with diagnostics. */
	timeoutMs?: number;
}

const tabs = new Map<string, TabSession>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();
const DEFAULT_TAB_CLOSE_TIMEOUT_MS = 5_000;
class RecoverableWorkerError extends ToolError {}

async function waitForTabCleanup<T>(
	tab: TabSession,
	timeoutMs: number,
	pendingResource: string,
	promise: Promise<T>,
): Promise<T> {
	const message = `Timed out after ${timeoutMs}ms closing ${tab.kindTag} browser tab ${JSON.stringify(tab.name)}; pending resource: ${pendingResource}`;
	try {
		return await withTimeout(promise, timeoutMs, message);
	} catch (error) {
		if (error instanceof Error && error.message === message) throw new ToolError(message);
		throw error;
	}
}

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}

export function acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const result = prior.then(() => acquireTabImpl(name, browser, opts));
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	acquireChains.set(name, tail);
	void tail.then(() => {
		if (acquireChains.get(name) === tail) acquireChains.delete(name);
	});
	return result;
}

async function acquireTabImpl(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	// Serialized opens can sit behind a slow predecessor in the per-name
	// chain; honor an abort at dequeue instead of spawning a worker and
	// browser hold nobody is waiting for.
	if (opts.signal?.aborted) {
		throw new ToolAbortError("Browser tab open aborted");
	}
	killedTabs.delete(name);
	// Temporary refCount hold so releasing an existing tab on the SAME browser
	// below cannot drop it to refCount 0 and dispose the instance we are about
	// to reuse (e.g. reopening the sole tab with a different dialogs policy).
	let tempHold = false;
	const existing = tabs.get(name);
	if (existing) {
		if (existing.browser === browser && existing.state === "alive") {
			const requestedCmuxSurface = "client" in browser ? (opts.cmuxSurface ?? browser.surface) : undefined;
			if (existing.backend === "cmux" && existing.cmuxAttachedSurface !== requestedCmuxSurface) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				const reuseSteps: string[] = [];
				if (opts.viewport && browser.kind.kind !== "cmux") {
					const dsf = opts.viewport.deviceScaleFactor;
					reuseSteps.push(
						`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
					);
				}
				if (opts.url) {
					reuseSteps.push(
						`await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
					);
				}
				if (reuseSteps.length) {
					await runInTabWithSnapshot(
						name,
						{
							code: reuseSteps.join("\n"),
							timeoutMs: opts.timeoutMs,
							signal: opts.signal,
						},
						{ cwd: process.cwd() },
					);
				}
				return { tab: tabs.get(name)!, created: false };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser) {
		try {
			const result = await acquireCmuxTab(name, browser, opts);
			if (tempHold) await releaseBrowser(browser, { kill: false });
			return result;
		} catch (error) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
	}
	let initPayload: WorkerInitPayload;
	let worker: WorkerHandle;
	try {
		initPayload = await buildInitPayload(browser, opts);
		worker = await tabWorkerHost.spawnTabWorker();
	} catch (error) {
		// Failing before the worker took its own hold must release the
		// temporary one, or the browser's refCount never reaches 0 again.
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	let info: ReadyInfo;
	try {
		info = await initializeTabWorker(worker, initPayload, opts.timeoutMs + GRACE_MS);
	} catch (error) {
		// `BuildMessage`-class failures arrive asynchronously via the worker's `error` event,
		// after `spawnTabWorker`'s synchronous try/catch has already returned. Fall back to
		// the inline worker here so module-resolution failures don't poison every tab open.
		await worker.terminate().catch(() => undefined);
		if (worker.mode === "inline") {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		if (hasSecretBearingEnv(process.env)) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw tabWorkerHost.inlineFallbackBlockedError("Browser tab Worker initialization failed", error);
		}
		logger.warn("Tab worker init failed; retrying with inline tab worker (no sync-loop guard)", {
			error: error instanceof Error ? error.message : String(error),
		});
		worker = await tabWorkerHost.spawnInlineWorker();
		try {
			info = await initializeTabWorker(worker, initPayload, opts.timeoutMs + GRACE_MS);
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			const finalError = new ToolError(
				`Failed to start browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			(finalError as { cause?: unknown }).cause = error;
			throw finalError;
		}
	}

	// If the caller aborted while we were spawning/initializing the worker,
	// tear the freshly-built worker down before publishing the tab so the
	// browser refCount (which `holdBrowser` below would take) never grows for
	// a tab nobody is waiting for.
	if (opts.signal?.aborted) {
		await worker.terminate().catch(() => undefined);
		if (tempHold) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
		throw new ToolAbortError("Browser tab open aborted");
	}

	holdBrowser(browser);
	if (tempHold) await releaseBrowser(browser, { kill: false });
	const tab: WorkerTabSession = {
		name,
		browser,
		targetId: info.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info,
		pending: new Map(),
		dialogPolicy: opts.dialogs,
		kindTag: browser.kind.kind,
		ownerSessionId: opts.ownerSessionId,
	};
	attachWorker(tab, worker);
	tabs.set(name, tab);
	return { tab, created: true };
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const attachedSurface = opts.cmuxSurface ?? browser.surface;
	if (attachedSurface?.startsWith("surface:")) {
		throw new ToolError(
			"app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split",
		);
	}

	let surfaceId = attachedSurface;
	let initialUrl = opts.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: opts.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await browser.client.request("browser.open_split", params, { timeoutMs: opts.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) {
				throw new ToolError("cmux browser.open_split did not return a surface_id");
			}
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (opts.url) {
				await browser.client.request(
					"browser.wait",
					{
						surface_id: surfaceId,
						load_state: mapWaitUntil(opts.waitUntil ?? "load"),
						timeout_ms: opts.timeoutMs,
					},
					{ timeoutMs: opts.timeoutMs },
				);
			}
		}

		const cmuxTab = new CmuxTab({ client: browser.client, surfaceId, url: initialUrl });
		if (attachedSurface && opts.url) {
			await cmuxTab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: opts.timeoutMs });
		}
		const info = await cmuxTab.readyInfo(opts.viewport ?? DEFAULT_VIEWPORT);
		// If the caller aborted while we were opening the cmux surface, close the
		// surface (if we own it) instead of taking a browser hold on it.
		if (opts.signal?.aborted) {
			throw new ToolAbortError("Browser tab open aborted");
		}
		holdBrowser(browser);
		const tab: CmuxTabSession = {
			name,
			browser,
			targetId: surfaceId,
			backend: "cmux",
			cmuxTab,
			cmuxOwnsSurface: ownsSurface,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			cmuxAttachedSurface: attachedSurface,
			ownerSessionId: opts.ownerSessionId,
		};
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		if (ownsSurface && surfaceId) {
			await browser.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
		}
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{ code: opts.code, timeoutMs: opts.timeoutMs, signal: opts.signal, session: opts.session },
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
}

async function runInTabWithSnapshot(
	name: string,
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession },
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.pending.size > 0) throw new ToolError(`Tab ${JSON.stringify(name)} is busy`);
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	// `releaseTab` calls `pending.reject(closeError)` when the tab dies
	// out from under an in-flight run (sibling `browser close --all`,
	// session-scoped reap, etc.). Both backends below MUST end up awaiting
	// this same `promise` so:
	//   1. The caller sees `Tab ... was closed` immediately instead of
	//      blocking to the run's timeout, and
	//   2. `reject(...)` always has an attached handler — a zero-consumer
	//      rejection would fire `unhandledRejection` and the CLI's
	//      top-level handler would tear the whole session down, killing
	//      every other tab and subagent sharing the process (issue #4499).
	// The cmux branch also composes `closeAc.signal` into the run's abort
	// signal so `wait(...)`, cmux socket calls, and the facade proxies
	// unwind promptly when the tab is closed — otherwise a `wait(60_000)`
	// with no in-flight socket request would keep `runCmuxCode` blocked
	// until timeout even after the tab is gone.
	const closeAc = new AbortController();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
		closeAc,
	};
	tab.pending.set(id, pending);
	if (tab.backend === "cmux") {
		const runSignal = opts.signal ? AbortSignal.any([opts.signal, closeAc.signal]) : closeAc.signal;
		try {
			// `runCmuxCode.then(resolve, reject)` publishes the run's real
			// outcome to `promise`, but `releaseTab` may have already
			// rejected it — `Promise.withResolvers` settles on the first
			// call and later resolve/reject are no-ops, so the tab-close
			// error still wins the race.
			runCmuxCode(tab.cmuxTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
			}).then(resolve, reject);
			return await promise;
		} finally {
			tab.pending.delete(id);
		}
	}
	// Pin the generation at dispatch. `tab.worker` is replaced by a recycle and
	// terminated by a kill; addressing it later either posts to a dead worker or
	// cancels somebody else's run on the replacement.
	const worker = tab.worker;
	pending.worker = worker;
	const abort = (): void => {
		// Abort listeners run inside whoever fired the signal. For eval cells
		// that is a bare `setTimeout` in `IdleTimeout`. A throw here is an
		// uncaught exception, not a rejected promise, so it would kill the
		// process instead of failing this run.
		try {
			worker.send({ type: "abort", id });
			for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
		} catch (error) {
			logBrowserFailure("abort-dispatch", tab, { runId: id, worker, error, session: opts.session });
		}
	};
	let detached = false;
	const detach = (): void => {
		if (detached) return;
		detached = true;
		opts.signal?.removeEventListener("abort", abort);
		tab.pending.delete(id);
	};
	if (opts.signal?.aborted) abort();
	else opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		const dispatched = worker.send({
			type: "run",
			id,
			name,
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			session: snapshot,
		});
		if (!dispatched) {
			throw new ToolError(`Tab ${JSON.stringify(name)} worker is gone. Reopen it with action:"open".`);
		}
		return await raceWithTimeout(
			promise,
			opts.timeoutMs + GRACE_MS,
			"Browser code execution hung past grace; tab killed",
			async reason => {
				// Teardown terminates this generation; the run's cancellation
				// must not outlive it.
				detach();
				logBrowserFailure("grace-timeout", tab, {
					runId: id,
					worker,
					reason,
					timeoutMs: opts.timeoutMs,
					session: opts.session,
				});
				await forceKillTab(tab, reason);
			},
		);
	} catch (error) {
		// Detach BEFORE recovery: recycling terminates this generation and the
		// awaits below are exactly the window the incident's abort landed in.
		detach();
		const runTimedOut =
			error instanceof ToolError && error.message.startsWith("Browser code execution timed out after ");
		if (runTimedOut || error instanceof RecoverableWorkerError) {
			logBrowserFailure("run-timeout", tab, {
				runId: id,
				worker,
				error,
				timeoutMs: opts.timeoutMs,
				session: opts.session,
			});
			try {
				if (worker.mode === "inline") {
					const reason = runTimedOut
						? "Browser code execution timed out; tab killed"
						: "Browser request interception cleanup failed; tab killed";
					await forceKillTab(tab, reason);
				} else {
					await recycleTimedOutWorkerTab(tab, worker, opts.timeoutMs + GRACE_MS);
				}
			} catch (recycleError) {
				logBrowserFailure("recycle-failed", tab, {
					runId: id,
					worker,
					error: recycleError,
					session: opts.session,
				});
				await forceKillTab(tab, "Browser tab worker recovery failed; tab killed");
			}
		}
		throw error;
	} finally {
		detach();
	}
}

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	for (const [id, pending] of tab.pending) {
		// Cancel on the generation that owns the run; `send` reports delivery
		// instead of throwing, so an already-dead worker is simply skipped.
		if (tab.backend === "worker") (pending.worker ?? tab.worker).send({ type: "abort", id, expectedCleanup: true });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);
		// Propagate the closure into the cmux run's abort signal so
		// `wait(...)`, in-flight cmux socket calls, and the facade proxies
		// unwind promptly. Firing this BEFORE `pending.reject` means
		// `runCmuxCode` finishes with `ToolAbortError` and its `.then(reject)`
		// is a no-op — `promise` still settles with the tab-close error via
		// the `reject` call below. Without it, a run that isn't currently
		// making a socket request (e.g. `await wait(60_000)`) would keep
		// `runCmuxCode` blocked until timeout even after `pending.reject`
		// unblocked the caller (issue #4499 review feedback).
		pending.closeAc?.abort(closeError);
		pending.reject(closeError);
	}
	tab.pending.clear();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TAB_CLOSE_TIMEOUT_MS;
	if (tab.backend === "cmux") {
		let closeError: unknown;
		if (wasAlive && tab.cmuxOwnsSurface) {
			try {
				await waitForTabCleanup(
					tab,
					timeoutMs,
					`cmux surface ${JSON.stringify(tab.targetId)} (surface.close)`,
					tab.browser.client.request("surface.close", { surface_id: tab.targetId }, { timeoutMs }),
				);
			} catch (err) {
				if (isLastSurfaceCloseError(err)) {
					logger.debug("Leaving cmux browser surface open because it is the last surface in the workspace", {
						error: err instanceof Error ? err.message : String(err),
					});
				} else {
					closeError = err;
				}
			}
		}
		try {
			await releaseBrowser(tab.browser, {
				kill: opts.kill ?? false,
				timeoutMs,
				resource: `tab ${JSON.stringify(name)}`,
			});
		} catch (error) {
			closeError ??= error;
		} finally {
			evictTab(name, tab);
		}
		if (closeError) throw closeError;
		return true;
	}
	let cleanupError: unknown;
	let forced = !wasAlive;
	if (wasAlive) {
		// An undeliverable close means the worker is already gone: skip the
		// handshake and go straight to the orphan-target sweep.
		if (tab.worker.send({ type: "close" })) {
			try {
				await waitForClosed(tab);
			} catch {
				forced = true;
			}
		} else {
			forced = true;
		}
	}
	await tab.worker.terminate().catch(() => undefined);
	if (forced && tab.kindTag === "headless") {
		try {
			await waitForTabCleanup(
				tab,
				timeoutMs,
				`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
				closeOrphanTarget(tab),
			);
		} catch (error) {
			cleanupError = error;
		}
	}
	try {
		await releaseBrowser(tab.browser, {
			kill: opts.kill ?? false,
			timeoutMs,
			resource: `tab ${JSON.stringify(name)}`,
		});
	} catch (error) {
		cleanupError ??= error;
	} finally {
		evictTab(name, tab);
	}
	if (cleanupError) throw cleanupError;
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = [...tabs.values()].filter(tab => tab.kindTag === "headless").map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}

/**
 * Release every tab created by the given session id. Invoked from
 * `AgentSession.dispose()` so headless/spawned Chromium and workers the
 * session opened do not leak into the long-lived process — the module-global
 * `tabs`/`browsers` maps that back this tool are not otherwise walked by
 * session teardown. (Issue #3963.)
 *
 * Ownership is recorded ONLY on tab creation (`acquireTab` with
 * `ownerSessionId`), never on reuse: a subagent re-driving a tab another
 * session opened will not yank teardown responsibility away from the
 * creator. Tabs opened with no owner (e.g. from an SDK caller that doesn't
 * identify a session) are skipped and must be released explicitly.
 */
export async function releaseTabsForOwner(ownerId: string, opts: ReleaseTabOptions = {}): Promise<number> {
	if (!ownerId) return 0;
	const names = [...tabs.values()].filter(tab => tab.ownerSessionId === ownerId).map(tab => tab.name);
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

/** Test-only accessor for the module-global tabs map. */
export function getTabsMapForTest(): ReadonlyMap<string, TabSession> {
	return tabs;
}

function isLastSurfaceCloseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /last/i.test(message);
}

async function buildInitPayload(browser: PuppeteerBrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const safeDir = getPuppeteerDir();
	const browserWSEndpoint = browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	if (browser.kind.kind === "headless") {
		return {
			mode: "headless",
			browserWSEndpoint,
			safeDir,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
		};
	}
	const page = await pickElectronTarget(browser.browser, opts.target);
	const targetId = await targetIdForPage(page);
	return {
		mode: "attach",
		browserWSEndpoint,
		safeDir,
		targetId,
		dialogs: opts.dialogs,
	};
}

/**
 * Bind a worker generation to the tab it now serves. Both listeners are
 * released by {@link WorkerHandle.terminate}, so a replaced generation cannot
 * keep talking to the tab.
 */
function attachWorker(tab: WorkerTabSession, worker: WorkerHandle): void {
	worker.onMessage(msg => handleTabMessage(tab, worker, msg));
	worker.onError(error => handleWorkerFailure(tab, worker, error));
}

function handleTabMessage(tab: WorkerTabSession, worker: WorkerHandle, msg: WorkerOutbound): void {
	// A superseded generation can still have messages queued; they must never
	// settle work the replacement owns.
	if (tab.worker !== worker) return;
	if (msg.type === "result") {
		const pending = tab.pending.get(msg.id);
		if (!pending) return;
		tab.pending.delete(msg.id);
		if (msg.ok) {
			pending.resolve(msg.payload);
			return;
		}
		pending.reject(errorFromPayload(msg.error));
		return;
	}
	if (msg.type === "ready") {
		tab.info = msg.info;
		return;
	}
	if (msg.type === "tool-call") {
		void dispatchToolCall(tab, worker, msg);
		return;
	}
	if (msg.type === "log") logWorkerMessage(msg);
}

/**
 * A worker generation died on its own (uncaught worker error, `messageerror`).
 * Reclaiming the browser hold stays with `releaseTab`/`acquireTab`: starting
 * async CDP teardown from an event handler would race the very teardown paths
 * this ownership model fixes.
 */
function handleWorkerFailure(tab: WorkerTabSession, worker: WorkerHandle, error: Error): void {
	if (tab.worker !== worker || tab.state !== "alive") return;
	logBrowserFailure("worker-error", tab, { worker, error });
	abandonWorkerGeneration(tab, worker, `Browser tab worker failed: ${boundedDetail(error.message)}`);
}

/**
 * The generation can no longer be talked to. Settle the runs it owed instead of
 * making each caller wait out its grace window, and mark the tab dead so the
 * next `run` says why and the next `open` rebuilds it.
 */
function abandonWorkerGeneration(tab: WorkerTabSession, worker: WorkerHandle, reason: string): void {
	if (tab.worker !== worker || tab.state !== "alive") return;
	tab.state = "dead";
	killedTabs.set(tab.name, reason);
	settlePendingRuns(tab, worker, new ToolError(reason));
	void worker.terminate().catch(() => undefined);
}

/** Settle every run owned by `worker`; that generation can no longer answer. */
function settlePendingRuns(tab: WorkerTabSession, worker: WorkerHandle, error: Error): void {
	for (const [id, pending] of tab.pending) {
		if (pending.worker && pending.worker !== worker) continue;
		tab.pending.delete(id);
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
		pending.reject(error);
	}
}

async function dispatchToolCall(
	tab: WorkerTabSession,
	worker: WorkerHandle,
	msg: Extract<WorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, worker, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {
				// Status events from tool calls aren't piped back to user code yet; the worker
				// already pushes its own helper status via the display channel.
			},
		});
		safeSend(tab, worker, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, worker, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

/**
 * Reply to the generation that asked, and only while it still owns the tab. A
 * reply that cannot be delivered means that generation is gone: the run waiting
 * on it can never complete, so abandon it now rather than at the grace timeout.
 */
function safeSend(tab: WorkerTabSession, worker: WorkerHandle, msg: WorkerInbound): void {
	if (tab.state !== "alive" || tab.worker !== worker) return;
	if (worker.send(msg)) return;
	logBrowserFailure("send-dropped", tab, { worker, reason: msg.type });
	abandonWorkerGeneration(tab, worker, "Browser tab worker stopped accepting messages");
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

async function recycleTimedOutWorkerTab(
	tab: WorkerTabSession,
	previous: WorkerHandle,
	timeoutMs: number,
): Promise<void> {
	await previous.terminate().catch(() => undefined);
	// Anything still registered against the terminated generation will never be
	// answered; settle it before a replacement can claim the tab.
	settlePendingRuns(
		tab,
		previous,
		postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(tab.name)} worker was recycled`)),
	);
	const browserWSEndpoint = tab.browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	const payload: WorkerInitPayload = {
		mode: "attach",
		browserWSEndpoint,
		safeDir: getPuppeteerDir(),
		targetId: tab.targetId,
		dialogs: tab.dialogPolicy,
		// Unblock a wedged page (open JS dialog, hung navigation) before adopting it —
		// otherwise init stalls, times out, and the tab gets force-killed.
		recover: true,
	};
	let worker = await tabWorkerHost.spawnTabWorker();
	try {
		adoptRecycledWorker(tab, previous, worker, await initializeTabWorker(worker, payload, timeoutMs));
	} catch (error) {
		await worker.terminate().catch(() => undefined);
		if (hasSecretBearingEnv(process.env)) {
			throw tabWorkerHost.inlineFallbackBlockedError("Timed-out browser tab Worker recycling failed", error);
		}
		worker = await tabWorkerHost.spawnInlineWorker();
		try {
			adoptRecycledWorker(tab, previous, worker, await initializeTabWorker(worker, payload, timeoutMs));
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			const finalError = new ToolError(
				`Failed to recycle timed-out browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			Object.defineProperty(finalError, "cause", { value: error, configurable: true });
			throw finalError;
		}
	}
}

/**
 * Publish a freshly initialized generation onto the tab, but only while the
 * tab is still registered, still owned by the generation we replaced, and still
 * alive. Losing that race means a concurrent `releaseTab`/`forceKillTab`/reopen
 * owns the name now: adopting anyway would resurrect a torn-down tab and strand
 * the new worker outside the registry.
 */
function adoptRecycledWorker(tab: WorkerTabSession, previous: WorkerHandle, next: WorkerHandle, info: ReadyInfo): void {
	if (tabs.get(tab.name) !== tab || tab.worker !== previous || tab.state !== "alive") {
		logBrowserFailure("recycle-superseded", tab, { worker: next });
		void next.terminate().catch(() => undefined);
		return;
	}
	tab.worker = next;
	tab.info = info;
	attachWorker(tab, next);
}

/**
 * Tear down the tab a run owns. The caller passes the tab it dispatched to, not
 * a name: teardown awaits CDP and browser cleanup, and by the time a wedged run
 * gets here the name may already belong to a reopened tab or to a concurrent
 * `releaseTab`. Claiming the registry entry up front makes teardown single-owner
 * (a losing caller returns instead of releasing a browser hold twice) and
 * frees the name for an immediate reopen.
 */
async function forceKillTab(tab: TabSession, reason: string): Promise<void> {
	if (tabs.get(tab.name) !== tab || tab.state !== "alive") return;
	tab.state = "dead";
	tabs.delete(tab.name);
	killedTabs.set(tab.name, reason);
	const error = postmortem.markExpectedCleanupError(new ToolError(reason));
	for (const pending of tab.pending.values()) {
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
		pending.reject(error);
	}
	tab.pending.clear();
	if (tab.backend === "cmux") {
		await releaseBrowser(tab.browser, { kill: false });
		return;
	}
	await tab.worker.terminate().catch(() => undefined);
	if (tab.kindTag === "headless") await closeOrphanTarget(tab);
	await releaseBrowser(tab.browser, { kill: false });
}

/**
 * Drop the registry entry only while it still points at the tab we tore down.
 * Teardown awaits CDP and browser cleanup, and another caller can reopen the
 * name inside that window; deleting blindly strands the newer tab's worker and
 * browser hold (same guard `releaseBrowser` applies to handles).
 */
function evictTab(name: string, tab: TabSession): void {
	if (tabs.get(name) === tab) tabs.delete(name);
}

async function closeOrphanTarget(tab: WorkerTabSession): Promise<void> {
	for (const target of tab.browser.browser.targets()) {
		if ((await targetIdForTarget(target).catch(() => "")) !== tab.targetId) continue;
		const page = await target.page().catch(() => null);
		await page?.close().catch(() => undefined);
		return;
	}
}

async function waitForClosed(tab: WorkerTabSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(promise, GRACE_MS, "Timed out closing browser tab worker");
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = session.settings.get("browser.screenshotDir") as string | undefined;
	return value ? expandPath(value) : undefined;
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

async function targetIdForTarget(target: Target): Promise<string> {
	const raw = target as unknown as { _targetId?: unknown };
	if (typeof raw._targetId === "string") return raw._targetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.recoverTab
		? new RecoverableWorkerError(payload.message)
		: payload.isAbort
			? new ToolAbortError()
			: payload.isToolError
				? new ToolError(payload.message)
				: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: string,
	onTimeout?: (reason: string) => Promise<void>,
): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(new ToolError(reason));
	timeoutSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (error instanceof ToolError && error.message === reason) await onTimeout?.(reason);
		throw error;
	} finally {
		timeoutSignal.removeEventListener("abort", onAbort);
	}
}

type BrowserFailurePhase =
	| "abort-dispatch"
	| "grace-timeout"
	| "run-timeout"
	| "recycle-failed"
	| "recycle-superseded"
	| "send-dropped"
	| "worker-error";

interface BrowserFailureDetail {
	runId?: string;
	worker?: WorkerHandle;
	error?: unknown;
	reason?: string;
	timeoutMs?: number;
	session?: ToolSession;
}

const FAILURE_DETAIL_LIMIT = 300;

/** Keep a wedged page's multi-kilobyte error out of the log file. */
function boundedDetail(text: string): string {
	return text.length <= FAILURE_DETAIL_LIMIT
		? text
		: `${text.slice(0, FAILURE_DETAIL_LIMIT)}...(+${text.length - FAILURE_DETAIL_LIMIT} chars)`;
}

/** `error` marks a failure that ended a run or a tab; `warn` marks recovery. */
const FAILURE_LOG_LEVEL: Record<BrowserFailurePhase, "error" | "warn"> = {
	"abort-dispatch": "error",
	"grace-timeout": "warn",
	"run-timeout": "warn",
	"recycle-failed": "error",
	"recycle-superseded": "warn",
	"send-dropped": "error",
	"worker-error": "error",
};

/**
 * Forensics for the worker/timeout boundaries that produced the fatal browser
 * crash: enough identity to correlate a log line with a tab, run, session and
 * worker generation, and nothing else. Evaluated code, page content, prompts,
 * and environment never reach the log; the cause string is bounded.
 */
function logBrowserFailure(phase: BrowserFailurePhase, tab: TabSession, detail: BrowserFailureDetail = {}): void {
	const { error } = detail;
	const log = FAILURE_LOG_LEVEL[phase] === "error" ? logger.error : logger.warn;
	log("Browser tab failure", {
		phase,
		tab: tab.name,
		backend: tab.backend,
		browser: tab.kindTag,
		target: tab.targetId,
		runId: detail.runId,
		sessionId: detail.session?.getSessionId?.() ?? tab.ownerSessionId,
		worker: detail.worker && `${detail.worker.mode}#${detail.worker.id}`,
		workerAlive: detail.worker?.alive,
		pendingRuns: tab.pending.size,
		timeoutMs: detail.timeoutMs,
		reason: detail.reason,
		errorName: error instanceof Error ? error.name : undefined,
		error: error === undefined ? undefined : boundedDetail(error instanceof Error ? error.message : String(error)),
	});
}

async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	const { promise, resolve, reject } = Promise.withResolvers<ReadyInfo>();
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "ready") resolve(msg.info);
		else if (msg.type === "init-failed") reject(errorFromPayload(msg.error));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		reject(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		if (!worker.send({ type: "init", payload })) {
			throw new ToolError("Tab worker exited before initialization");
		}
		return await raceWithTimeout(promise, timeoutMs, "Timed out initializing browser tab worker");
	} finally {
		unlisten();
		unlistenError();
	}
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs);
}
