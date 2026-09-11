/**
 * Regression test for the fatal browser abort crash.
 *
 * Incident: two `eval` cells drove `browser({action:"run"})`, the browser code
 * hung past its 60s budget, and the CLI died with
 * `InvalidStateError: Worker has been terminated`, thrown from
 * `postMessage` <- `send` <- the run's abort listener <- `IdleTimeout.#onExpire`.
 *
 * Mechanism: `runInTabWithSnapshot` registers an `abort` listener that posts
 * `{type:"abort", id}` to `tab.worker`, and only detaches it in the outer
 * `finally`, i.e. AFTER the supervisor has finished force-killing/recycling the
 * timed-out tab. Inside that window the worker has already been terminated, so
 * the listener posts to a dead worker. Bun's `Worker.postMessage` throws
 * `InvalidStateError` once the worker is terminated (verified on Bun 1.3.14),
 * and a throw from an abort listener is NOT delivered to whoever called
 * `abort()`. Bun reports it as an uncaught exception (also verified), which the
 * CLI's top-level handler turns into a fatal crash. The eval idle watchdog
 * aborts from a bare `setTimeout`, so there is no catch frame anywhere.
 *
 * Both invariants below describe one transition: "the grace timeout kills a
 * wedged tab while the cell's abort signal fires and the tab name is reopened".
 *   1. Cancellation is scoped to the run's own worker generation and detached
 *      before teardown, so an abort can never post to a terminated worker.
 *   2. Teardown evicts only its own registry entry, so a tab reopened under the
 *      same name while the kill is still unwinding survives.
 *
 * The tab is published into the supervisor's registry instead of opening real
 * Chromium + `Worker`, but everything under test (`runInTab`, the grace race,
 * `forceKillTab`, `releaseTab`) is production code, and the fake worker
 * reproduces Bun's real post-terminate contract.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	getTabsMapForTest,
	releaseTab,
	runInTab,
	type TabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const READY: ReadyInfo = {
	url: "about:blank",
	viewport: { width: 800, height: 600 },
	targetId: "target-wedged",
};

// The accessor hands out a ReadonlyMap; the fixture needs the live handle to
// publish synthetic tabs the way `acquireTab` would.
const registry = getTabsMapForTest() as Map<string, TabSession>;

let workerSeq = 0;

/**
 * Stands in for one subprocess generation. `send` deliberately preserves the
 * old terminated-worker throw so this regression proves stale cancellation is
 * never dispatched to a dead generation.
 */
class FakeTabWorker {
	readonly mode = "process" as const;
	readonly id = ++workerSeq;
	readonly received: WorkerInbound[] = [];
	#terminated = false;
	#handlers = new Set<(msg: WorkerOutbound) => void>();

	get alive(): boolean {
		return !this.#terminated;
	}

	send(msg: WorkerInbound): boolean {
		if (this.#terminated) throw new DOMException("Worker has been terminated", "InvalidStateError");
		this.received.push(msg);
		// Answer the close handshake so `releaseTab` does not sit out its grace
		// window during teardown.
		if (msg.type === "close") queueMicrotask(() => this.#emit({ type: "closed" }));
		return true;
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	onError(): () => void {
		return () => undefined;
	}
	async close(): Promise<boolean> {
		if (this.#terminated) return false;
		this.send({ type: "close" });
		await Promise.resolve();
		await this.terminate();
		return true;
	}

	async terminate(): Promise<void> {
		this.#terminated = true;
	}

	#emit(msg: WorkerOutbound): void {
		for (const handler of this.#handlers) handler(msg);
	}
}

/**
 * Headless-shaped browser handle whose browser-level CDP session blocks until
 * the test releases it: `forceKillTab`'s orphan-target close goes through
 * `closeCdpTarget`, so that session is the window in which the supervisor holds
 * an already terminated worker, exactly where the incident's abort landed.
 */
function makeGatedBrowser(): {
	handle: PuppeteerBrowserHandle;
	/** Resolves once `forceKillTab` reaches the orphan-target CDP close. */
	entered: Promise<void>;
	release(): void;
} {
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const browserTarget = {
		async createCDPSession(): Promise<never> {
			entered.resolve();
			await gate.promise;
			// `closeCdpTarget` treats a failed session as "not confirmed closed".
			throw new Error("browser CDP session unavailable");
		},
	};
	// Only the members the supervisor's headless teardown touches exist here;
	// a real puppeteer Browser cannot be constructed without Chromium.
	const handle = {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		refCount: 0,
		stealth: { browserSession: null, override: null },
		browser: {
			connected: false,
			wsEndpoint: () => "ws://127.0.0.1/devtools/browser/fake",
			target: () => browserTarget,
			targets: () => [],
		},
	} as unknown as PuppeteerBrowserHandle;
	return { handle, entered: entered.promise, release: () => gate.resolve() };
}

function publishTab(name: string, browser: PuppeteerBrowserHandle, worker: FakeTabWorker): TabSession {
	// Mirrors the session `acquireTab` builds, minus the real worker/browser.
	const tab = {
		name,
		browser,
		targetId: READY.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info: READY,
		pending: new Map(),
		kindTag: "headless",
		activateForScreenshot: true,
	} as unknown as TabSession;
	browser.refCount++;
	registry.set(name, tab);
	return tab;
}

describe("browser tab-supervisor: abort during force-kill", () => {
	afterEach(async () => {
		for (const name of registry.keys()) {
			await releaseTab(name, { kill: false }).catch(() => undefined);
		}
	});

	it("keeps a cell abort off the terminated worker and preserves a tab reopened during the kill", async () => {
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};
		process.on("uncaughtException", onUncaught);

		const browser = makeGatedBrowser();
		const wedged = new FakeTabWorker();
		const tab = publishTab("eval", browser.handle, wedged);
		// Stands in for the eval cell's `IdleTimeout` controller.
		const idle = new AbortController();
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: { get: () => undefined },
			getSessionFile: () => null,
			getSessionId: () => "session-abort-during-kill",
		} as unknown as ToolSession;

		try {
			// The worker never answers, so the supervisor's grace race
			// (timeoutMs + 750ms) fires and force-kills the tab.
			const run = runInTab("eval", { code: "await wait(60_000);", timeoutMs: 1, signal: idle.signal, session });
			const settled = run.then(
				() => undefined,
				(error: unknown) => error,
			);

			await browser.entered;
			// The kill has terminated the worker and is now unwinding. Two things
			// race with it in production: the cell's idle watchdog expiring, and
			// another caller reopening the same tab name.
			const replacement = new FakeTabWorker();
			const reopened = publishTab("eval", browser.handle, replacement);
			idle.abort(new DOMException("Idle for 60s", "TimeoutError"));
			browser.release();

			const failure = await settled;
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toBe("Browser code execution hung past grace; tab killed");

			// 1. The abort never reached a terminated worker, so nothing was
			//    reported as an uncaught exception (the fatal crash), and the
			//    replacement generation never saw the dead run's cancellation.
			expect(uncaught).toEqual([]);
			expect(replacement.received).toEqual([]);

			// 2. Registry and pending state stay consistent: the killed tab settled
			//    its runs and teardown evicted only its own entry.
			expect(tab.pending.size).toBe(0);
			expect(registry.get("eval")).toBe(reopened);
		} finally {
			browser.release();
			process.removeListener("uncaughtException", onUncaught);
		}
	});
});
