/**
 * Worker-generation ownership for browser tabs.
 *
 * A tab outlives its workers: a run that blows its budget terminates the worker
 * and adopts a fresh one. Every invariant below is about who owns what during
 * that swap, and the first two were violated by the code that produced the
 * fatal `InvalidStateError: Worker has been terminated` crash:
 *
 *  1. Cancellation belongs to the generation that received the run. The cell's
 *     idle watchdog firing mid-recycle must neither post to the terminated
 *     worker (an uncaught exception, because abort listeners run inside a bare
 *     timer callback) nor cancel anything on the replacement, and the tab must
 *     stay usable for the next run.
 *  2. A recycle that loses the race to `releaseTab` must not publish its
 *     replacement. The releasing caller already evicted the tab, so adopting
 *     would resurrect it outside the registry and leak the new worker.
 *  3. A generation that can no longer be talked to (crashed, or a reply that
 *     cannot be posted) settles its runs immediately instead of letting each
 *     caller wait out the grace window, and leaves no worker thread, no page
 *     target, and no browser hold behind.
 *
 * The fake worker is a raw Bun-`Worker`-shaped object driven through the real
 * `wrapBunWorker`, so it reproduces the platform contract that caused the
 * incident: `postMessage` after `terminate()` throws `InvalidStateError`.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import * as tabWorkerHost from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker-host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const READY: ReadyInfo = {
	url: "about:blank",
	viewport: { width: 800, height: 600 },
	targetId: "target-generation",
};

const RUN_TIMEOUT_MS = 5_000;

/** Mirrors Bun's `Worker`: post after terminate throws, listeners are real. */
class FakeBunWorker extends EventTarget {
	readonly received: WorkerInbound[] = [];
	terminated = false;
	#respond: (msg: WorkerInbound, worker: FakeBunWorker) => void;

	constructor(respond: (msg: WorkerInbound, worker: FakeBunWorker) => void) {
		super();
		this.#respond = respond;
	}

	postMessage(msg: WorkerInbound): void {
		if (this.terminated) throw new DOMException("Worker has been terminated", "InvalidStateError");
		this.received.push(msg);
		queueMicrotask(() => this.#respond(msg, this));
	}

	terminate(): void {
		this.terminated = true;
	}

	emit(msg: WorkerOutbound): void {
		this.dispatchEvent(new MessageEvent("message", { data: msg }));
	}

	crash(error: Error): void {
		this.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
	}

	get kinds(): string[] {
		return this.received.map(msg => msg.type);
	}
}

/**
 * Headless-shaped browser handle. `closedTargets` records the ids the
 * supervisor closed through `closeCdpTarget`, which drives every orphan-page
 * cleanup path in this version (browser-level CDP session, not `page.close()`).
 */
function makeBrowser(): { handle: PuppeteerBrowserHandle; closedTargets: string[] } {
	const closedTargets: string[] = [];
	const session = {
		async send(method: string, params?: { targetId?: string }): Promise<unknown> {
			if (method === "Target.closeTarget") {
				if (params?.targetId) closedTargets.push(params.targetId);
				return { success: true };
			}
			if (method === "Target.getTargets") return { targetInfos: [] };
			return {};
		},
		async detach(): Promise<void> {},
	};
	// Only the members the worker-backed headless path touches; a real puppeteer
	// Browser cannot be constructed without Chromium.
	const handle = {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		refCount: 0,
		stealth: { browserSession: null, override: null },
		browser: {
			connected: false,
			wsEndpoint: () => "ws://127.0.0.1/devtools/browser/fake",
			target: () => ({ createCDPSession: async () => session }),
			targets: () => [],
		},
	} as unknown as PuppeteerBrowserHandle;
	return { handle, closedTargets };
}

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
		getSessionId: () => "session-generation",
	} as unknown as ToolSession;
}

/** Answers the init handshake with `setup` + `ready` and `close` with `closed`. */
function standardReplies(msg: WorkerInbound, worker: FakeBunWorker): boolean {
	if (msg.type === "init") {
		worker.emit({ type: "setup" });
		worker.emit({ type: "ready", info: READY });
		return true;
	}
	if (msg.type === "close") {
		worker.emit({ type: "closed" });
		return true;
	}
	return false;
}

function queueSpawns(workers: FakeBunWorker[]): void {
	const pendingSpawns = [...workers];
	spyOn(tabWorkerHost, "spawnTabWorker").mockImplementation(async () => {
		const next = pendingSpawns.shift();
		if (!next) throw new Error("unexpected tab worker spawn");
		return tabWorkerHost.wrapBunWorker(next as unknown as Worker);
	});
}

describe("browser tab-supervisor: worker generations", () => {
	afterEach(async () => {
		for (const name of getTabsMapForTest().keys()) {
			await releaseTab(name, { kill: false }).catch(() => undefined);
		}
		vi.restoreAllMocks();
	});

	it("keeps a mid-recycle abort off both generations and leaves the recycled tab usable", async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", onUncaught);

		const recycleReached = Promise.withResolvers<void>();
		const recycleGate = Promise.withResolvers<void>();
		const wedged = new FakeBunWorker((msg, worker) => {
			if (standardReplies(msg, worker)) return;
			if (msg.type !== "run") return;
			// What a wedged page reports: the worker's own cell budget expired.
			worker.emit({
				type: "result",
				id: msg.id,
				ok: false,
				error: {
					name: "ToolError",
					message: `Browser code execution timed out after ${RUN_TIMEOUT_MS}ms (stalled on click)`,
					isToolError: true,
					isAbort: false,
				},
			});
		});
		const replacement = new FakeBunWorker((msg, worker) => {
			if (msg.type === "close") {
				worker.emit({ type: "closed" });
				return;
			}
			if (msg.type === "init") {
				recycleReached.resolve();
				void recycleGate.promise.then(() => {
					worker.emit({ type: "setup" });
					worker.emit({ type: "ready", info: READY });
				});
				return;
			}
			if (msg.type === "run") {
				worker.emit({
					type: "result",
					id: msg.id,
					ok: true,
					payload: { displays: [], returnValue: "ran on the replacement", screenshots: [] },
				});
			}
		});
		queueSpawns([wedged, replacement]);

		try {
			const browser = makeBrowser();
			await acquireTab("eval", browser.handle, { timeoutMs: RUN_TIMEOUT_MS });
			// Stands in for the eval cell's `IdleTimeout` controller.
			const idle = new AbortController();
			const timedOut = runInTab("eval", {
				code: "await tab.click('#missing');",
				timeoutMs: RUN_TIMEOUT_MS,
				signal: idle.signal,
				session: makeSession(),
			}).then(
				() => undefined,
				(error: unknown) => error,
			);

			await recycleReached.promise;
			// The wedged generation is already terminated and the replacement is
			// still initializing, the exact window the incident aborted in.
			expect(wedged.terminated).toBe(true);
			idle.abort(new DOMException("Idle for 60s", "TimeoutError"));
			recycleGate.resolve();

			const failure = await timedOut;
			expect((failure as Error).message).toContain("Browser code execution timed out after");

			const second = await runInTab("eval", {
				code: "1 + 1;",
				timeoutMs: RUN_TIMEOUT_MS,
				session: makeSession(),
			});

			expect(uncaught).toEqual([]);
			// The dead run's cancellation reached neither generation, and the
			// replacement served the next run.
			expect(wedged.kinds).toEqual(["init", "run"]);
			expect(replacement.kinds).toEqual(["init", "run"]);
			expect(second.returnValue).toBe("ran on the replacement");
		} finally {
			recycleGate.resolve();
			process.removeListener("uncaughtException", onUncaught);
		}
	});

	it("discards a recycled worker that lost the race to releaseTab", async () => {
		const recycleReached = Promise.withResolvers<void>();
		const recycleGate = Promise.withResolvers<void>();
		const wedged = new FakeBunWorker((msg, worker) => {
			if (standardReplies(msg, worker)) return;
			if (msg.type !== "run") return;
			worker.emit({
				type: "result",
				id: msg.id,
				ok: false,
				error: {
					name: "ToolError",
					message: `Browser code execution timed out after ${RUN_TIMEOUT_MS}ms`,
					isToolError: true,
					isAbort: false,
				},
			});
		});
		const replacement = new FakeBunWorker((msg, worker) => {
			if (msg.type === "close") {
				worker.emit({ type: "closed" });
				return;
			}
			if (msg.type !== "init") return;
			recycleReached.resolve();
			void recycleGate.promise.then(() => {
				worker.emit({ type: "setup" });
				worker.emit({ type: "ready", info: READY });
			});
		});
		queueSpawns([wedged, replacement]);

		try {
			const browser = makeBrowser();
			await acquireTab("eval", browser.handle, { timeoutMs: RUN_TIMEOUT_MS });
			const timedOut = runInTab("eval", {
				code: "await tab.click('#missing');",
				timeoutMs: RUN_TIMEOUT_MS,
				session: makeSession(),
			}).then(
				() => undefined,
				(error: unknown) => error,
			);

			await recycleReached.promise;
			// A sibling closes the tab while the replacement is still initializing.
			await releaseTab("eval", { kill: false });
			recycleGate.resolve();

			const failure = await timedOut;
			expect((failure as Error).message).toContain("Browser code execution timed out after");

			// The release owns the name: the replacement is discarded rather than
			// published onto a tab nobody can reach, and the browser hold is gone.
			expect(getTabsMapForTest().has("eval")).toBe(false);
			expect(replacement.terminated).toBe(true);
			expect(browser.handle.refCount).toBe(0);
		} finally {
			recycleGate.resolve();
		}
	});

	it("settles an in-flight run when its worker generation dies", async () => {
		const crashing = new FakeBunWorker((msg, worker) => {
			if (standardReplies(msg, worker)) return;
			// The worker thread dies without ever answering the run: no
			// `result` message will arrive, only the runtime's error event.
			if (msg.type === "run") worker.crash(new Error("Worker exited with code 134"));
		});
		queueSpawns([crashing]);

		const browser = makeBrowser();
		await acquireTab("eval", browser.handle, { timeoutMs: RUN_TIMEOUT_MS });
		const started = Date.now();
		const failure = await runInTab("eval", {
			code: "await tab.screenshot();",
			timeoutMs: RUN_TIMEOUT_MS,
			session: makeSession(),
		}).then(
			() => undefined,
			(error: unknown) => error,
		);

		// Surfaced from the worker's death, not from waiting out the grace race.
		expect((failure as Error).message).toContain("Worker exited with code 134");
		expect(Date.now() - started).toBeLessThan(RUN_TIMEOUT_MS);
		// The dead generation left no run registered and the name explains itself.
		const reopenFailure = await runInTab("eval", {
			code: "1;",
			timeoutMs: RUN_TIMEOUT_MS,
			session: makeSession(),
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect((reopenFailure as Error).message).toContain("was killed: Browser tab worker failed");
		// Nothing of the dead generation survives: thread terminated, its page
		// target closed by the release, browser hold returned.
		expect(crashing.terminated).toBe(true);
		await releaseTab("eval", { kill: false });
		expect(browser.closedTargets).toEqual([READY.targetId]);
		expect(browser.handle.refCount).toBe(0);
	});

	it("settles the run when a tool reply can no longer be delivered", async () => {
		const dying = new FakeBunWorker((msg, worker) => {
			if (standardReplies(msg, worker)) return;
			if (msg.type !== "run") return;
			// The worker asks the host for a tool and dies before the answer
			// can be posted back. The run is now waiting on a reply nobody can
			// deliver.
			worker.emit({ type: "tool-call", id: "call-1", runId: msg.id, name: "read", args: {} });
			worker.terminate();
		});
		queueSpawns([dying]);

		await acquireTab("eval", makeBrowser().handle, { timeoutMs: RUN_TIMEOUT_MS });
		const started = Date.now();
		const failure = await runInTab("eval", {
			code: "await read('AGENTS.md');",
			timeoutMs: RUN_TIMEOUT_MS,
			session: makeSession(),
		}).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect((failure as Error).message).toBe("Browser tab worker stopped accepting messages");
		expect(Date.now() - started).toBeLessThan(RUN_TIMEOUT_MS);
	});

	it("contains a worker crash that lands while a tool call is in flight", async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", onUncaught);

		const toolStarted = Promise.withResolvers<void>();
		const toolCancelled = Promise.withResolvers<string>();
		const crashing = new FakeBunWorker((msg, worker) => {
			if (standardReplies(msg, worker)) return;
			if (msg.type !== "run") return;
			worker.emit({ type: "tool-call", id: "call-1", runId: msg.id, name: "read", args: {} });
		});
		queueSpawns([crashing]);

		// A host tool the worker asked for, still running when the worker dies.
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: { get: () => undefined },
			getSessionFile: () => null,
			getSessionId: () => "session-containment",
			getToolByName: () => ({
				execute: async (_id: string, _args: unknown, signal?: AbortSignal) => {
					signal?.addEventListener("abort", () => toolCancelled.resolve(String(signal.reason)), { once: true });
					toolStarted.resolve();
					return { content: [{ type: "text", text: await toolCancelled.promise }] };
				},
			}),
		} as unknown as ToolSession;

		const browser = makeBrowser();
		try {
			await acquireTab("eval", browser.handle, { timeoutMs: RUN_TIMEOUT_MS });
			const settled = runInTab("eval", {
				code: "await read('AGENTS.md');",
				timeoutMs: RUN_TIMEOUT_MS,
				session,
			}).then(
				() => undefined,
				(error: unknown) => error,
			);

			await toolStarted.promise;
			crashing.crash(new Error("Worker exited with code 134"));

			const failure = await settled;
			// Contained to the affected tool call: the run reports the worker's
			// death, the host work it delegated is cancelled, the dead thread is
			// gone, and the process saw no uncaught exception.
			expect((failure as Error).message).toContain("Browser tab worker failed: Worker exited with code 134");
			expect(await toolCancelled.promise).toContain("Browser tab worker failed");
			expect(uncaught).toEqual([]);
			expect(crashing.terminated).toBe(true);

			// A subsequent call reports the closed tab instead of hanging.
			const reopenFailure = await runInTab("eval", {
				code: "1;",
				timeoutMs: RUN_TIMEOUT_MS,
				session: makeSession(),
			}).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect((reopenFailure as Error).message).toContain("was killed: Browser tab worker failed");

			await releaseTab("eval", { kill: false });
			expect(browser.closedTargets).toEqual([READY.targetId]);
			expect(browser.handle.refCount).toBe(0);
		} finally {
			toolCancelled.resolve("not cancelled");
			process.removeListener("uncaughtException", onUncaught);
		}
	});
});
