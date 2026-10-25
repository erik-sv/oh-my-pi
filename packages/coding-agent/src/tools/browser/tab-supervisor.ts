import {
	getProjectDir,
	getPuppeteerDir,
	logger,
	postmortem,
	Snowflake,
	untilAborted,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import type { CDPSession, Page, Target } from "puppeteer-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { webpExclusionForModel } from "@oh-my-pi/pi-tui/chat/image-loading";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { CELL_BUDGET_SLACK_MS } from "../run-scope";
import { ToolAbortError, toWorkerErrorPayload } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { gracefulKillTreeOnce, pickElectronTarget } from "./attach";
import { CmuxTab } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { runInProcessTab } from "./in-process-run";
import { browserConnection, DEFAULT_VIEWPORT } from "./launch";
import {
	closeCdpTarget,
	closeRelayTarget,
	forgetSharedTarget,
	forgetSharedTargets,
	recordSharedTarget,
	type SharedTargetScope,
} from "./orphan-registry";
import { stopSharedBrowserIfUnreachable } from "./shared-daemon";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CmuxBrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
	type TernBrowserHandle,
} from "./registry";
import {
	type AttachPage,
	ownsPage,
	type ReadyInfo,
	type RunErrorPayload,
	type RunResultOk,
	type SessionSnapshot,
	type WorkerInbound,
	type WorkerInitPayload,
	type WorkerOutbound,
} from "./tab-protocol";

import { cfgBrowserScreenshotDir } from "./settings";
import * as tabWorkerHost from "./tab-worker-host";
import { TabWorkerExitError, type WorkerHandle } from "./tab-worker-host";
import { listTernBlocks, noTernBlockError, pickTernBlock } from "./tern/blocks";
import { TernTab } from "./tern/tern-tab";
import { newUploadStagingDir, removeUploadStaging, sweepUploadStaging } from "./upload-files";

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
	 * cancellation into the still-running `runInProcessTab` body (issue #4499).
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
	/** Hostname patterns enforced by the worker across navigations and subresources. */
	allowedDomains?: string[];
	kindTag: BrowserKindTag;
	/**
	 * Session id of the caller that CREATED the tab. Preserved across reuse so
	 * that dispose of the creating session can reap browser resources without
	 * yanking the tab out from under a subagent that only reused it.
	 * Undefined when the acquirer did not identify itself.
	 */
	ownerSessionId?: string;
	/**
	 * Opt out of settle-freeze and idle-close reaping. Recorded on the tab
	 * when created (never on reuse), mirroring `ownerSessionId`: keeping a
	 * tab live across turns is the creator's explicit decision.
	 */
	persist?: boolean;
	/** Wall-clock (`Date.now()`) last use: create, reuse, or run start. Drives idle-close. */
	lastActivityAt: number;
	/**
	 * True after a successful settle-freeze (`Page.setWebLifecycleState`
	 * frozen). Cleared on unfreeze/create. Freeze pauses rAF/timers so an
	 * idle animated page stops burning CPU/GPU; the renderer, worker, and
	 * DOM state stay alive for millisecond resume.
	 */
	frozen: boolean;
}

export interface WorkerTabSession extends TabSessionBase<PuppeteerBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
	/** omp created this page (headless, or a relay open without a target): closing the tab closes it. */
	ownsPage: boolean;
	/**
	 * The tab's upload staging folder. It outlives the tab's workers, since Chrome reads a picked file only when the page
	 * does, and goes with the page when omp closes it; a page left open in the user's browser keeps it until the sweep.
	 */
	uploadDir: string;
	/** In flight while a worker that exited on its own is replaced; runs wait for it before driving the tab. */
	workerRecovery?: Promise<boolean>;
	/** `Date.now()` of the last unexpected worker exit; a second one soon after closes the tab instead. */
	workerExitedAt?: number;
	/** Set when a worker exited with no run in flight and the tab was reattached; the next call reports it. */
	workerExitNotice?: string;
	/**
	 * The generation a recycle is starting, until it is adopted or discarded. A release or kill
	 * that lands meanwhile stops it at once instead of leaving it to its init deadline.
	 */
	replacement?: { worker: WorkerHandle; stop: AbortController };
}

export interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

/** A tab shown as a Tern browser picture-in-picture over omp's pane, or the user's browser block it adopted. */
export interface TernTabSession extends TabSessionBase<TernBrowserHandle> {
	backend: "tern";
	/** The PiP's driver. */
	ternTab: TernTab;
}

export type TabSession = WorkerTabSession | CmuxTabSession | TernTabSession;

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
	/** Hostname patterns allowed for every tab request. */
	allowedDomains?: string[];
	/** Document-start JavaScript sources registered before initial navigation. */
	initScripts?: string[];
	/** Absolute directory used for downloads. */
	downloadsPath?: string;
	/** Explicit tab user agent override. */
	userAgent?: string;
	/** Ignore invalid HTTPS certificates for this page. */
	ignoreHttpsErrors?: boolean;
	cmuxSurface?: string;
	/**
	 * Session id of the acquirer. Recorded on the tab when created (never on
	 * reuse) so `releaseTabsForOwner` can walk the shared tabs map on session
	 * dispose. Optional — omitting it opts the tab out of session-scoped reap.
	 */
	ownerSessionId?: string;
	/**
	 * Keep the tab live across turn settle and idle close. Recorded on the
	 * tab when created (never on reuse) so a later caller cannot silently
	 * extend another session's tab lifetime.
	 */
	persist?: boolean;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
	/** What the open recovered from before reusing the tab, for its result. */
	note?: string;
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
// Generations a recycle is replacing or a loss already handed to recovery. A
// late failure of one (an undeliverable tool reply, a second error event) is
// that recovery's to finish, never a new loss that would start another.
const retiredWorkers = new WeakSet<WorkerHandle>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
// Staging folders of closed tabs are swept at most this often (see `sweepUploadStaging`).
const UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastUploadSweep = 0;
// Cold-start guard for the worker's `setup` handshake (realm usable: puppeteer
// loaded, browser connected, page acquired). A cold subprocess import must not
// consume the caller's entire timeout before reporting startup failure.
// Budget: min(10s, remaining/3), floor 2s, where remaining is what the caller's
// budget has left at attempt start.
const SETUP_BUDGET_FLOOR_MS = 2_000;
const SETUP_BUDGET_CAP_MS = 10_000;
// Floor for the ready-phase budget: the 2s setup floor can consume more than
// a sub-3s caller's entire init budget, so the remaining-budget math must
// never hand raceWithTimeout a non-positive value.
const READY_BUDGET_FLOOR_MS = 500;
// Share of an open's remaining budget kept back from its navigation so the
// goto's own timeout report reaches the caller before the open's deadline.
const OPEN_NAVIGATION_REPORT_MS = 500;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();
const DEFAULT_TAB_CLOSE_TIMEOUT_MS = 5_000;
// What every worker replacement resets, for results that report one.
const WORKER_RESETS =
	"Tab state set since it was opened was reset (tab.route routes, emulation and user agent, init scripts, element ids, the request log, HAR recording, run globals)";
// What a worker recycle (`recycleTimedOutWorkerTab`) resets, for results that report one.
const RECYCLE_RESETS = `${WORKER_RESETS}, any open dialog was dismissed, and any page still loading was stopped.`;
const RENDERER_RELOADED_NOTE = `This tab's renderer had crashed, so the tab was reattached to a new worker and its page reloaded. ${RECYCLE_RESETS}`;
const DEBUGGER_DETACH_CAUSE =
	"Chrome does this when another extension's frame loads in the tab, such as a password manager's inline autofill menu";
const DEBUGGER_DETACH_REFUSAL =
	"Chrome refuses the attach while another extension's frame, such as a password manager's inline autofill menu, is open in it";
/** Chrome's `chrome.debugger.onDetach` reason when the user pressed Cancel on its debugging bar. */
const USER_CANCELLED_DEBUGGER = "canceled_by_user";
// Init budget for the worker that replaces one lost on its own; adopting a live page takes well under a second.
const WORKER_EXIT_REATTACH_TIMEOUT_MS = 10_000;
// A replacement worker lost on its own this soon after the previous loss closes the tab instead of looping.
const WORKER_EXIT_RETRY_WINDOW_MS = 10_000;
class RecoverableWorkerError extends ToolError {}
/** A worker `tab.goto` outlasted its budget; the page stays on what loaded. */
class NavigationTimeoutError extends ToolError {}
/** The page's renderer crashed; the run that reports it recycles the worker. */
class RendererCrashedError extends ToolError {}
/** Chrome ended the debugger attachment of a relay tab; the worker runs nothing more and the tab is re-adopted. */
class DebuggerDetachedError extends ToolError {
	constructor(
		message: string,
		/** `during`: the run's code had started, so its input may already have landed. */
		readonly when: "during" | "before",
		/** Chrome's reason for the detach (`target_closed`, `canceled_by_user`). */
		readonly reason: string,
	) {
		super(message);
	}
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

/** JSON-safe metadata for one managed browser tab. */
export interface ManagedTabInfo {
	/** Managed tab name. */
	name: string;
	/** Last reported page URL. */
	url: string;
	/** Last reported page title. */
	title: string;
	/** Browser target or cmux surface identifier. */
	targetId: string;
	/** Browser backend kind. */
	kind: BrowserKindTag;
	/** Whether settle and idle-close management are disabled. */
	persist: boolean;
}

/** List the currently alive tabs in the managed-tab registry. */
export function listTabs(): ManagedTabInfo[] {
	return [...tabs.values()]
		.filter(tab => tab.state === "alive")
		.map(tab => ({
			name: tab.name,
			url: tab.info.url,
			title: tab.info.title ?? "",
			targetId: tab.targetId,
			kind: tab.kindTag,
			persist: tab.persist ?? false,
		}));
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
			// A worker that exited with no run in flight left the reset unreported; reusing its tab reports it.
			if (!value.created && value.tab.backend === "worker" && value.tab.workerExitNotice) {
				const notice = value.tab.workerExitNotice;
				value.tab.workerExitNotice = undefined;
				return { ...value, note: value.note ? `${notice}\n${value.note}` : notice };
			}
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
	// Worker-init deadline. Callers whose own deadline started earlier pass it
	// through so prior acquisition time counts against this initialization
	// instead of restarting the budget.
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
	// A tab whose worker exited is being reattached: the open reuses the tab the reattach leaves, or opens a fresh
	// one if the reattach closed it, instead of reporting a tab whose worker is gone.
	const reattaching = awaitWorkerRecovery(name, opts, "Browser tab open aborted");
	if (reattaching) await reattaching;
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
			} else if (
				(opts.allowedDomains !== undefined && !sameAllowedDomains(opts.allowedDomains, existing.allowedDomains)) ||
				(existing.backend === "tern" && opts.target !== undefined && !(await adoptsSameBlock(existing, opts)))
			) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				// Reuse counts as use: refresh the idle clock and resume a
				// settle-frozen page before driving it again. A refused
				// resume fails the open here with the same actionable
				// error a run would raise, instead of reporting a reuse
				// that can never execute.
				existing.lastActivityAt = Date.now();
				// Resume BEFORE applying `persist` below: flipping the flag
				// first would make `isSettleManaged` reject this very
				// resume, so reopening a frozen tab with `persist: true`
				// would always fail.
				if (!(await unfreezeTabSession(existing))) {
					throw new ToolError(
						`Tab ${JSON.stringify(name)} is frozen and could not be resumed. Close and reopen it.`,
					);
				}
				// The worker may have exited while the resume awaited Chrome: once its reattach settles, start over, so
				// the open reuses the reattached tab or opens a fresh one, as an open arriving during a reattach does.
				const reattachingMeanwhile = awaitWorkerRecovery(name, opts, "Browser tab open aborted");
				if (reattachingMeanwhile) await reattachingMeanwhile;
				if (tabs.get(name) !== existing || existing.state !== "alive") {
					return await acquireTabImpl(name, browser, { ...opts, deadlineStartMs: startedAt });
				}
				// The creator may opt out later: an explicit `persist` on
				// reuse by the owning session updates the tab (omitted
				// leaves it). Reuse by any other session never changes it.
				// Applied after the resume above for the reason stated there.
				if (opts.persist !== undefined && existing.ownerSessionId === opts.ownerSessionId) {
					existing.persist = opts.persist;
				}
				const reuseSteps: string[] = [];
				if (opts.viewport && browser.kind.kind !== "cmux" && browser.kind.kind !== "tern") {
					const dsf = opts.viewport.deviceScaleFactor;
					reuseSteps.push(
						`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
					);
				}
				if (opts.viewport && existing.backend === "tern") {
					reuseSteps.push(
						`await tab.emulate({ viewport: ${JSON.stringify({ width: opts.viewport.width, height: opts.viewport.height, scale: opts.viewport.deviceScaleFactor })} });`,
					);
				}
				const reuse = async (): Promise<void> => {
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
					if (opts.url) await navigateOpenedTab(name, opts.url, opts, startedAt);
				};
				let note: string | undefined;
				try {
					await reuse();
				} catch (error) {
					// The tab's renderer had crashed: the failed step reloaded the page on a new worker, so the
					// open goes on with it once. A tab closed by the crash, or a second crash, fails the open.
					if (
						!(error instanceof RendererCrashedError && tabs.get(name) === existing && existing.state === "alive")
					)
						throw error;
					note = RENDERER_RELOADED_NOTE;
					await reuse();
				}
				// The user may have navigated or switched tabs since: the result reports where the page is now.
				if (existing.backend === "tern") existing.info = await existing.ternTab.readyInfo();
				return { tab: tabs.get(name)!, created: false, note };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser || "tern" in browser) {
		try {
			const result =
				"client" in browser ? await acquireCmuxTab(name, browser, opts) : await acquireTernTab(name, browser, opts);
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
		// The subprocess is the native-crash isolation boundary. Never fall back
		// to an in-process worker after startup failure: one native fault there
		// would terminate the parent agent.
		await worker.terminate().catch(() => undefined);
		closeAbandonedWorkerPage(browser, worker);
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
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
		allowedDomains: opts.allowedDomains ? [...opts.allowedDomains] : undefined,
		kindTag: browser.kind.kind,
		ownsPage: ownsPage(initPayload),
		ownerSessionId: opts.ownerSessionId,
		persist: opts.persist ?? false,
		lastActivityAt: Date.now(),
		frozen: false,
		uploadDir: initPayload.uploadDir,
	};
	attachWorker(tab, worker);
	tabs.set(name, tab);
	sweepClosedTabUploads();
	// Durably record ownership so another live omp process can reap this page if
	// this process dies abnormally before its own teardown closes the tab.
	const scope = sharedScopeOf(browser);
	if (scope) void recordSharedTarget(scope, info.targetId);
	if (opts.url) await navigateOpenedTab(name, opts.url, opts, startedAt, tab);
	return { tab, created: true };
}

/**
 * Navigate a tab for an open, within what is left of the open's budget. A
 * page that outlasts it fails with goto's own report while the tab stays on
 * what loaded, instead of losing to the open's bare deadline. A tab this open
 * created (`created`) is kept only for that timeout: a navigation that fails
 * outright, or an open cancelled or past its deadline, closes it again so the
 * failed open leaves nothing behind.
 */
async function navigateOpenedTab(
	name: string,
	url: string,
	opts: AcquireTabOptions,
	startedAt: number,
	created?: WorkerTabSession,
): Promise<void> {
	const remainingMs = opts.timeoutMs - (performance.now() - startedAt);
	const gotoMs = Math.max(1, Math.round(remainingMs - Math.min(OPEN_NAVIGATION_REPORT_MS, remainingMs / 2)));
	try {
		await runInTabWithSnapshot(
			name,
			{
				code: `await tab.goto(${JSON.stringify(url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
				// tab.goto bounds itself to the cell budget less CELL_BUDGET_SLACK_MS.
				timeoutMs: gotoMs + CELL_BUDGET_SLACK_MS,
				signal: opts.signal,
			},
			{ cwd: getProjectDir() },
		);
	} catch (error) {
		if (created && (opts.signal?.aborted || !(error instanceof NavigationTimeoutError))) {
			await rollBackCreatedTab(name, created);
			throw error;
		}
		if (
			error instanceof ToolAbortError ||
			error instanceof RendererCrashedError ||
			!(error instanceof Error) ||
			tabs.get(name)?.state !== "alive"
		)
			throw error;
		throw new ToolError(
			`${error.message}\nTab ${JSON.stringify(name)} stays open on what loaded; reach it with browser.tab(${JSON.stringify(name)}).`,
		);
	}
	// An abort that lands as the navigation completes still cancels the open.
	if (created && opts.signal?.aborted) {
		await rollBackCreatedTab(name, created);
		throw new ToolAbortError("Browser tab open aborted");
	}
}

/** Close a tab its failed open created, unless something already replaced or closed it. */
async function rollBackCreatedTab(name: string, tab: WorkerTabSession): Promise<void> {
	if (tabs.get(name) !== tab) return;
	try {
		await releaseTab(name, { kill: false });
	} catch (error) {
		logger.warn("Failed to close the tab of a failed browser open", {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	if (opts.allowedDomains?.length) {
		throw new ToolError("browser.open allowed_domains is not supported on the cmux backend");
	}
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
			persist: opts.persist ?? false,
			lastActivityAt: Date.now(),
			frozen: false,
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

/**
 * Browser blocks the live Tern tabs of this process (other than `except`)
 * drive, by block id to tab name: never adopted twice.
 */
export function ternBlocksTaken(except?: string): Map<number, string> {
	const taken = new Map<number, string>();
	for (const [name, tab] of tabs) {
		if (name !== except && tab.backend === "tern" && tab.state === "alive") taken.set(tab.ternTab.block, name);
	}
	return taken;
}

/** Whether reopening Tern tab `existing` with `opts.target` names the block it already adopted. */
async function adoptsSameBlock(existing: TernTabSession, opts: AcquireTabOptions): Promise<boolean> {
	if (!existing.ternTab.adopted || opts.target === undefined) return false;
	const blocks = await listTernBlocks(existing.browser.tern, { timeoutMs: opts.timeoutMs, signal: opts.signal });
	return pickTernBlock(blocks, opts.target, ternBlocksTaken(existing.name))?.block === existing.ternTab.block;
}

/**
 * Open a Tern browser PiP over omp's pane and configure it before its first
 * real navigation (the PiP closes again when anything after `open` fails), or
 * with `opts.target` adopt the user's browser block it names (released again,
 * never closed, on failure and on close).
 */
async function acquireTernTab(
	name: string,
	browser: TernBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const settings = {
		name,
		url: opts.url,
		waitUntil: opts.waitUntil,
		timeoutMs: opts.timeoutMs,
		signal: opts.signal,
		dialogs: opts.dialogs,
		allowedDomains: opts.allowedDomains,
		initScripts: opts.initScripts,
		downloadsPath: opts.downloadsPath,
		userAgent: opts.userAgent,
		ignoreHttpsErrors: opts.ignoreHttpsErrors,
	};
	let ternTab: TernTab;
	if (opts.target === undefined) {
		ternTab = await TernTab.open(browser.tern, {
			...settings,
			pane: browser.kind.pane,
			viewport: opts.viewport ?? DEFAULT_VIEWPORT,
		});
	} else {
		const blocks = await listTernBlocks(browser.tern, { timeoutMs: opts.timeoutMs, signal: opts.signal });
		const taken = ternBlocksTaken(name);
		const block = pickTernBlock(blocks, opts.target, taken);
		if (!block) throw noTernBlockError(blocks, opts.target, taken);
		ternTab = await TernTab.adopt(browser.tern, { ...settings, block, viewport: opts.viewport });
	}
	try {
		const info = await ternTab.readyInfo();
		if (opts.signal?.aborted) throw new ToolAbortError("Browser tab open aborted");
		holdBrowser(browser);
		const tab: TernTabSession = {
			name,
			browser,
			targetId: String(ternTab.block),
			backend: "tern",
			ternTab,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			allowedDomains: opts.allowedDomains ? [...opts.allowedDomains] : undefined,
			kindTag: browser.kind.kind,
			ownerSessionId: opts.ownerSessionId,
			persist: opts.persist ?? false,
			lastActivityAt: Date.now(),
			frozen: false,
		};
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		await ternTab.close({ timeoutMs: DEFAULT_TAB_CLOSE_TIMEOUT_MS }).catch(() => undefined);
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	const result = await runInTabWithSnapshot(
		name,
		{ code: opts.code, timeoutMs: opts.timeoutMs, signal: opts.signal, session: opts.session },
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
	// A worker that exited with no run in flight left the reset unreported; this call reports it. Runs an open
	// makes on the tab leave it for the open to report.
	const tab = tabs.get(name);
	if (tab?.backend === "worker" && tab.workerExitNotice) {
		result.displays.unshift({ type: "text", text: tab.workerExitNotice });
		tab.workerExitNotice = undefined;
	}
	return result;
}

async function runInTabWithSnapshot(
	name: string,
	opts: {
		code: string;
		timeoutMs: number;
		signal?: AbortSignal;
		session?: ToolSession;
		/** This run follows a re-adoption that a detach before the previous attempt caused; it is not retried again. */
		readopted?: boolean;
	},
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	// A worker that exited on its own is being replaced: wait for that within this call's budget, and run only on the
	// same tab. A tab closed and reopened under this name meanwhile is not the one this call was meant for.
	const waitStartedAt = performance.now();
	const reattaching = awaitWorkerRecovery(name, opts);
	if (reattaching) {
		const recovered = await reattaching;
		const current = tabs.get(name);
		if (current && current !== recovered) {
			throw new ToolError(`Tab ${JSON.stringify(name)} was closed while its worker was being reattached.`);
		}
		const remainingMs = opts.timeoutMs - Math.round(performance.now() - waitStartedAt);
		// Too little is left for any step to finish: running it anyway would only time out, and that recycle would
		// stop loading and dismiss dialogs on the page this reattach kept as it was.
		if (current?.state === "alive" && remainingMs < Math.min(CELL_BUDGET_SLACK_MS, opts.timeoutMs / 2)) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)}'s worker was reattached to the same page, but that used up this call's ${opts.timeoutMs}ms budget, so the call was not run; repeat it.`,
			);
		}
		opts = { ...opts, timeoutMs: remainingMs };
	}
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.pending.size > 0) {
		throw new ToolError(
			`Tab ${JSON.stringify(name)} is busy: another call on this tab is still running. Await each call before starting the next instead of running them together (Promise.all, asyncio.gather), or group the steps in one tab.run(...)`,
		);
	}
	// An already-aborted call never runs: without this early exit the worker
	// branch below would send `abort` before `run`, which the worker ignores
	// for a not-yet-active run and then execute anyway.
	if (opts.signal?.aborted) throw new ToolAbortError();
	// A run is use: refresh the idle clock for idle-close.
	tab.lastActivityAt = Date.now();
	// A retry after a detach gets only what is left of this call's budget, not a fresh one.
	const startedAt = performance.now();
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
	// The in-process (cmux, Tern) branch also composes `closeAc.signal` into
	// the run's abort signal so `wait(...)`, backend socket calls, and the
	// facade proxies unwind promptly when the tab is closed — otherwise a
	// `wait(60_000)` with no in-flight socket request would keep
	// `runInProcessTab` blocked until timeout even after the tab is gone.
	const closeAc = new AbortController();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
		closeAc,
	};
	// Register BEFORE the unfreeze await below. Settle-freeze guards on
	// `pending` (and undoes a transition already in flight when it observes
	// one at completion), so a turn-end freeze can neither start nor land
	// mid-run. Without this ordering a parent's settle could freeze a tab a
	// subagent is reusing between our unfreeze check and this registration,
	// stalling timer/rAF-dependent code to timeout.
	tab.pending.set(id, pending);
	// Observe the run promise from registration on: every exit below this
	// point (resume failure, teardown race) throws before the backends
	// attach their consumers, and an unobserved `pending.reject` would fire
	// `unhandledRejection` and tear the whole session down (issue #4499).
	promise.catch(() => undefined);
	const dispatchWorker = tab.backend === "worker" ? tab.worker : undefined;
	// Resume a settle-frozen page before driving it — frozen rAF/timers would
	// otherwise hang the execution below. A refused resume fails the run
	// here with an actionable error instead of stalling to timeout.
	if (!(await unfreezeTabSession(tab))) {
		tab.pending.delete(id);
		throw new ToolError(`Tab ${JSON.stringify(name)} is frozen and could not be resumed. Close and reopen it.`);
	}
	// An abort that landed during the resume roundtrip must not dispatch:
	// the worker ignores `abort` for a run that was never started.
	if (opts.signal?.aborted) {
		tab.pending.delete(id);
		throw new ToolAbortError();
	}
	const current = tabs.get(name);
	if (current !== tab || current.state === "dead") {
		// A teardown won the race with our unfreeze roundtrip. Prefer its
		// close error when one was recorded (`releaseTab` rejects `pending`
		// synchronously, so it is already settled here); otherwise surface
		// the closure. `race` — not a bare `await promise` — so a teardown
		// that never settled the run cannot hang us.
		tab.pending.delete(id);
		const notAlive = new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`);
		return await Promise.race([promise, Promise.reject(notAlive)]);
	}
	// A worker that exited during the resume already failed this run (its exit handler rejected it) and is being
	// replaced; dispatching now would run the code on the replacement after the caller was told it failed.
	if (tab.backend === "worker" && (tab.worker !== dispatchWorker || tab.workerRecovery)) {
		tab.pending.delete(id);
		const replaced = new ToolError(
			`Tab ${JSON.stringify(name)}'s worker was replaced while the tab was being resumed; retry the call.`,
		);
		return await Promise.race([promise, Promise.reject(replaced)]);
	}
	if (tab.backend === "cmux" || tab.backend === "tern") {
		const runSignal = opts.signal ? AbortSignal.any([opts.signal, closeAc.signal]) : closeAc.signal;
		try {
			// `runInProcessTab.then(resolve, reject)` publishes the run's real
			// outcome to `promise`, but `releaseTab` may have already
			// rejected it — `Promise.withResolvers` settles on the first
			// call and later resolve/reject are no-ops, so the tab-close
			// error still wins the race.
			runInProcessTab(tab.backend === "cmux" ? tab.cmuxTab : tab.ternTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
			}).then(resolve, reject);
			return await promise;
		} finally {
			tab.pending.delete(id);
			// Completion is use too: a run outlasting the idle timeout must
			// not look stale to the sweep right after it finishes.
			tab.lastActivityAt = Date.now();
			// Tern pages report url/title through the tab itself (no worker `ready`).
			if (tab.backend === "tern") {
				tab.info = { ...tab.info, url: tab.ternTab.url(), title: tab.ternTab.lastTitle };
			}
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
	// Stops this run's cancellation from reaching the generation. The pending
	// entry stays until `finally`: a recovery after the run's result still holds
	// the tab busy, so a sibling run cannot dispatch to the generation being
	// replaced.
	const detach = (): void => opts.signal?.removeEventListener("abort", abort);
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
			// The generation is gone before its exit reached us: recover it as an exit does.
			logBrowserFailure("send-dropped", tab, { runId: id, worker, reason: "run", session: opts.session });
			handleWorkerLoss(tab, worker, "Browser tab worker stopped accepting messages");
			throw new ToolError(
				`Tab ${JSON.stringify(name)}'s worker exited before this call reached it; omp reattaches the tab to a new worker, so retry the call.`,
			);
		}
		const result = await raceWithTimeout(
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
		if (result.recoverTab) {
			// The run finished but left tab-scoped state (request interception)
			// it could not reset. Same ordering as the failure path below:
			// detach before the recycle terminates this generation.
			detach();
			logBrowserFailure("recover-tab", tab, { runId: id, worker, session: opts.session });
			const reattached = await recoverWorkerTab(tab, worker, opts.timeoutMs, {
				runId: id,
				session: opts.session,
			});
			result.displays.push({
				type: "text",
				text: reattached
					? `Browser request interception could not be reset after this run; the tab was reattached to a new worker. ${RECYCLE_RESETS}`
					: "Browser request interception could not be reset after this run; the tab was closed.",
			});
		}
		return result;
	} catch (error) {
		// Detach BEFORE recovery: recycling terminates this generation and the
		// awaits below are exactly the window the incident's abort landed in.
		detach();
		if (error instanceof RendererCrashedError) {
			logBrowserFailure("renderer-crashed", tab, { runId: id, worker, error, session: opts.session });
			const reattached = await recoverWorkerTab(tab, worker, opts.timeoutMs, {
				runId: id,
				session: opts.session,
			});
			throw new RendererCrashedError(
				reattached
					? `${error.message}. The tab was reattached to a new worker and its page reloaded. ${RECYCLE_RESETS}`
					: `${error.message}; the tab could not be reattached and was closed.`,
			);
		}
		if (error instanceof DebuggerDetachedError) {
			logBrowserFailure("debugger-detached", tab, {
				runId: id,
				worker,
				error,
				reason: error.reason,
				session: opts.session,
			});
			const landed =
				error.when === "during" ? "; input this call sent before the detach may already have landed" : "";
			// Host tool calls the detached run started would otherwise keep running, and reply to the new worker.
			for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
			if (error.reason === USER_CANCELLED_DEBUGGER) {
				// The relay hides a tab whose debugging bar the user cancelled, so a re-adoption cannot succeed.
				const cancelled = `${error.message}. The user cancelled Chrome's debugging bar${landed}. omp released the tab; the relay hides it until its URL changes, so navigate it in Chrome, then open it again`;
				// `forceKillTab` claims the tab only while it is still registered and alive.
				await forceKillTab(tab, cancelled);
				if (opts.signal?.aborted) throw new ToolAbortError();
				throw new ToolError(cancelled);
			}
			// Re-adopt the same Chrome tab on a new subprocess generation. No `recover` pass: the page is healthy,
			// and stopping its loading would cancel a navigation the call itself started. Chrome reports the same
			// reason when the tab itself closes, so only a re-adoption that worked names another extension's frame
			// as the cause.
			const detached = `${error.message}. ${DEBUGGER_DETACH_CAUSE}${landed}`;
			const lost = `${error.message}${landed}. omp could not reattach to the tab, so it was released: either the tab was closed, or ${DEBUGGER_DETACH_REFUSAL}. If the tab is still open, open it again once that frame is gone; if Chrome refused the attach, the relay hides the tab until its URL changes, so navigate it in Chrome first`;
			const reattached = await recoverWorkerTab(tab, worker, opts.timeoutMs, {
				runId: id,
				session: opts.session,
				recover: false,
				failedReason: lost,
			});
			// A cancel that landed while the tab was re-adopted wins over the detach report and the retry.
			if (opts.signal?.aborted) throw new ToolAbortError();
			if (!reattached) throw new ToolError(lost);
			if (error.when === "during" || opts.readopted) {
				throw new ToolError(
					`${detached}. omp reattached to the same tab on a new worker without reloading it, so the next call works; check the page before repeating this one. ${WORKER_RESETS}.`,
				);
			}
			// Nothing ran: run the call on the new worker, within what the re-adoption left of its budget.
			const remainingMs = Math.floor(opts.timeoutMs - (performance.now() - startedAt));
			if (remainingMs <= 0) {
				throw new ToolError(
					`${detached}. omp reattached to the same tab on a new worker without reloading it, but that used up this call's ${opts.timeoutMs}ms budget, so the call was not run again; repeat it. ${WORKER_RESETS}.`,
				);
			}
			// Its pending entry must go first, or the tab reads as busy.
			if (tab.pending.get(id) === pending) tab.pending.delete(id);
			const retried = await runInTabWithSnapshot(
				name,
				{ ...opts, timeoutMs: remainingMs, readopted: true },
				snapshot,
			);
			retried.displays.unshift({
				type: "text",
				text: `Chrome had detached omp from this tab since the last call (${DEBUGGER_DETACH_CAUSE}); omp reattached to the same tab on a new worker, without reloading it, and then ran this call. ${WORKER_RESETS}.`,
			});
			return retried;
		}
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
			await recoverWorkerTab(tab, worker, opts.timeoutMs, { runId: id, session: opts.session });
		}
		throw error;
	} finally {
		detach();
		if (tab.pending.get(id) === pending) tab.pending.delete(id);
		// Completion is use too: a run outlasting the idle timeout must
		// not look stale to the sweep right after it finishes.
		tab.lastActivityAt = Date.now();
	}
}

/**
 * Replace generation `previous`, whose tab state is unknown (timed out, crashed
 * renderer, unreset interception, detached debugger, lost process), with a
 * fresh subprocess attached to the same page. Every generation is an isolated
 * subprocess, so there is no inline-worker case that would have to kill the tab
 * instead. Resolves `true` when the tab was reattached to a new worker, `false`
 * when it was killed, or was closed, reopened, or already recycled meanwhile.
 */
async function recoverWorkerTab(
	tab: WorkerTabSession,
	previous: WorkerHandle,
	timeoutMs: number,
	opts: {
		/** The run driving the recycle; it keeps its pending entry until its own `finally`. */
		runId?: string;
		session?: ToolSession;
		/** Unblock the page (dismiss a dialog, stop loading) before adopting it; default true. */
		recover?: boolean;
		/** Kill reason when the recycle fails; defaults to a generic recovery failure. */
		failedReason?: string;
	} = {},
): Promise<boolean> {
	// A tab closed or reopened meanwhile is not ours to revive, and a newer
	// generation already replaced the one this run saw.
	if (tabs.get(tab.name) !== tab || tab.state !== "alive" || tab.worker !== previous) return false;
	try {
		return await recycleTimedOutWorkerTab(tab, previous, timeoutMs + GRACE_MS, {
			recoveringRunId: opts.runId,
			recover: opts.recover,
		});
	} catch (recycleError) {
		logBrowserFailure("recycle-failed", tab, {
			runId: opts.runId,
			worker: previous,
			error: recycleError,
			session: opts.session,
		});
		// `forceKillTab` claims the tab only while it is still registered and
		// alive, so a tab reopened under this name meanwhile is left alone.
		await forceKillTab(tab, opts.failedReason ?? "Browser tab worker recovery failed; tab killed");
		return false;
	}
}

/**
 * In-flight releases by tab object. A second `releaseTab` for a tab already
 * being torn down joins the first instead of redoubling teardown: without
 * this, a same-name acquire racing a sweep's release would publish a
 * replacement that the first release's unconditional delete then removes
 * (and the shared browser hold would release twice). Joiners share the
 * first release's outcome.
 */
const releaseInflight = new WeakMap<TabSession, { promise: Promise<boolean>; opts: ReleaseTabOptions }>();

/**
 * Force-kills in flight by name. `forceKillTab` frees the registry name up
 * front so a reopen is never blocked, so a release naming the tab finds its
 * teardown here and joins it (through `releaseInflight`) instead of reporting
 * an unknown tab while the teardown still runs.
 */
const forceKillInflight = new Map<string, TabSession>();

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name) ?? forceKillInflight.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const ongoing = releaseInflight.get(tab);
	if (ongoing) {
		// Coalesce cleanup strength: a joining disposal must not lose its
		// kill request to an earlier non-killing close — `releaseBrowser`
		// reads `opts.kill` at teardown time, so the upgrade lands as long
		// as the first release has not finished. (Not directly testable
		// in-process: observing it needs a real spawned application.)
		ongoing.opts.kill = ongoing.opts.kill || opts.kill;
		const joined = await ongoing.promise;
		// The upgrade above lands too late when the first release already
		// passed `releaseBrowser`: verify a still-running spawned app is
		// terminated rather than trusting the joined outcome.
		if (opts.kill) await ensureSpawnedKilled(tab.browser);
		return joined;
	}
	const entry = { promise: releaseTabInner(tab, name, opts), opts };
	releaseInflight.set(tab, entry);
	try {
		return await entry.promise;
	} finally {
		releaseInflight.delete(tab);
	}
}

/**
 * Best-effort termination of a spawned app that outlived a joined teardown.
 * Fires only behind a live subprocess handle (kernel-tracked, so no
 * pid-reuse hazard): anything else already died or was never ours to kill.
 */
async function ensureSpawnedKilled(browser: BrowserHandle): Promise<void> {
	if (browser.kind.kind !== "spawned" || !("subprocess" in browser)) return;
	const { pid, subprocess } = browser;
	if (pid === undefined || !subprocess || subprocess.exitCode !== null) return;
	await gracefulKillTreeOnce(pid).catch(() => undefined);
}

/** Test hook for the kill guards without a live application. */
export function ensureSpawnedKilledForTest(browser: BrowserHandle): Promise<void> {
	return ensureSpawnedKilled(browser);
}

async function releaseTabInner(tab: TabSession, name: string, opts: ReleaseTabOptions): Promise<boolean> {
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	for (const [id, pending] of tab.pending) {
		// Cancel on the generation that owns the run; `send` reports delivery
		// instead of throwing, so an already-dead worker is simply skipped.
		if (tab.backend === "worker") (pending.worker ?? tab.worker).send({ type: "abort", id, expectedCleanup: true });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);
		// Propagate the closure into the in-process run's abort signal so
		// `wait(...)`, in-flight backend socket calls, and the facade proxies
		// unwind promptly. Firing this BEFORE `pending.reject` means
		// `runInProcessTab` finishes with `ToolAbortError` and its `.then(reject)`
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
	if (tab.backend === "tern") {
		let closeError: unknown;
		if (wasAlive) {
			try {
				await waitForTabCleanup(
					tab,
					timeoutMs,
					`Tern browser block ${tab.targetId} (close)`,
					tab.ternTab.close({ timeoutMs }),
				);
			} catch (err) {
				closeError = err;
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
			tabs.delete(name);
		}
		if (closeError) throw closeError;
		return true;
	}
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
	let targetCloseFailed = false;
	// A replacement still starting for this tab would otherwise run until its init deadline.
	await stopReplacement(tab);
	// The handshake is bounded by the worker handle; a generation that cannot
	// acknowledge closure is killed instead.
	const closed = wasAlive && (await tab.worker.close().catch(() => false));
	if (!closed) await tab.worker.terminate().catch(() => undefined);
	if (tab.ownsPage) {
		// omp closes the pages it owns, and with them goes the last reader of their staged uploads.
		await removeUploadStaging(tab.uploadDir);
		// Close the page by id as well, which confirms it is gone: a worker's own close can fail
		// and still report `closed` (its CDP socket broke), a generation that could not
		// acknowledge closure never closed it, a dead tab's subprocess exited without closing it,
		// and the relay retracts a target whose debugger the user dismissed, so the worker cannot
		// close it at all.
		try {
			// `false` is "not confirmed closed" (the CDP session could not be
			// created, or `Target.getTargets` failed) — the same unconfirmed
			// state the timeout reports as an error, so both mark the tab.
			targetCloseFailed = !(await waitForTabCleanup(
				tab,
				timeoutMs,
				`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
				closeOrphanTarget(tab, timeoutMs),
			));
		} catch (error) {
			targetCloseFailed = true;
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
		if (scope) {
			if (targetCloseFailed) {
				// The target outlived its close, so it is still open in the
				// shared Chromium. Keep its durable ownership record — the only
				// handle a later reap has on it — instead of forgetting a target
				// that was never closed, and re-check the browser itself: a
				// Chromium that stopped answering its CDP endpoint holds every
				// unclosable target and must be replaced, not left to grow until
				// the last omp client in the project exits.
				recheckSharedBrowser(scope);
			} else {
				void forgetSharedTarget(scope, tab.targetId);
			}
		} else if (targetCloseFailed) {
			// Nothing here can retry it; a relay closes a tab of an offline browser once that browser reconnects.
			logger.warn("Could not confirm a browser tab omp opened was closed; it may still be open", {
				name,
				targetId: tab.targetId,
			});
		}
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

/**
 * Tabs this settle machinery may ever touch: OMP-launched headless puppeteer
 * tabs (`kindTag === "headless"` covers hidden and visible shared-daemon
 * tabs) that are alive and not opted out with `persist`. Connected, relay,
 * and spawned tabs drive the user's own pages/apps, and cmux surfaces are a
 * different backend with no CDP lifecycle — all are never frozen or reaped
 * here. Ownership follows the `releaseTabsForOwner` contract: recorded on
 * creation, never transferred by reuse.
 */
function isSettleManaged(tab: TabSession): boolean {
	return tab.backend === "worker" && tab.kindTag === "headless" && tab.state === "alive" && !tab.persist;
}

/**
 * Tabs idle-close may reap: every settle-managed tab plus Tern tabs (live,
 * visible pages never frozen, but closed when abandoned like headless tabs;
 * an adopted user block is released, not closed), minus `persist` opt-outs.
 */
function isIdleManaged(tab: TabSession): boolean {
	return isSettleManaged(tab) || (tab.backend === "tern" && tab.state === "alive" && !tab.persist);
}

/**
 * Find the live puppeteer target backing a tab. Mirrors the tab worker's
 * attach scan: fast `_targetId` path first, CDP comparison across targets
 * otherwise. Returns undefined when the target is already gone.
 */
async function findTargetForTab(tab: WorkerTabSession): Promise<Target | undefined> {
	for (const target of tab.browser.browser.targets()) {
		if ((await targetIdForTarget(target).catch(() => "")) !== tab.targetId) continue;
		return target;
	}
	return undefined;
}

/**
 * Set a tab's web lifecycle state through a supervisor-owned CDP session —
 * no worker-protocol change needed; CDP allows multiple sessions per target.
 * `frozen` pauses rAF/timers (the SwiftShader burn in #8246); `active`
 * resumes. Best-effort in the safe direction: false when the tab is gone or
 * the protocol call fails, leaving `frozen` untouched so the next checkpoint
 * retries and close paths still apply.
 *
 * Race protocol (all flag reads/writes below run atomically between awaits):
 * runs register `pending` before driving the page, so a freeze that starts
 * after a run began stands down at the guard. A freeze already past the
 * guard when a run registers rechecks `pending` after its CDP roundtrip and
 * re-asserts `active` on the same session — a frozen frame already sent
 * cannot be unsent, so the undo guarantees the run never executes on a
 * frozen page. Unfreezing always proceeds: resuming is safe under any
 * pending state.
 */
async function setTabFrozen(tab: TabSession, frozen: boolean): Promise<boolean> {
	if (!isSettleManaged(tab) || tab.backend !== "worker") return false;
	if (tab.frozen === frozen) return false;
	if (frozen && tab.pending.size > 0) return false;
	const target = await findTargetForTab(tab).catch(() => undefined);
	if (!target) return false;
	const session = await target.createCDPSession().catch(() => null);
	if (!session) return false;
	try {
		await session.send("Page.enable").catch(() => undefined);
		await session.send("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" });
		if (tab.state !== "alive") return false;
		if (frozen) {
			if (tab.frozen) return false;
			if (tab.pending.size > 0 || tab.persist) {
				// A run registered, or the owner opted out with `persist`,
				// while our CDP roundtrip was in flight. Either way the
				// frozen frame may already have landed, so re-assert
				// `active` instead of recording frozen — a persist tab left
				// frozen could never resume (unfreeze is rejected by the
				// same persist eligibility gate).
				if (await sendLifecycleState(session, "active")) return false;
				// One retry for the in-flight run's sake: a brief frozen
				// blip is harmless (rAF just skips frames), but an
				// indefinite freeze stalls it to timeout.
				await Bun.sleep(100);
				if (await sendLifecycleState(session, "active")) return false;
				tab.frozen = true;
				return false;
			}
			tab.frozen = true;
			return true;
		}
		tab.frozen = false;
		return true;
	} catch (error) {
		logger.debug("Browser tab lifecycle transition failed; leaving tab lifecycle state unchanged", {
			name: tab.name,
			frozen,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	} finally {
		await session.detach().catch(() => undefined);
	}
}

/** Best-effort lifecycle write on an owned CDP session; false when the call fails. */
async function sendLifecycleState(session: CDPSession, state: "frozen" | "active"): Promise<boolean> {
	try {
		await session.send("Page.setWebLifecycleState", { state });
		return true;
	} catch {
		return false;
	}
}

/** Test hook for the lifecycle transition without a tabs-map entry. */
export function setTabFrozenForTest(tab: TabSession, frozen: boolean): Promise<boolean> {
	return setTabFrozen(tab, frozen);
}

/**
 * Resume a tab before driving it. Returns false only when the page target
 * exists but refuses the `active` transition even after one retry — the
 * page is most likely still paused, so the caller must not dispatch onto
 * it. A vanished target returns true: the run proceeds and surfaces the
 * real page error immediately instead of hanging to timeout.
 */
async function unfreezeTabSession(tab: TabSession): Promise<boolean> {
	if (!tab.frozen) return true;
	if (tab.backend === "worker") {
		const target = await findTargetForTab(tab).catch(() => undefined);
		// Page target gone: let the run proceed and surface the real page
		// error immediately instead of hanging to timeout.
		if (!target) return true;
		// A crashed renderer answers no lifecycle call. The run goes ahead: its worker refuses it as crashed, and
		// the recycle that follows brings the page back on a new renderer, which is not frozen.
		if (await rendererCrashed(target)) {
			tab.frozen = false;
			return true;
		}
	}
	if (await setTabFrozen(tab, false).catch(() => false)) return true;
	await Bun.sleep(100);
	return await setTabFrozen(tab, false).catch(() => false);
}

/** Whether the target's renderer is dead: Chromium answers `Inspector.enable` itself and reports a crash first. */
async function rendererCrashed(target: Target): Promise<boolean> {
	const session = await target.createCDPSession().catch(() => null);
	if (!session) return false;
	let crashed = false;
	session.once("Inspector.targetCrashed", () => {
		crashed = true;
	});
	try {
		await session.send("Inspector.enable");
		return crashed;
	} catch {
		return false;
	} finally {
		await session.detach().catch(() => undefined);
	}
}

/** Test hook for the pre-run resume without a tabs-map entry. */
export function unfreezeTabSessionForTest(tab: TabSession): Promise<boolean> {
	return unfreezeTabSession(tab);
}

/**
 * Freeze every managed tab owned by `ownerId` (issue #8246). Turn-settle
 * checkpoint: an idle animated page stops burning CPU/GPU while keeping its
 * renderer, worker, and DOM state for millisecond resume on next use. Tabs
 * with in-flight runs are skipped at the guard; a freeze already past the
 * guard when a run registers undoes itself at completion (see
 * `setTabFrozen`), so neither path can stall a run mid-execution.
 */
export async function freezeTabsForOwner(ownerId: string): Promise<number> {
	if (!ownerId) return 0;
	let count = 0;
	for (const tab of tabs.values()) {
		if (tab.ownerSessionId !== ownerId) continue;
		if (await setTabFrozen(tab, true).catch(() => false)) count++;
	}
	return count;
}
/**
 * Idle-close eligibility: owned, settle-managed, no in-flight run, and idle
 * past the deadline. An executing tab is not idle even when its run outlasts
 * the timeout. Exported so the never-touch contract is unit-testable;
 * `releaseIdleTabsForOwner` walks the map with exactly this predicate.
 */
export function isIdleCloseCandidate(tab: TabSession, ownerId: string, nowMs: number, idleMs: number): boolean {
	return (
		tab.ownerSessionId === ownerId &&
		isIdleManaged(tab) &&
		tab.pending.size === 0 &&
		nowMs - tab.lastActivityAt >= idleMs
	);
}
/**
 * Close managed tabs owned by `ownerId` idle longer than `idleMs` — the
 * memory backstop under settle-freeze (frozen tabs still hold their renderer
 * and worker). Never throws: a wedged tab counts as unclosed and the sweep
 * continues, returning the partial count — reapers must not fail callers.
 */
export async function releaseIdleTabsForOwner(
	ownerId: string,
	opts: { idleMs: number } & ReleaseTabOptions = { idleMs: 0 },
): Promise<number> {
	if (!ownerId) return 0;
	const now = Date.now();
	const names = [...tabs.values()]
		.filter(tab => isIdleCloseCandidate(tab, ownerId, now, opts.idleMs))
		.map(tab => tab.name);
	let count = 0;
	// Program-order token: a cancel landing after this increment suppresses
	// the re-arm below, so disabling mid-sweep cannot resurrect the deadline.
	const sweepSeq = ++idleCloseSeq;
	try {
		for (const name of names) {
			// Revalidate immediately before closing: an earlier close in this
			// loop awaits worker cleanup, during which a later candidate may
			// have been reused or started a run.
			const current = tabs.get(name);
			if (!current || !isIdleCloseCandidate(current, ownerId, Date.now(), opts.idleMs)) continue;
			try {
				if (await releaseTab(name, opts)) count++;
			} catch (error) {
				// One tab's wedged cleanup must not abandon the remaining
				// candidates; the tab is already removed from the map, so
				// the next sweep (or close path) retries it.
				logger.debug("Failed to close idle browser tab; continuing sweep", {
					name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	} finally {
		// Leave the next deadline armed even when a close threw — unless
		// cancelled mid-sweep. Sweeps only fire on turns, opens, and timer
		// callbacks, so without re-arming the survivors would never close.
		if ((idleCloseCancelSeq.get(ownerId) ?? 0) <= sweepSeq) {
			armIdleCloseForOwner(ownerId, opts.idleMs);
		}
	}
	return count;
}

/** Per-owner one-shot timers arming the idle-close backstop. Always unref'd. */
const idleCloseTimers = new Map<string, NodeJS.Timeout>();

/**
 * Monotonic clock ordering sweeps against cancels: each sweep entry and
 * each cancel takes the next value, so a sweep can tell whether a cancel
 * landed mid-flight.
 */
let idleCloseSeq = 0;
/** Last cancel sequence per owner; sweeps re-arm only when uncancelled. */
const idleCloseCancelSeq = new Map<string, number>();

/** Recheck cadence when a firing sweep skips due-but-busy tabs. Overridable in tests. */
const IDLE_DUE_RETRY_MS = 30_000;

/**
 * Milliseconds until the owner's next managed tab goes idle, `0` when one
 * already is, or undefined when no managed tab is tracked. The sweep
 * checkpoints (turn settle, open) handle the due case synchronously; the
 * timer covers abandonment with no further activity.
 */
export function earliestIdleCloseInMs(ownerId: string, idleMs: number, nowMs: number = Date.now()): number | undefined {
	if (!ownerId || !(idleMs > 0)) return undefined;
	let earliest: number | undefined;
	for (const tab of tabs.values()) {
		if (tab.ownerSessionId !== ownerId || !isIdleManaged(tab)) continue;
		const remaining = idleMs - (nowMs - tab.lastActivityAt);
		if (remaining <= 0) return 0;
		earliest = earliest === undefined ? remaining : Math.min(earliest, remaining);
	}
	return earliest;
}

/** Drop a pending idle-close deadline and invalidate a sweep in flight. */
export function cancelIdleCloseForOwner(ownerId: string): void {
	if (!ownerId) return;
	clearIdleCloseTimer(ownerId);
	idleCloseCancelSeq.set(ownerId, ++idleCloseSeq);
}

/** Test probe: whether the owner currently has an armed deadline. */
export function hasIdleCloseTimerForTest(ownerId: string): boolean {
	return idleCloseTimers.has(ownerId);
}

function clearIdleCloseTimer(ownerId: string): void {
	const existing = idleCloseTimers.get(ownerId);
	if (existing === undefined) return;
	idleCloseTimers.delete(ownerId);
	clearTimeout(existing);
}

/**
 * (Re)arm the owner-scoped one-shot that closes idle tabs when the timeout
 * elapses without further activity. Without this, a tab used in the final
 * turn before an idle session would sit until the next turn, open, or
 * dispose despite the advertised timeout. The timer is unref'd so it never
 * holds the process open (print/RPC exits are unaffected), firing
 * re-enters through `releaseIdleTabsForOwner` — which re-arms while
 * survivors remain — and disposal needs no cleanup since a fired sweep
 * over released tabs is a no-op. Due-but-busy survivors re-arm on a short
 * retry cadence instead of losing their deadline until the next sweep.
 * @param retryMs recheck cadence for due-but-busy survivors; keep well above zero.
 */
export function armIdleCloseForOwner(ownerId: string, idleMs: number, retryMs: number = IDLE_DUE_RETRY_MS): void {
	clearIdleCloseTimer(ownerId);
	const delay = earliestIdleCloseInMs(ownerId, idleMs);
	if (delay === undefined) return;
	const wait = delay <= 0 ? retryMs : Math.min(delay, 2_147_483_647);
	const timer = setTimeout(() => {
		idleCloseTimers.delete(ownerId);
		void releaseIdleTabsForOwner(ownerId, { idleMs })
			.then(() => armIdleCloseForOwner(ownerId, idleMs, retryMs))
			.catch(() => undefined);
	}, wait);
	timer.unref();
	idleCloseTimers.set(ownerId, timer);
}

/** Test-only accessor for the module-global tabs map. */
export function getTabsMapForTest(): Map<string, TabSession> {
	return tabs;
}

function isLastSurfaceCloseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /last/i.test(message);
}

function sameAllowedDomains(left: readonly string[], right: readonly string[] | undefined): boolean {
	if (!right || left.length !== right.length) return false;
	return left.every((domain, index) => domain === right[index]);
}

/** At most hourly, sweep the upload staging folders of closed tabs (see `sweepUploadStaging`). */
function sweepClosedTabUploads(): void {
	const now = Date.now();
	if (now - lastUploadSweep < UPLOAD_SWEEP_INTERVAL_MS) return;
	lastUploadSweep = now;
	const live = new Set<string>();
	for (const tab of tabs.values()) if (tab.backend === "worker") live.add(tab.uploadDir);
	void sweepUploadStaging(live, now).catch(() => undefined);
}

async function buildInitPayload(browser: PuppeteerBrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const safeDir = getPuppeteerDir();
	const uploadDir = newUploadStagingDir();
	const browserWSEndpoint = browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	if (browser.kind.kind === "headless") {
		return {
			mode: "headless",
			browserWSEndpoint,
			safeDir,
			uploadDir,
			// Visible launches still need an OMP-owned page, stealth setup, and
			// independent lifecycle; only their fixed device emulation is disabled.
			emulateViewport: browser.kind.headless,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			allowedDomains: opts.allowedDomains,
			initScripts: opts.initScripts,
			downloadsPath: opts.downloadsPath,
			userAgent: opts.userAgent,
			ignoreHttpsErrors: opts.ignoreHttpsErrors,
		};
	}

	const userDriven = browser.kind.kind === "connected" || browser.kind.kind === "relay";
	let page: AttachPage;
	if (browser.kind.kind === "relay" && !opts.target) {
		// A relay open without a target gets its own background tab, leaving the user's
		// selected tab alone, in the browser of the tab omp used last on this relay.
		// Focus emulation keeps it interactive without raising it.
		page = { kind: "create", nearTargetId: lastUsedTargetOn(browser) };
	} else {
		// A connected browser without a target adopts the tab the user is looking at
		// rather than whichever CDP lists first; an explicit target is borrowed.
		const picked = await pickElectronTarget(browser.browser, {
			matcher: opts.target,
			preferVisible: userDriven && !opts.target,
			relayJson: browser.kind.kind === "relay" ? browser.kind.cdpUrl : undefined,
			signal: opts.signal,
		});
		page = { kind: "borrowed", targetId: await targetIdForPage(picked) };
	}
	return {
		mode: "attach",
		browserWSEndpoint,
		safeDir,
		uploadDir,
		page,
		dialogs: opts.dialogs,
		allowedDomains: opts.allowedDomains,
		initScripts: opts.initScripts,
		downloadsPath: opts.downloadsPath,
		userAgent: opts.userAgent,
		ignoreHttpsErrors: opts.ignoreHttpsErrors,
		userDriven,
	};
}

/** The tab most recently used on `browser`, for a new relay tab to open beside. */
function lastUsedTargetOn(browser: PuppeteerBrowserHandle): string | undefined {
	let last: WorkerTabSession | undefined;
	for (const tab of tabs.values()) {
		if (tab.backend !== "worker" || tab.browser !== browser || tab.state !== "alive") continue;
		if (!last || tab.lastActivityAt > last.lastActivityAt) last = tab;
	}
	return last?.targetId;
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
			// Every error of a process generation means it is gone: its process
			// exited, or it sent a frame the parent could not decode and the
			// handle killed it.
			if (retiredWorkers.has(worker) || tab.worker !== worker || tab.state !== "alive") return;
			logBrowserFailure("worker-error", tab, { worker, error });
			handleWorkerLoss(tab, worker, describeWorkerLoss(error));
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
		// The run's own `finally` drops the entry: a recovery after its result still holds the tab busy.
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

// The cause line in a lost generation's stderr tail: Bun's own report, or omp's fatal report.
const WORKER_FAILURE_CAUSE = /^(?:error: |\[(?:Unhandled Rejection|Uncaught Exception)\] (?:\w+: )?)(.+)$/m;

/**
 * What a lost generation's failure says, for the runs it fails and the tab's
 * next call. An exit error carries the process's stderr tail, where the cause
 * is the line after Bun's source excerpt (`error: …`) or omp's fatal report
 * (`[Unhandled Rejection] Error: …`); only that line names it.
 */
function describeWorkerLoss(error: Error): string {
	const thrown = WORKER_FAILURE_CAUSE.exec(error.message)?.[1];
	if (error instanceof TabWorkerExitError) {
		return `Browser tab worker exited unexpectedly (${error.status}${thrown ? `, ${boundedDetail(thrown)}` : ""})`;
	}
	return `Browser tab worker failed: ${boundedDetail(thrown ?? error.message)}`;
}

/**
 * A worker generation is gone on its own: its process exited (an uncaught
 * error, a rejection no run owns, `process.exit`, a native fault) or it stopped
 * accepting messages. The runs it owed fail at once with `lost`, and the host
 * tool calls they started are cancelled. A new subprocess generation then
 * adopts the same page so the next call continues on it; the tab is closed when
 * that fails, or when the replacement is lost too within
 * {@link WORKER_EXIT_RETRY_WINDOW_MS}. Recovery claims the tab only through the
 * generation guards of `recoverWorkerTab`/`adoptRecycledWorker` and the
 * single-owner claim of `forceKillTab`, so a release or reopen racing it wins.
 */
function handleWorkerLoss(tab: WorkerTabSession, worker: WorkerHandle, lost: string): void {
	// A release, kill or recycle owns a generation it replaced or is tearing
	// down, and each lost generation is recovered once.
	if (retiredWorkers.has(worker)) return;
	const current = tabs.get(tab.name) === tab && tab.worker === worker && tab.state === "alive";
	if (!current || releaseInflight.has(tab)) return;
	retiredWorkers.add(worker);
	const now = Date.now();
	const looping = tab.workerExitedAt !== undefined && now - tab.workerExitedAt < WORKER_EXIT_RETRY_WINDOW_MS;
	tab.workerExitedAt = now;
	const reason = looping
		? `${lost} again right after being replaced; tab closed`
		: `${lost}; the tab is being reattached to a new worker on the same page. ${WORKER_RESETS}.`;
	// Runs not yet dispatched (still resuming the page) belong to this generation too.
	let idle = true;
	for (const pending of tab.pending.values()) {
		if (!pending.worker || pending.worker === worker) idle = false;
	}
	settlePendingRuns(tab, worker, postmortem.markExpectedCleanupError(new ToolError(reason)));
	const logRecoveryFailure = (error: unknown): false => {
		logBrowserFailure("recycle-failed", tab, { worker, error });
		return false;
	};
	if (looping) {
		void forceKillTab(tab, reason).catch(logRecoveryFailure);
		return;
	}
	const recovery = recoverWorkerTab(tab, worker, WORKER_EXIT_REATTACH_TIMEOUT_MS, {
		// Keep the page as the worker left it: stopping its loading would cancel a navigation the agent started.
		recover: false,
		failedReason: `${lost}; it could not be reattached to a new worker, so the tab was closed`,
	})
		.then(reattached => {
			// No run was in flight to report the reset, so the next call on the tab does.
			if (reattached && idle) {
				tab.workerExitNotice = `${lost} since the last call; omp reattached the tab to a new worker on the same page, without reloading it. ${WORKER_RESETS}.`;
			}
			return reattached;
		})
		.catch(logRecoveryFailure)
		.finally(() => {
			if (tab.workerRecovery === recovery) tab.workerRecovery = undefined;
		});
	tab.workerRecovery = recovery;
}

/**
 * Settle every run owned by `worker`; that generation can no longer answer.
 * `exceptRunId` is the run driving a recycle: it is already settled and keeps
 * its entry, so the tab stays busy until that run's own `finally`.
 */
function settlePendingRuns(tab: WorkerTabSession, worker: WorkerHandle, error: Error, exceptRunId?: string): void {
	for (const [id, pending] of tab.pending) {
		if (id === exceptRunId || (pending.worker && pending.worker !== worker)) continue;
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
		safeSend(tab, worker, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: toWorkerErrorPayload(error) },
		});
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

/**
 * Reply to the generation that asked, and only while it still owns the tab. A
 * reply that cannot be delivered means that generation is gone: the run waiting
 * on it can never complete, so recover the tab now rather than at the grace
 * timeout.
 */
function safeSend(tab: WorkerTabSession, worker: WorkerHandle, msg: WorkerInbound): void {
	if (tab.state !== "alive" || tab.worker !== worker || retiredWorkers.has(worker)) return;
	if (worker.send(msg)) return;
	logBrowserFailure("send-dropped", tab, { worker, reason: msg.type });
	handleWorkerLoss(tab, worker, "Browser tab worker stopped accepting messages");
}

/**
 * The wait, within `opts`' timeout and abort signal, for the reattach of the tab `name` whose worker was lost on
 * its own; it resolves to the tab waited on. `undefined` when none is being reattached, so a caller with nothing to
 * wait for goes on in the same tick.
 */
function awaitWorkerRecovery(
	name: string,
	opts: { timeoutMs: number; signal?: AbortSignal },
	abortMessage?: string,
): Promise<WorkerTabSession> | undefined {
	const recovering = tabs.get(name);
	if (recovering?.backend !== "worker" || !recovering.workerRecovery) return undefined;
	recovering.lastActivityAt = Date.now();
	return raceWithTimeout(
		untilAborted(opts.signal, recovering.workerRecovery),
		opts.timeoutMs,
		`Tab ${JSON.stringify(name)}'s worker was still being reattached after ${opts.timeoutMs}ms`,
	).then(
		() => recovering,
		error => {
			if (opts.signal?.aborted) throw new ToolAbortError(abortMessage);
			throw error;
		},
	);
}

/**
 * Resolves `false` when the tab was closed, reopened, or recycled by someone
 * else while the new worker started; the new worker is then discarded.
 */
async function recycleTimedOutWorkerTab(
	tab: WorkerTabSession,
	previous: WorkerHandle,
	timeoutMs: number,
	opts: {
		/** The run driving the recycle: it is already settled and keeps its entry until its own `finally`. */
		recoveringRunId?: string;
		/** Unblock the page before adopting it; default true. */
		recover?: boolean;
	} = {},
): Promise<boolean> {
	// The replacement inherits the recovery deadline instead of restarting it.
	const startedAt = performance.now();
	// Late failures of the generation being replaced belong to this recycle.
	retiredWorkers.add(previous);
	await previous.terminate().catch(() => undefined);
	// Anything still registered against the terminated generation will never be
	// answered; settle it before a replacement can claim the tab.
	settlePendingRuns(
		tab,
		previous,
		postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(tab.name)} worker was recycled`)),
		opts.recoveringRunId,
	);
	// A release or kill that landed while the old generation stopped owns the
	// tab now; starting a worker for it would only attach to a closed page.
	if (tabs.get(tab.name) !== tab || tab.worker !== previous || tab.state !== "alive") return false;
	const browserWSEndpoint = tab.browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	const payload: WorkerInitPayload = {
		mode: "attach",
		browserWSEndpoint,
		safeDir: getPuppeteerDir(),
		uploadDir: tab.uploadDir,
		page: { kind: tab.ownsPage ? "owned" : "borrowed", targetId: tab.targetId },
		dialogs: tab.dialogPolicy,
		allowedDomains: tab.allowedDomains,
		// Unblock a wedged page (open JS dialog, hung navigation) before adopting it —
		// otherwise init stalls, times out, and the tab gets force-killed.
		recover: opts.recover ?? true,
		userDriven: tab.kindTag === "connected" || tab.kindTag === "relay",
	};
	const worker = await tabWorkerHost.spawnTabWorker();
	// A release or kill that landed while it spawned saw no replacement to stop.
	if (tabs.get(tab.name) !== tab || tab.worker !== previous || tab.state !== "alive") {
		await worker.terminate().catch(() => undefined);
		return false;
	}
	const stop = new AbortController();
	tab.replacement = { worker, stop };
	try {
		const info = await untilAborted(stop.signal, initializeTabWorker(worker, payload, timeoutMs, startedAt));
		return adoptRecycledWorker(tab, previous, worker, info);
	} catch (error) {
		// No inline retry: the subprocess is the native-crash isolation boundary.
		// A page that crashed again as this attach brought it back fails here too.
		await worker.terminate().catch(() => undefined);
		// A release or kill stopped this replacement and owns the tab now.
		if (stop.signal.aborted) return false;
		throw error;
	} finally {
		if (tab.replacement?.worker === worker) tab.replacement = undefined;
	}
}

/**
 * Stop the generation a recycle is still starting for `tab`; the recycle then
 * resolves `false`. Called by teardown, which owns the tab from then on.
 */
async function stopReplacement(tab: WorkerTabSession): Promise<void> {
	const replacement = tab.replacement;
	if (!replacement) return;
	tab.replacement = undefined;
	replacement.stop.abort();
	await replacement.worker.terminate().catch(() => undefined);
}

/**
 * Publish a freshly initialized generation onto the tab, but only while the
 * tab is still registered, still owned by the generation we replaced, and still
 * alive. Losing that race means a concurrent `releaseTab`/`forceKillTab`/reopen
 * owns the name now: adopting anyway would resurrect a torn-down tab and strand
 * the new worker outside the registry.
 */
function adoptRecycledWorker(
	tab: WorkerTabSession,
	previous: WorkerHandle,
	next: WorkerHandle,
	info: ReadyInfo,
): boolean {
	if (tabs.get(tab.name) !== tab || tab.worker !== previous || tab.state !== "alive") {
		logBrowserFailure("recycle-superseded", tab, { worker: next });
		void next.terminate().catch(() => undefined);
		return false;
	}
	tab.worker = next;
	tab.info = info;
	// The new generation adopted the page as `owned` or `borrowed`, so its close
	// keeps the tab's ownership; release still confirms an owned page by id.
	attachWorker(tab, next);
	return true;
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
	// A release already owns this tab's teardown. Joining it keeps one worker
	// termination, one browser-hold release, and one ownership decision — the
	// racing pair otherwise released the shared browser's hold twice and let the
	// second path forget a target this one is retaining.
	const ongoing = releaseInflight.get(tab);
	if (ongoing) {
		await ongoing.promise.catch(() => undefined);
		return;
	}
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
	// Published before the first await so a joining caller waits for this
	// teardown instead of repeating it. The published result is the release
	// contract — the tab is gone either way; a target that could not be closed
	// stays in the ownership registry instead.
	const teardown = tab.backend === "worker" ? forceKillTabTeardown(tab) : forceKillSurfaceTab(tab);
	const entry = { promise: teardown.then(() => true), opts: { kill: false } };
	releaseInflight.set(tab, entry);
	forceKillInflight.set(tab.name, tab);
	try {
		await entry.promise;
	} finally {
		if (releaseInflight.get(tab) === entry) releaseInflight.delete(tab);
		if (forceKillInflight.get(tab.name) === tab) forceKillInflight.delete(tab.name);
	}
}

/** Teardown half of {@link forceKillTab} for a cmux or Tern surface, published through the release single-flight. */
async function forceKillSurfaceTab(tab: CmuxTabSession | TernTabSession): Promise<void> {
	if (tab.backend === "tern")
		await tab.ternTab.close({ timeoutMs: DEFAULT_TAB_CLOSE_TIMEOUT_MS }).catch(() => undefined);
	await releaseBrowser(tab.browser, { kill: false });
}
/**
 * Teardown half of {@link forceKillTab} for a worker tab, published through the
 * release single-flight. Same rule as `releaseTabInner`: a target whose close is
 * unconfirmed (fast failure, or a close that outran its budget) keeps its
 * ownership record and re-checks the shared browser, so a wedged Chromium cannot
 * hold the page past every later reap. The close is bounded exactly as
 * `releaseTabInner` bounds it — a release joining this teardown must not inherit
 * an unbounded CDP wait (Puppeteer's protocol timeout is 60 s). Teardown must
 * still finish: the tab is already dead to its callers.
 */
async function forceKillTabTeardown(tab: WorkerTabSession): Promise<void> {
	await stopReplacement(tab);
	await tab.worker.terminate().catch(() => undefined);
	if (tab.ownsPage) await removeUploadStaging(tab.uploadDir);
	let targetClosed = true;
	if (tab.ownsPage) {
		targetClosed = await waitForTabCleanup(
			tab,
			DEFAULT_TAB_CLOSE_TIMEOUT_MS,
			`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
			closeOrphanTarget(tab, DEFAULT_TAB_CLOSE_TIMEOUT_MS),
		).catch(() => false);
	}
	await releaseBrowser(tab.browser, { kill: false });
	const scope = sharedScopeOf(tab.browser);
	if (scope) {
		if (targetClosed) void forgetSharedTarget(scope, tab.targetId);
		else recheckSharedBrowser(scope);
	}
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
async function closeTargetById(
	browser: PuppeteerBrowserHandle,
	targetId: string,
	confirmTimeoutMs?: number,
): Promise<boolean> {
	if (browser.kind.kind === "relay") return await closeRelayTarget(browserConnection(browser.browser), targetId);
	return await closeCdpTarget(browser.browser, targetId, confirmTimeoutMs);
}

/**
 * Durable-ownership scope for a browser handle, or undefined when the handle is
 * not the project-shared broker-owned Chromium (the only browser whose targets
 * outlive their creating process and thus need cross-process orphan reaping).
 */
function sharedScopeOf(browser: BrowserHandle): SharedTargetScope | undefined {
	if (!("browser" in browser)) return undefined;
	if (browser.kind.kind !== "headless" || !browser.sharedDaemon) return undefined;
	return { projectDir: browser.sharedDaemon.projectDir, daemonName: browser.sharedDaemon.name };
}

/**
 * Re-check the shared browser after a close it could not confirm, and forget
 * only what the outcome proves. A browser that answers is left alone: the
 * retained record is not retried by this process (`collectOrphanTargets` skips
 * a live pid) but is reaped after it exits, which is the same guarantee the
 * registry gave before. When — and only when — the broker confirms the daemon
 * ended (`stopSharedBrowserIfUnreachable` resolves true on a terminal stop
 * snapshot), every target this process still claims in it went with the
 * browser, so those records go too instead of being rewritten on every later
 * flush. An unconfirmed stop forgets nothing.
 */
function recheckSharedBrowser(scope: SharedTargetScope): void {
	void stopSharedBrowserIfUnreachable(scope).then(stopped => {
		if (stopped) void forgetSharedTargets(scope);
	});
}

/**
 * Best-effort cleanup for a forced-kill path: close the page the tab's worker
 * reported as created. A run caller is never a browser ref holder, so the
 * browser is still in the registry; the tab's browser is the only place that
 * page can be, so no targetId guesswork across multiple sessions.
 *
 * `budgetMs` is the caller's bound on the whole close. The `targetDestroyed`
 * wait gets half of it, leaving the rest for the `Target.getTargets` fallback.
 */
async function closeOrphanTarget(tab: WorkerTabSession, budgetMs: number): Promise<boolean> {
	return await closeTargetById(tab.browser, tab.targetId, budgetMs / 2);
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

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = cfgBrowserScreenshotDir.get(session.settings);
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
	if (payload.debuggerDetached) {
		const error = new DebuggerDetachedError(
			payload.message,
			payload.debuggerDetached.when,
			payload.debuggerDetached.reason,
		);
		if (payload.stack) error.stack = payload.stack;
		return error;
	}
	const error = payload.rendererCrashed
		? new RendererCrashedError(payload.message)
		: payload.recoverTab
			? new RecoverableWorkerError(payload.message)
			: payload.isAbort
				? new ToolAbortError()
				: payload.navigationTimeout
					? new NavigationTimeoutError(payload.message)
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
	| "renderer-crashed"
	| "debugger-detached"
	| "recover-tab"
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
	"renderer-crashed": "warn",
	"debugger-detached": "warn",
	"recover-tab": "warn",
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
 * `setup` handshake (bounded by the cold-start guard) and the ready wait for
 * page acquisition (navigation runs afterwards, as a separate `tab.goto`).
 * Both phases are bounded by the time LEFT of the caller's `timeoutMs`
 * budget, measured from `deadlineStart` (performance.now() when the caller's
 * budget began). A headless worker's `page-created` report (the new
 * target, sent before the slow post-creation CDP work) is recorded in
 * `workerPageTargets` so a supervisor that kills the worker during init
 * (budget exhausted, aborted open) can close exactly the page the worker
 * created — a killed worker can't clean up after itself. The listener is
 * never removed between phases: IPC can deliver `ready` or `init-failed`
 * immediately after `setup`; either could otherwise reach the already-settled
 * setup listener before a phase switch re-listens and be dropped.
 */
async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	// Derive both phase budgets from the remaining caller budget. The floors
	// keep budgets positive when little time remains; the caller's abort signal
	// remains the hard backstop for the overshoot.
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
		else if (msg.type === "init-failed") failStartup(errorFromPayload(msg.error));
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

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs, deadlineStart);
}
