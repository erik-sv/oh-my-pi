import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	launchHeadlessBrowser,
	loadPuppeteer,
	stealthIgnoreDefaultArgsForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { Subprocess } from "bun";

interface SpawnOptions {
	env?: Record<string, string | undefined>;
}

const AUTOMATION_FLAG = "--enable-automation";

const EDGE_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge-stable",
] as const;

const CHROME_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
] as const;

describe("browser launch stealth defaults", () => {
	it("keeps Puppeteer's automation default for Microsoft Edge executables", () => {
		for (const executablePath of EDGE_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).not.toContain(AUTOMATION_FLAG);
			expect(ignoreDefaultArgs).toContain("--disable-extensions");
		}
	});

	it("continues filtering Puppeteer's automation default for Chrome and Chromium executables", () => {
		for (const executablePath of CHROME_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).toContain(AUTOMATION_FLAG);
		}
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("browser child environment isolation", () => {
	const ambient = {
		DISPLAY: ":77",
		XDG_RUNTIME_DIR: "/tmp/omp-browser-runtime",
		ANTHROPIC_API_KEY: "ambient-provider-secret",
		DATABASE_URL: "postgres://ambient-storage-secret",
		AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
		JWT_SECRET: "ambient-jwt-secret",
		GENERIC_SERVICE_SECRET: "ambient-generic-secret",
	};

	it("launches headless Chromium with display/session values but no ambient secrets", async () => {
		const saved = Object.fromEntries(Object.keys(ambient).map(key => [key, process.env[key]]));
		Object.assign(process.env, ambient);
		const puppeteer = await loadPuppeteer();
		const launch = vi.spyOn(puppeteer, "launch").mockResolvedValue({} as never);

		try {
			await launchHeadlessBrowser({ headless: true });
			const options = launch.mock.calls[0]?.[0];

			expect(options?.env).toEqual(
				expect.objectContaining({ DISPLAY: ":77", XDG_RUNTIME_DIR: "/tmp/omp-browser-runtime" }),
			);
			expect(options?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(options?.env).not.toHaveProperty("DATABASE_URL");
			expect(options?.env).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
			expect(options?.env).not.toHaveProperty("JWT_SECRET");
			expect(options?.env).not.toHaveProperty("GENERIC_SERVICE_SECRET");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("launches a browser app with display/session values but no ambient secrets", async () => {
		const saved = Object.fromEntries(Object.keys(ambient).map(key => [key, process.env[key]]));
		Object.assign(process.env, ambient);
		const appPath = "/Applications/OMP Env Test.app/Contents/MacOS/OMP Env Test";
		const controller = new AbortController();
		const originalSpawn = Bun.spawn;
		let appOptions: SpawnOptions | undefined;
		vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: SpawnOptions) => {
			if (Array.isArray(cmd) && cmd[0] === appPath) {
				appOptions = options;
				controller.abort(new DOMException("captured browser app launch", "AbortError"));
				return {
					pid: 2_147_483_000,
					exited: new Promise<number>(() => {}),
					unref() {},
					kill: () => true,
				} as unknown as Subprocess;
			}
			return originalSpawn(cmd, options as never);
		}) as typeof Bun.spawn);

		try {
			await expect(
				acquireBrowser(
					{ kind: "spawned", path: appPath },
					{ cwd: process.cwd(), appArgs: ["--profile-directory=OMP"], signal: controller.signal },
				),
			).rejects.toThrow(/aborted/i);

			expect(appOptions?.env).toEqual(
				expect.objectContaining({ DISPLAY: ":77", XDG_RUNTIME_DIR: "/tmp/omp-browser-runtime" }),
			);
			expect(appOptions?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(appOptions?.env).not.toHaveProperty("DATABASE_URL");
			expect(appOptions?.env).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
			expect(appOptions?.env).not.toHaveProperty("JWT_SECRET");
			expect(appOptions?.env).not.toHaveProperty("GENERIC_SERVICE_SECRET");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
