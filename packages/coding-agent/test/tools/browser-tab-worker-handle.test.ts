import { describe, expect, it } from "bun:test";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { spawnTabWorker } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker-host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
		getSessionId: () => "browser-process-isolation",
	} as unknown as ToolSession;
}

describe("tab worker subprocess lifetime", () => {
	it("closes through an acknowledged subprocess handshake", async () => {
		const worker = await spawnTabWorker();

		expect(worker.mode).toBe("process");
		expect(await worker.close()).toBe(true);
		expect(worker.alive).toBe(false);
		expect(worker.send({ type: "close" })).toBe(false);
		await worker.terminate();
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"contains a fatal worker exit and keeps the parent usable",
		async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			const failedName = `native-exit-${process.pid}-${Math.random().toString(36).slice(2)}`;
			const healthyName = `native-survivor-${process.pid}-${Math.random().toString(36).slice(2)}`;
			try {
				await acquireTab(failedName, browser, { timeoutMs: 10_000 });
				const failure = await runInTab(failedName, {
					code: "process.exit(134);",
					timeoutMs: 10_000,
					session: makeSession(),
				}).then(
					() => undefined,
					(error: unknown) => error,
				);
				expect((failure as Error).message).toContain("Browser tab worker exited with code 134");

				await acquireTab(healthyName, browser, { timeoutMs: 10_000 });
				const result = await runInTab(healthyName, {
					code: "return 6 * 7;",
					timeoutMs: 10_000,
					session: makeSession(),
				});
				expect(result.returnValue).toBe(42);
			} finally {
				await releaseTab(failedName, { kill: false }).catch(() => undefined);
				await releaseTab(healthyName, { kill: false }).catch(() => undefined);
				await releaseBrowser(browser, { kill: true }).catch(() => undefined);
			}
		},
		30_000,
	);
});
