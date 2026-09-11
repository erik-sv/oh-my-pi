import { getProjectDir, getPuppeteerDir, logger, postmortem, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import type { Page, Target } from "puppeteer-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { webpExclusionForModel } from "../../utils/image-loading";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { ToolAbortError, ToolError } from "../tool-errors";
import { pickElectronTarget, shouldPreserveConnectedBrowserFocus } from "./attach";
import { CmuxTab, runCmuxCode } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { DEFAULT_VIEWPORT } from "./launch";
import { closeCdpTarget, forgetSharedTarget, recordSharedTarget, type SharedTargetScope } from "./orphan-registry";
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
import * as tabWorkerHost from "./tab-worker-host";
import type { WorkerHandle } from "./tab-worker-host";

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
	activateForScreenshot: boolean;
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
	/**
	 * `performance.now()` timestamp at which the caller's timeout budget
	 * started. Callers whose deadline began before this acquisition —
	 * `browser.ts` `open` starts its clock before `acquireBrowser` — pass it
	 * through so time spent in earlier phases within the caller's deadline
	 * counts against the worker-init budget instead of restarting it.
	 * Omit for a fresh clock.
	 */
	deadlineStartMs?: number;
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
// Headless targets a worker created before dying during init (page-created).
// A killed worker can't close its own page; the supervisor closes the
// recorded target instead. A shared browser's other targets must never be
// touched.
const workerPageTargets = new WeakMap<WorkerHandle, string>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
// Cold-start guard for the worker's `setup` handshake (realm usable: puppeteer
// loaded, browser connected, page acquired). On hosts where the worker's cold
// import stalls (observed: Bun worker inside a full RPC process), an
// unbounded first-attempt init would consume the caller's entire timeout
// before the inline fallback could engage. Budget: min(10s, remaining/3),
// floor 2s, where remaining is what the caller's budget has left at attempt start.
const SETUP_BUDGET_FLOOR_MS = 2_000;
const SETUP_BUDGET_CAP_MS = 10_000;
// Floor for the ready-phase budget: the 2s setup floor can consume more than
// a sub-3s caller's entire init budget, so the remaining-budget math must
// never hand raceWithTimeout a non-positive value.
const READY_BUDGET_FLOOR_MS = 500;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();
const DEFAULT_TAB_CLOSE_TIMEOUT_MS = 5_000;
class RecoverableWorkerError extends ToolError {}
const REPORTED_INIT_FAILURE = Symbol("reported-init-failure");

type ReportedInitFailure = Error & { [REPORTED_INIT_FAILURE]?: true };

function markReportedInitFailure(error: Error): Error {
	(error as ReportedInitFailure)[REPORTED_INIT_FAILURE] = true;
	return error;
}

function isReportedInitFailure(error: unknown): boolean {
	return error instanceof Error && (error as ReportedInitFailure)[REPORTED_INIT_FAILURE] === true;
}

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
	// Keep the supervisor's Puppeteer handle connected until initialization,
	// worker termination, and abandoned-target cleanup have all been scheduled.
	// The tool caller's outer timeout can release its own lease before this
	// promise settles; without an acquisition-owned hold, cleanup would then
	// run through a disconnected handle and leave the worker's page behind.
	holdBrowser(browser);
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const acquisition = prior.then(() => acquireTabImpl(name, browser, opts));
	const result = acquisition.then(
		async value => {
			await releaseBrowser(browser, { kill: false });
			return value;
		},
		async error => {
			await releaseBrowser(browser, { kill: false }).catch(() => undefined);
			throw error;
		},
	);
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
	// Worker-init deadline: the inline-fallback retry passes this same start
	// so it can't restart the budget (which would let a cold import that
	// consumed most of it spend the phase floors again for another full
	// budget). Defaults to a fresh clock; callers whose own deadline started
	// earlier (browser acquisition is not part of this budget) pass theirs
	// through `deadlineStartMs` so that earlier time counts against it.
	const startedAt = opts.deadlineStartMs ?? performance.now();
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
						{ cwd: getProjectDir() },
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
	// Init budget: the caller's timeout plus the supervisor grace — never a
	// fixed floor. A floor larger than the caller's budget would keep a wedged
	// worker (and its orphaned page on a shared browser) alive long after the
	// caller gave up; the phase floors inside initializeTabWorker keep each
	// phase positive for sub-second budgets, and the caller's abort signal is
	// the hard backstop for floor overshoot.
	const initBudgetMs = opts.timeoutMs + GRACE_MS;
	let info: ReadyInfo;
	try {
		info = await initializeTabWorker(worker, initPayload, initBudgetMs, startedAt);
	} catch (error) {
		// `BuildMessage`-class failures arrive asynchronously via the worker's `error` event,
		// after `spawnTabWorker`'s synchronous try/catch has already returned. Fall back to
		// the inline worker here so module-resolution failures don't poison every tab open.
		await worker.terminate().catch(() => undefined);
		// A headless worker that died mid-init may have already created its page in the
		// shared browser — a killed worker can't close it, so close the target the worker
		// reported (no-op when it never got that far).
		closeAbandonedWorkerPage(browser, worker);
		if (worker.mode === "inline" || isReportedInitFailure(error)) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		// Fail fast once the caller's init budget is exhausted: its timeout has already
		// fired, so a retried result would only be discarded by the post-init abort check —
		// don't spend the phase floors' excess on a cold start nobody is waiting for.
		if (initBudgetExhausted(initBudgetMs, startedAt)) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		logger.warn("Tab worker init failed; retrying with inline tab worker (no sync-loop guard)", {
			error: error instanceof Error ? error.message : String(error),
		});
		worker = await tabWorkerHost.spawnInlineWorker();
		try {
			info = await initializeTabWorker(worker, initPayload, initBudgetMs, startedAt);
		} catch (inlineError) {
			await worker.terminate().catch(() => undefined);
			closeAbandonedWorkerPage(browser, worker);
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			const finalError = new ToolError(
				`Failed to start browser tab worker (inline fallback also failed): ${inlineError instanceof Error ? inlineError.message : String(inlineError)}`,
			);
			(finalError as { cause?: unknown }).cause = error;
			throw finalError;
		}
	}

	// If the caller aborted while we were spawning/initializing the worker, tear
	// the freshly-built worker down before publishing the tab so the browser
	// refCount (which `holdBrowser` below would take) never grows for a tab
	// nobody is waiting for. Mirror the error paths' `refCount === 0` release so
	// a fresh browser held by nothing but this aborted open is not orphaned in
	// the registry; a browser still leased/held elsewhere (refCount > 0) is left
	// for its owner to release.
	if (opts.signal?.aborted) {
		await worker.terminate().catch(() => undefined);
		closeAbandonedWorkerPage(browser, worker);
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
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
		activateForScreenshot: initPayload.mode === "headless" || initPayload.activateForScreenshot !== false,
		ownerSessionId: opts.ownerSessionId,
	};
	attachWorker(tab, worker);
	tabs.set(name, tab);
	// Durably record ownership so another live omp process can reap this page if
	// this process dies abnormally before its own teardown closes the tab.
	const scope = sharedScopeOf(browser);
	if (scope) void recordSharedTarget(scope, info.targetId);
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
		const scope = sharedScopeOf(tab.browser);
		if (scope) void forgetSharedTarget(scope, tab.targetId);
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
			// Visible launches still need an OMP-owned page, stealth setup, and
			// independent lifecycle; only their fixed device emulation is disabled.
			emulateViewport: browser.kind.headless,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
		};
	}
	// Connected and relay browsers are user-driven. When no target is requested,
	// adopt the visible tab and avoid raising it before screenshots. An explicit
	// target may be backgrounded, so retain activation for target-correct pixels.
	const userDriven = browser.kind.kind === "connected" || browser.kind.kind === "relay";
	const activateForScreenshot = !userDriven || !shouldPreserveConnectedBrowserFocus(opts.target);
	const page = await pickElectronTarget(browser.browser, {
		matcher: opts.target,
		preferVisible: !activateForScreenshot,
	});
	const targetId = await targetIdForPage(page);
	return {
		mode: "attach",
		browserWSEndpoint,
		safeDir,
		targetId,
		dialogs: opts.dialogs,
		url: opts.url,
		waitUntil: opts.waitUntil,
		timeoutMs: opts.timeoutMs,
		activateForScreenshot,
	};
}

/**
 * Bind a worker generation to the tab it now serves. Both listeners are
 * released by {@link WorkerHandle.terminate}, so a replaced generation cannot
 * keep talking to the tab.
 */
function attachWorker(tab: WorkerTabSession, worker: WorkerHandle): void {
	// Runtime events have no caller frame to catch a handler failure.
	worker.onMessage(msg => {
		try {
			handleTabMessage(tab, worker, msg);
		} catch (error) {
			logBrowserFailure("worker-event", tab, { worker, error, reason: "message" });
		}
	});
	worker.onError(error => {
		try {
			handleWorkerFailure(tab, worker, error);
		} catch (handlerError) {
			logBrowserFailure("worker-event", tab, { worker, error: handlerError, reason: "error" });
		}
	});
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
		// Same containment for the async half: an unhandled rejection out of a
		// tool dispatch is just as fatal as a synchronous throw.
		void dispatchToolCall(tab, worker, msg).catch(error => {
			logBrowserFailure("worker-event", tab, { runId: msg.runId, worker, error, reason: "tool-call" });
		});
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
	// Same deadline carry-over as acquireTabImpl: the inline-fallback retry
	// must not restart the recycle's init budget.
	const startedAt = performance.now();
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
		timeoutMs,
		activateForScreenshot: tab.activateForScreenshot,
	};
	let worker = await tabWorkerHost.spawnTabWorker();
	try {
		adoptRecycledWorker(tab, previous, worker, await initializeTabWorker(worker, payload, timeoutMs, startedAt));
	} catch (error) {
		await worker.terminate().catch(() => undefined);
		// The recycle's budget is exhausted: the run caller already timed out, so a
		// retried init can't beat its deadline — fail fast and let the caller
		// force-kill the tab instead of spending the phase floors' excess.
		if (initBudgetExhausted(timeoutMs, startedAt)) {
			throw error;
		}
		worker = await tabWorkerHost.spawnInlineWorker();
		try {
			adoptRecycledWorker(tab, previous, worker, await initializeTabWorker(worker, payload, timeoutMs, startedAt));
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
	const scope = sharedScopeOf(tab.browser);
	if (scope) void forgetSharedTarget(scope, tab.targetId);
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

/**
 * Best-effort close of a specific page target in the browser. Close through
 * the browser CDP session rather than `page.close()`: a page whose navigation
 * wedged during initialization can make Puppeteer's page close wait for the
 * protocol timeout, retaining the cleanup hold for tens of seconds.
 */
async function closeTargetById(browser: PuppeteerBrowserHandle, targetId: string): Promise<void> {
	await closeCdpTarget(browser.browser, targetId);
}

/**
 * Durable-ownership scope for a browser handle, or undefined when the handle is
 * not the project-shared broker-owned Chromium (the only browser whose targets
 * outlive their creating process and thus need cross-process orphan reaping).
 */
function sharedScopeOf(browser: BrowserHandle): SharedTargetScope | undefined {
	if ("client" in browser) return undefined;
	if (browser.kind.kind !== "headless" || !browser.sharedDaemon) return undefined;
	return { projectDir: browser.sharedDaemon.projectDir, daemonName: browser.sharedDaemon.name };
}

/**
 * Best-effort cleanup for a forced-kill path: close the page the tab's worker
 * reported as created. A run caller is never a browser ref holder, so the
 * browser is still in the registry; the tab's browser is the only place that
 * page can be, so no targetId guesswork across multiple sessions.
 */
async function closeOrphanTarget(tab: WorkerTabSession): Promise<void> {
	await closeTargetById(tab.browser, tab.targetId);
}

/**
 * Close the page a worker created (page-created) before dying during init.
 * Fire-and-forget: the caller has already timed out, so cleanup must not delay
 * error propagation. A killed worker can't clean up after itself; a shared
 * browser's other targets must never be touched.
 */
function closeAbandonedWorkerPage(browser: PuppeteerBrowserHandle, worker: WorkerHandle): void {
	const targetId = workerPageTargets.get(worker);
	workerPageTargets.delete(worker);
	if (!targetId) return;
	// The close outlives its caller, and every caller here may go on to release
	// the last browser reference — `closeTargetById` yields before it looks the
	// target up, so a disconnect in that gap turns the lookup into a caught
	// failure and leaves the page on the instance for good. Hold the browser
	// across the close instead of blocking on it: the hold defers the release
	// (and the dispose behind it) rather than cancelling one, so the refCount
	// ends where it would have, one turn later.
	holdBrowser(browser);
	void closeTargetById(browser, targetId)
		.catch(() => undefined)
		.finally(() => void releaseBrowser(browser, { kill: false }).catch(() => undefined));
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
	// Manual timer rather than `AbortSignal.timeout()`: under the Bun test
	// runner, a `Promise.race` with a never-settling bare member and an
	// `AbortSignal.timeout`-driven member never fires the signal's timer
	// (the timer queue wedges and even the runner's own per-test timeout
	// stops firing), so the timeout path hangs instead of rejecting. A
	// plain `setTimeout` fires reliably under both the runner and plain
	// execution (Bun 1.3.14).
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new ToolError(reason)), timeoutMs);
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (error instanceof ToolError && error.message === reason) await onTimeout?.(reason);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

type BrowserFailurePhase =
	| "abort-dispatch"
	| "grace-timeout"
	| "run-timeout"
	| "recycle-failed"
	| "recycle-superseded"
	| "send-dropped"
	| "worker-error"
	| "worker-event";

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
	"worker-event": "error",
};

/**
 * Forensics for the worker/timeout boundaries that produced the fatal browser
 * crash: enough identity to correlate a log line with a tab, run, session and
 * worker generation. Do not add request code, page snapshots, prompts or
 * environment fields. Error messages are bounded separately.
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

/**
 * Init a tab worker under a single listener spanning the whole init: a short
 * `setup` handshake (bounded by the cold-start guard so a stalled cold start
 * triggers the inline fallback early) and the ready wait for page acquisition
 * and the first navigation. Both phases are bounded by the time LEFT of the
 * caller's `timeoutMs` budget, measured from `deadlineStart` (performance.now()
 * when the caller's budget began): a retried attempt — the inline fallback
 * after a failed isolated worker — passes the same start, so total init
 * across attempts stays within the caller's timeout instead of the retry
 * restarting the clock. A headless worker's `page-created` report (the new
 * target, sent before the slow post-creation CDP work) is recorded in
 * `workerPageTargets` so a supervisor that kills the worker during init
 * (budget exhausted, aborted open) can close exactly the page the worker
 * created — a killed worker can't clean up after itself. The listener is
 * never removed between the phases: the inline transport delivers messages
 * on microtasks, so a `ready` or `init-failed` emitted right after `setup`
 * (e.g. a fast `page.goto` rejection) could otherwise reach the
 * already-settled setup listener before a phase switch re-listens and be
 * dropped.
 */
async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	// Derive both phase budgets from the remaining caller budget so a
	// retried attempt (inline fallback) cannot outlive the caller's timeout.
	// The floors keep the budgets positive when the remaining time is tiny;
	// the caller's abort signal remains the hard backstop for the overshoot.
	const remainingMs = timeoutMs - Math.round(performance.now() - deadlineStart);
	// Cold-start guard: min(10s, remaining/3), floor 2s (see SETUP_BUDGET_*).
	const setupBudgetMs = Math.max(SETUP_BUDGET_FLOOR_MS, Math.min(SETUP_BUDGET_CAP_MS, Math.floor(remainingMs / 3)));
	const setup = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<ReadyInfo>();
	let setupDone = false;
	// Reject only the active phase's promise: the other one may never be
	// awaited (a phase that already failed leaves the rest un-run), so
	// rejecting it would be an unhandled rejection.
	const failStartup = (error: Error) => {
		(setupDone ? ready : setup).reject(error);
	};
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "page-created") {
			// Record the headless target before the (potentially slow)
			// post-creation CDP work: if this init is killed before ready,
			// the supervisor closes exactly this target.
			workerPageTargets.set(worker, msg.targetId);
		} else if (msg.type === "setup") {
			setupDone = true;
			setup.resolve();
		} else if (msg.type === "ready") ready.resolve(msg.info);
		else if (msg.type === "init-failed") failStartup(markReportedInitFailure(errorFromPayload(msg.error)));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		failStartup(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		if (!worker.send({ type: "init", payload })) {
			throw new ToolError("Tab worker exited before initialization");
		}
		await raceWithTimeout(setup.promise, setupBudgetMs, "Timed out waiting for tab worker setup");
		// The ready wait gets only what is left of the caller's budget at
		// this point; the floor covers sub-3s budgets where the 2s setup
		// floor alone exceeds it.
		const readyBudgetMs = Math.max(READY_BUDGET_FLOOR_MS, timeoutMs - Math.round(performance.now() - deadlineStart));
		return await raceWithTimeout(ready.promise, readyBudgetMs, "Timed out initializing browser tab worker");
	} finally {
		unlisten();
		unlistenError();
	}
}
/**
 * True once the caller's init budget (elapsed since `deadlineStart`) is fully
 * consumed. A retry from this point can't be published — the caller's timeout
 * has already fired, so the post-init abort check would discard the result
 * anyway — so callers fail fast instead of spending the phase floors' excess
 * on a cold start nobody is waiting for.
 */
function initBudgetExhausted(budgetMs: number, deadlineStart: number): boolean {
	return budgetMs - Math.round(performance.now() - deadlineStart) <= 0;
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs, deadlineStart);
}
