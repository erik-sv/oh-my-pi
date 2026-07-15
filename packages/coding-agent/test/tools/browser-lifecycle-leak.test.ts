/**
 * Regression tests for issue #3963: the browser tool leaks Chromium/Puppeteer
 * resources at two termination boundaries.
 *
 * 1. An aborted `open` observes abort only in its `untilAborted` wrapper — the
 *    inner launch resolves in the background and `acquireBrowser` publishes
 *    the handle unconditionally, leaving a live browser at refCount:0 with no
 *    tab holding it. `releaseAllTabs` walks tabs, not browsers, so nothing
 *    ever reaps it.
 * 2. Browser + tab state lives in module-global maps. `AgentSession.dispose()`
 *    walks jobs, eval kernels, provider sessions, and MCP, but has no browser
 *    teardown hook, so any tabs the session opened outlive the session.
 *
 * The tests below cover both by driving `acquireBrowser` / `acquireTab` /
 * `releaseTabsForOwner` directly, with `CmuxSocketClient` prototype methods
 * spied so no real cmux socket / puppeteer process is needed.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as attach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	acquireBrowser,
	disposeAllBrowsers,
	getBrowsersMapForTest,
	holdBrowser,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { Process } from "@oh-my-pi/pi-natives";
import type { Subprocess } from "bun";
import type { Browser } from "puppeteer-core";

function makeKind(socketSuffix: string): CmuxKind {
	return { kind: "cmux", socketPath: `/tmp/omp-test-${socketSuffix}.sock`, surface: `surface-${socketSuffix}` };
}

async function drainAllTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

describe("browser lifecycle — aborted open must not leak a browser handle", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("disposes a cmux browser whose launch resolved after the caller aborted", async () => {
		const gate = Promise.withResolvers<void>();
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			await gate.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		try {
			const kind = makeKind("abort-orphan");
			const controller = new AbortController();
			const pending = acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal });
			// The reporter's scenario: abort fires while the launch is in flight.
			controller.abort();
			// The launch resolves *after* the abort has been observed by the caller.
			gate.resolve();

			await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			// The freshly-launched browser MUST be torn down before publication so it
			// does not sit at refCount:0 in the global map, leaking a live cmux socket
			// (or, for headless, a live Chromium process) that no `releaseAllTabs`
			// / `dropHeadlessTabs` walk would ever reap.
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});

	it("does not launch at all when the signal was already aborted", async () => {
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		try {
			const kind = makeKind("preaborted");
			const controller = new AbortController();
			controller.abort();
			await expect(acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal })).rejects.toBeInstanceOf(
				ToolAbortError,
			);
			// Not called: pre-abort short-circuit fires before openBrowserHandle.
			expect(connectSpy).not.toHaveBeenCalled();
			expect(closeSpy).not.toHaveBeenCalled();
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});
});

describe("browser lifecycle — session-scoped teardown reaps owned tabs", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("acquireTab records ownerSessionId and releaseTabsForOwner tears down only that session's tabs", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		let openCount = 0;
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					openCount++;
					return { surface_id: `surface-${openCount}`, url: "about:blank" };
				}
				if (method === "browser.wait") return {};
				if (method === "surface.close") return {};
				if (method === "browser.snapshot" || method === "browser.geometry") return {};
				if (method === "browser.eval") return {};
				return {};
			},
		);

		const kindA = makeKind("owner-a");
		const kindB = makeKind("owner-b");
		const browserA = await acquireBrowser(kindA, { cwd: "/tmp" });
		const browserB = await acquireBrowser(kindB, { cwd: "/tmp" });

		const tabA = await acquireTab("tab-a", browserA, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const tabB = await acquireTab("tab-b", browserB, { timeoutMs: 1_000, ownerSessionId: "session-B" });

		expect(tabA.tab.ownerSessionId).toBe("session-A");
		expect(tabB.tab.ownerSessionId).toBe("session-B");
		expect(getTabsMapForTest().size).toBe(2);

		// Dispose only session A. Session B's tab (and its browser) must survive
		// because a shared long-lived process may still be running under B.
		const released = await releaseTabsForOwner("session-A", { kill: false });
		expect(released).toBe(1);
		expect(getTabsMapForTest().has("tab-a")).toBe(false);
		expect(getTabsMapForTest().has("tab-b")).toBe(true);

		await releaseTabsForOwner("session-B", { kill: false });
		expect(getTabsMapForTest().size).toBe(0);
		expect(getBrowsersMapForTest().size).toBe(0);
	});

	it("acquireTab reusing an existing tab preserves the original owner", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-reuse", url: "about:blank" };
				return {};
			},
		);

		const kind = makeKind("reuse");
		const browser = await acquireBrowser(kind, { cwd: "/tmp" });

		const first = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const second = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-B" });

		expect(first.tab).toBe(second.tab);
		expect(second.created).toBe(false);
		// Reuse must NOT reassign ownership — a subagent re-driving an existing
		// tab shouldn't yank teardown responsibility from the session that opened it.
		expect(second.tab.ownerSessionId).toBe("session-A");

		// releaseTabsForOwner("session-B") is a no-op here — the tab belongs to A.
		const releasedB = await releaseTabsForOwner("session-B", { kill: false });
		expect(releasedB).toBe(0);
		expect(getTabsMapForTest().has("reuse-tab")).toBe(true);

		const releasedA = await releaseTabsForOwner("session-A", { kill: false });
		expect(releasedA).toBe(1);
		expect(getTabsMapForTest().has("reuse-tab")).toBe(false);
	});
});

describe("browser lifecycle — spawned app ownership controls process cleanup", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("kills a tool-spawned app exactly once while its final registry handle still exists", async () => {
		const executablePath = "/Applications/OMP Ownership Test.app/Contents/MacOS/OMP Ownership Test";
		const pid = 44_123;
		let connected = true;
		let disconnectCount = 0;
		let terminationCount = 0;
		let registeredDuringCleanup: boolean | undefined;
		let handleKey = "";
		const browser = {
			get connected() {
				return connected;
			},
			disconnect() {
				disconnectCount++;
				connected = false;
			},
		} as unknown as Browser;
		const child = { pid, unref() {} } as unknown as Subprocess;

		const reusableSpy = spyOn(attach, "findReusableCdp").mockResolvedValue(null);
		const killExistingSpy = spyOn(attach, "killExistingByPath").mockResolvedValue(0);
		const portSpy = spyOn(attach, "findFreeCdpPort").mockResolvedValue(9_333);
		const waitSpy = spyOn(attach, "waitForCdp").mockResolvedValue(undefined);
		const loadSpy = spyOn(launch, "loadPuppeteer").mockResolvedValue({ connect: async () => browser } as never);
		const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(child as never);
		const fromPidSpy = spyOn(Process, "fromPid").mockImplementation(() => {
			registeredDuringCleanup = getBrowsersMapForTest().has(handleKey);
			return {
				terminate: async () => {
					terminationCount++;
					return true;
				},
			} as never;
		});

		try {
			const handle = await acquireBrowser({ kind: "spawned", path: executablePath }, { cwd: "/tmp" });
			handleKey = handle.key;
			holdBrowser(handle);

			// Normal browser close releases with kill:false. Ownership of a child
			// spawned by this tool must still force process-tree cleanup.
			await releaseBrowser(handle, { kill: false });

			expect(disconnectCount).toBe(1);
			expect(fromPidSpy).toHaveBeenCalledTimes(1);
			expect(fromPidSpy).toHaveBeenCalledWith(pid);
			expect(terminationCount).toBe(1);
			expect(registeredDuringCleanup).toBe(true);
			expect(getBrowsersMapForTest().has(handleKey)).toBe(false);
		} finally {
			fromPidSpy.mockRestore();
			spawnSpy.mockRestore();
			loadSpy.mockRestore();
			waitSpy.mockRestore();
			portSpy.mockRestore();
			killExistingSpy.mockRestore();
			reusableSpy.mockRestore();
		}
	});

	it("disconnects a reused CDP app without killing its pre-existing process", async () => {
		const executablePath = "/Applications/OMP Reused Test.app/Contents/MacOS/OMP Reused Test";
		const pid = 55_321;
		let connected = true;
		let disconnectCount = 0;
		let terminationCount = 0;
		const browser = {
			get connected() {
				return connected;
			},
			disconnect() {
				disconnectCount++;
				connected = false;
			},
		} as unknown as Browser;

		const reusableSpy = spyOn(attach, "findReusableCdp").mockResolvedValue({
			cdpUrl: "http://127.0.0.1:9_444",
			pid,
		});
		const loadSpy = spyOn(launch, "loadPuppeteer").mockResolvedValue({ connect: async () => browser } as never);
		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("A reused CDP app must not be spawned again");
		});
		const fromPidSpy = spyOn(Process, "fromPid").mockImplementation(() => {
			return {
				terminate: async () => {
					terminationCount++;
					return true;
				},
			} as never;
		});

		try {
			const handle = await acquireBrowser({ kind: "spawned", path: executablePath }, { cwd: "/tmp" });
			holdBrowser(handle);

			await releaseBrowser(handle, { kill: false });

			expect(disconnectCount).toBe(1);
			expect(spawnSpy).not.toHaveBeenCalled();
			expect(fromPidSpy).not.toHaveBeenCalled();
			expect(terminationCount).toBe(0);
			expect(getBrowsersMapForTest().has(handle.key)).toBe(false);
		} finally {
			fromPidSpy.mockRestore();
			spawnSpy.mockRestore();
			loadSpy.mockRestore();
			reusableSpy.mockRestore();
		}
	});
});

describe("browser lifecycle — shutdown sweep reaps bare handles", () => {
	afterEach(async () => {
		await drainAllTabs();
		for (const handle of [...getBrowsersMapForTest().values()]) {
			holdBrowser(handle);
			await releaseBrowser(handle, { kill: true }).catch(() => undefined);
		}
	});

	it("closes a bare headless browser that was acquired without a tab", async () => {
		let connected = true;
		let closeCount = 0;
		const browser = {
			get connected() {
				return connected;
			},
			async close() {
				closeCount++;
				connected = false;
			},
		} as unknown as Browser;
		const launchSpy = spyOn(launch, "launchHeadlessBrowser").mockResolvedValue(browser);

		try {
			const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: "/tmp" });
			expect(getBrowsersMapForTest().has(handle.key)).toBe(true);

			await disposeAllBrowsers({ kill: true });

			expect(closeCount).toBe(1);
			expect(getBrowsersMapForTest().has(handle.key)).toBe(false);
		} finally {
			launchSpy.mockRestore();
		}
	});

	it("disconnects from a connected external browser without closing it", async () => {
		let connected = true;
		let disconnectCount = 0;
		let closeCount = 0;
		const browser = {
			get connected() {
				return connected;
			},
			disconnect() {
				disconnectCount++;
				connected = false;
			},
			async close() {
				closeCount++;
				connected = false;
			},
		} as unknown as Browser;
		const waitSpy = spyOn(attach, "waitForCdp").mockResolvedValue(undefined);
		const loadSpy = spyOn(launch, "loadPuppeteer").mockResolvedValue({ connect: async () => browser } as never);

		try {
			const handle = await acquireBrowser({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" }, { cwd: "/tmp" });

			await disposeAllBrowsers({ kill: true });

			expect(disconnectCount).toBe(1);
			expect(closeCount).toBe(0);
			expect(getBrowsersMapForTest().has(handle.key)).toBe(false);
		} finally {
			loadSpy.mockRestore();
			waitSpy.mockRestore();
		}
	});
});
