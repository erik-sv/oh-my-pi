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
 *     caller wait out the grace window, cancels the host work they started,
 *     and is terminated. A new subprocess generation adopts the same page; a
 *     replacement lost again right away, or one that cannot start, closes the
 *     tab and leaves no worker process, page target, or browser hold behind.
 *
 * The fake process handle preserves generation identity and undeliverable-send
 * behavior without sharing a native runtime with the test process.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type } from "@oh-my-pi/omptype";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import * as tabWorkerHost from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker-host";
import type { WorkerHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker-host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const READY: ReadyInfo = {
	url: "about:blank",
	viewport: { width: 800, height: 600 },
	targetId: "target-generation",
};

const RUN_TIMEOUT_MS = 5_000;

class FakeProcessWorker extends EventTarget implements WorkerHandle {
	readonly mode = "process" as const;
	readonly id = ++workerSeq;
	readonly received: WorkerInbound[] = [];
	terminated = false;
	#respond: (msg: WorkerInbound, worker: FakeProcessWorker) => void;

	constructor(respond: (msg: WorkerInbound, worker: FakeProcessWorker) => void) {
		super();
		this.#respond = respond;
	}

	get alive(): boolean {
		return !this.terminated;
	}

	send(msg: WorkerInbound): boolean {
		if (this.terminated) return false;
		this.received.push(msg);
		queueMicrotask(() => this.#respond(msg, this));
		return true;
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		const wrapped = (event: Event): void => handler((event as MessageEvent).data as WorkerOutbound);
		this.addEventListener("message", wrapped);
		return () => this.removeEventListener("message", wrapped);
	}

	onError(handler: (error: Error) => void): () => void {
		const wrapped = (event: Event): void => {
			const error = (event as ErrorEvent).error;
			handler(error instanceof Error ? error : new Error((event as ErrorEvent).message));
		};
		this.addEventListener("error", wrapped);
		return () => this.removeEventListener("error", wrapped);
	}

	async close(): Promise<boolean> {
		if (this.terminated) return false;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const unsubscribe = this.onMessage(message => {
			if (message.type !== "closed") return;
			unsubscribe();
			resolve(true);
		});
		if (!this.send({ type: "close" })) {
			unsubscribe();
			return false;
		}
		return await promise;
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	drop(): void {
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

let workerSeq = 0;

/**
 * Headless-shaped browser handle. `closedTargets` records the ids the
 * supervisor closed through `closeCdpTarget`, which drives every orphan-page
 * cleanup path in this version (browser-level CDP session, not `page.close()`).
 * Like Chromium, the session reports an accepted close with
 * `Target.targetDestroyed` once target discovery is on.
 */
function makeBrowser(): { handle: PuppeteerBrowserHandle; closedTargets: string[] } {
	const closedTargets: string[] = [];
	const destroyedListeners = new Set<(event: { targetId: string }) => void>();
	let discovering = false;
	const session = {
		on(event: string, listener: (event: { targetId: string }) => void): void {
			if (event === "Target.targetDestroyed") destroyedListeners.add(listener);
		},
		off(event: string, listener: (event: { targetId: string }) => void): void {
			if (event === "Target.targetDestroyed") destroyedListeners.delete(listener);
		},
		async send(method: string, params?: { targetId?: string; discover?: boolean }): Promise<unknown> {
			if (method === "Target.setDiscoverTargets") {
				discovering = params?.discover === true;
				return {};
			}
			if (method === "Target.closeTarget") {
				const targetId = params?.targetId;
				if (targetId) {
					closedTargets.push(targetId);
					// The event follows the command's response, as on the wire.
					if (discovering) {
						queueMicrotask(() => {
							for (const listener of destroyedListeners) listener({ targetId });
						});
					}
				}
				return { success: true };
			}
			if (method === "Target.getTargets") return { targetInfos: [] };
			return {};
		},
		async detach(): Promise<void> {
			discovering = false;
			destroyedListeners.clear();
		},
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
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionId: () => "session-generation",
	} as unknown as ToolSession;
}

/** Answers the init handshake with `setup` + `ready` and `close` with `closed`. */
function standardReplies(msg: WorkerInbound, worker: FakeProcessWorker): boolean {
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

/** A generation that adopts the page and answers every run. */
function servingWorker(): FakeProcessWorker {
	return new FakeProcessWorker((msg, worker) => {
		if (standardReplies(msg, worker)) return;
		if (msg.type !== "run") return;
		worker.emit({
			type: "result",
			id: msg.id,
			ok: true,
			payload: { displays: [], returnValue: "ran on the replacement", screenshots: [] },
		});
	});
}

/** A generation whose process dies on every run without answering it. */
function crashingWorker(): FakeProcessWorker {
	return new FakeProcessWorker((msg, worker) => {
		if (standardReplies(msg, worker)) return;
		if (msg.type === "run") worker.crash(new Error("Worker exited with code 134"));
	});
}

/** A replacement generation whose init waits for `release()`; it then adopts the page and answers runs. */
function heldReplacement(): { worker: FakeProcessWorker; initStarted: Promise<void>; release(): void } {
	const initStarted = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const worker = new FakeProcessWorker((msg, self) => {
		if (msg.type === "init") {
			initStarted.resolve();
			void gate.promise.then(() => standardReplies(msg, self));
			return;
		}
		if (standardReplies(msg, self) || msg.type !== "run") return;
		self.emit({
			type: "result",
			id: msg.id,
			ok: true,
			payload: { displays: [], returnValue: "ran on the replacement", screenshots: [] },
		});
	});
	return { worker, initStarted: initStarted.promise, release: () => gate.resolve() };
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
	return await promise.then(
		() => "",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

function queueSpawns(workers: FakeProcessWorker[]): void {
	const pendingSpawns = [...workers];
	spyOn(tabWorkerHost, "spawnTabWorker").mockImplementation(async () => {
		const next = pendingSpawns.shift();
		if (!next) throw new Error("unexpected tab worker spawn");
		return next;
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
		const wedged = new FakeProcessWorker((msg, worker) => {
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
		const replacement = new FakeProcessWorker((msg, worker) => {
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
		const wedged = new FakeProcessWorker((msg, worker) => {
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
		const replacement = new FakeProcessWorker((msg, worker) => {
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

	it("settles an in-flight run when its worker generation dies and reattaches the page", async () => {
		const crashing = crashingWorker();
		const replacement = servingWorker();
		queueSpawns([crashing, replacement]);

		const browser = makeBrowser();
		await acquireTab("eval", browser.handle, { timeoutMs: RUN_TIMEOUT_MS });
		const started = Date.now();
		const failure = await failureOf(
			runInTab("eval", { code: "await tab.screenshot();", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() }),
		);

		// Surfaced from the worker's death, not from waiting out the grace race.
		expect(failure).toContain("Browser tab worker failed: Worker exited with code 134");
		expect(failure).toContain("the tab is being reattached to a new worker on the same page");
		expect(Date.now() - started).toBeLessThan(RUN_TIMEOUT_MS);
		// The next call waits for the reattach and runs on the new generation,
		// which adopted the same page as-is instead of creating another.
		const next = await runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() });
		expect(next.returnValue).toBe("ran on the replacement");
		expect(crashing.terminated).toBe(true);
		expect(replacement.received[0]).toMatchObject({
			type: "init",
			payload: { mode: "attach", page: { kind: "owned", targetId: READY.targetId }, recover: false },
		});
		// The release closes the page omp owns and returns the browser hold.
		await releaseTab("eval", { kill: false });
		expect(browser.closedTargets).toEqual([READY.targetId]);
		expect(browser.handle.refCount).toBe(0);
	});

	it("closes the tab when the replacement generation dies again right away", async () => {
		const first = crashingWorker();
		const second = crashingWorker();
		queueSpawns([first, second]);

		const browser = makeBrowser();
		await acquireTab("eval", browser.handle, { timeoutMs: RUN_TIMEOUT_MS });
		const run = () => runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() });
		expect(await failureOf(run())).toContain("the tab is being reattached");
		expect(await failureOf(run())).toContain("again right after being replaced; tab closed");
		expect(await failureOf(run())).toContain("was killed: Browser tab worker failed");

		// The release joins the kill's teardown: no worker, page target, or hold survives.
		await releaseTab("eval", { kill: false });
		expect(getTabsMapForTest().has("eval")).toBe(false);
		expect(first.terminated).toBe(true);
		expect(second.terminated).toBe(true);
		expect(browser.closedTargets).toEqual([READY.targetId]);
		expect(browser.handle.refCount).toBe(0);
	});

	it("settles the run when a tool reply can no longer be delivered", async () => {
		const dying = new FakeProcessWorker((msg, worker) => {
			if (standardReplies(msg, worker)) return;
			if (msg.type !== "run") return;
			// The worker asks the host for a tool and dies before the answer
			// can be posted back. The run is now waiting on a reply nobody can
			// deliver.
			worker.emit({ type: "tool-call", id: "call-1", runId: msg.id, name: "read", args: {} });
			worker.drop();
		});
		queueSpawns([dying, servingWorker()]);

		await acquireTab("eval", makeBrowser().handle, { timeoutMs: RUN_TIMEOUT_MS });
		const started = Date.now();
		const failure = await failureOf(
			runInTab("eval", { code: "await read('AGENTS.md');", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() }),
		);

		expect(failure).toContain("Browser tab worker stopped accepting messages");
		expect(failure).toContain("the tab is being reattached");
		expect(Date.now() - started).toBeLessThan(RUN_TIMEOUT_MS);
		const next = await runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() });
		expect(next.returnValue).toBe("ran on the replacement");
	});

	it("ignores a late failure of a generation whose loss is already being recovered", async () => {
		const held = heldReplacement();
		const dying = new FakeProcessWorker((msg, worker) => {
			if (standardReplies(msg, worker)) return;
			if (msg.type !== "run") return;
			worker.emit({ type: "tool-call", id: "call-1", runId: msg.id, name: "read", args: {} });
			worker.drop();
		});
		queueSpawns([dying, held.worker]);

		try {
			await acquireTab("eval", makeBrowser().handle, { timeoutMs: RUN_TIMEOUT_MS });
			const failure = await failureOf(
				runInTab("eval", { code: "await read('AGENTS.md');", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() }),
			);
			expect(failure).toContain("Browser tab worker stopped accepting messages");
			await held.initStarted;
			// The lost generation's exit error lands while its replacement is still starting. Counted as a
			// second loss, it would read as a crash loop and close a tab that is recovering normally.
			dying.crash(new Error("Worker exited with code 0"));
			expect(getTabsMapForTest().get("eval")?.state).toBe("alive");
			held.release();

			const next = await runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() });
			expect(next.returnValue).toBe("ran on the replacement");
			expect(getTabsMapForTest().get("eval")?.state).toBe("alive");
		} finally {
			held.release();
		}
	});

	it("stops a replacement still starting when the tab is released", async () => {
		const crashing = crashingWorker();
		const held = heldReplacement();
		queueSpawns([crashing, held.worker]);

		const browser = makeBrowser();
		try {
			await acquireTab("eval", browser.handle, { timeoutMs: RUN_TIMEOUT_MS });
			const crash = await failureOf(
				runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() }),
			);
			expect(crash).toContain("the tab is being reattached");
			await held.initStarted;
			const waiting = failureOf(runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() }));

			const started = Date.now();
			await releaseTab("eval", { kill: false });
			// The replacement is gone when the release returns, not at its own init deadline.
			expect(held.worker.terminated).toBe(true);
			// A call waiting on the reattach settles with the closure instead of running anywhere.
			expect(await waiting).toContain("is not alive");
			expect(Date.now() - started).toBeLessThan(RUN_TIMEOUT_MS);
			expect(held.worker.kinds).toEqual(["init"]);
			expect(getTabsMapForTest().has("eval")).toBe(false);
			expect(browser.closedTargets).toEqual([READY.targetId]);
			expect(browser.handle.refCount).toBe(0);
		} finally {
			held.release();
		}
	});

	it("does not run a call whose budget the reattach used up", async () => {
		const crashing = crashingWorker();
		const held = heldReplacement();
		queueSpawns([crashing, held.worker]);

		try {
			await acquireTab("eval", makeBrowser().handle, { timeoutMs: RUN_TIMEOUT_MS });
			await failureOf(runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() }));
			await held.initStarted;
			const waiting = failureOf(runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() }));
			// The reattach finishes with only 10ms of the waiting call's budget left.
			const now = performance.now.bind(performance);
			const clock = spyOn(performance, "now").mockImplementation(() => now() + RUN_TIMEOUT_MS - 10);
			held.release();
			const failure = await waiting;
			clock.mockRestore();

			expect(failure).toContain(`used up this call's ${RUN_TIMEOUT_MS}ms budget, so the call was not run`);
			// Nothing was dispatched to the reattached generation, and the tab stays usable.
			expect(held.worker.kinds).toEqual(["init"]);
			const next = await runInTab("eval", { code: "1;", timeoutMs: RUN_TIMEOUT_MS, session: makeSession() });
			expect(next.returnValue).toBe("ran on the replacement");
		} finally {
			held.release();
		}
	});

	it("contains a worker crash that lands while a tool call is in flight", async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", onUncaught);

		const toolStarted = Promise.withResolvers<void>();
		const toolCancelled = Promise.withResolvers<string>();
		const crashing = new FakeProcessWorker((msg, worker) => {
			if (standardReplies(msg, worker)) return;
			if (msg.type !== "run") return;
			worker.emit({ type: "tool-call", id: "call-1", runId: msg.id, name: "read", args: {} });
		});
		// No replacement generation can start, so the reattach fails and closes the tab.
		queueSpawns([crashing]);

		// A host tool the worker asked for, still running when the worker dies.
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionId: () => "session-containment",
			getToolByName: () => ({
				name: "read",
				description: "Waits for the browser worker to cancel its host tool call.",
				parameters: type({}),
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
			// death, the host work it delegated is cancelled, the dead process is
			// gone, and the parent saw no uncaught exception.
			expect((failure as Error).message).toContain("Browser tab worker failed: Worker exited with code 134");
			expect(await toolCancelled.promise).toContain("Browser tab worker failed");
			expect(uncaught).toEqual([]);
			expect(crashing.terminated).toBe(true);

			// A subsequent call waits out the failed reattach and reports the closed tab instead of hanging.
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
