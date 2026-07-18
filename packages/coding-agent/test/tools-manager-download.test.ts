import { afterEach, describe, expect, it, vi } from "bun:test";
import { downloadFile, ensureTool } from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as piUtils from "@oh-my-pi/pi-utils";

function mockDownloadResponse(response: Response): void {
	const fetchMock: typeof globalThis.fetch = Object.assign(async () => response, {
		preconnect: globalThis.fetch.preconnect,
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

describe("tool asset downloads", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a completed response body to disk", async () => {
		using tempDir = piUtils.TempDir.createSync("@omp-tool-download-");
		const dest = tempDir.join("tool.bin");
		mockDownloadResponse(new Response("tool-bytes"));

		await downloadFile("https://example.test/tool.bin", dest);

		expect(await Bun.file(dest).text()).toBe("tool-bytes");
	});

	it("aborts a stalled response body and removes the partial file", async () => {
		using tempDir = piUtils.TempDir.createSync("@omp-tool-download-stall-");
		const dest = tempDir.join("tool.bin");
		const stalled = Promise.withResolvers<void>();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
			},
			pull() {
				stalled.resolve();
			},
		});
		mockDownloadResponse(new Response(body));
		const controller = new AbortController();

		const download = downloadFile("https://example.test/tool.bin", dest, controller.signal);
		await stalled.promise;
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));

		await expect(download).rejects.toThrow("Download timed out: https://example.test/tool.bin");
		expect(await Bun.file(dest).exists()).toBe(false);
	});
});

describe("Python tool installer environment", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes an explicit sanitized env to uv while preserving runtime paths", async () => {
		const poisoned = {
			ANTHROPIC_API_KEY: "ambient-provider-secret",
			DATABASE_URL: "postgres://ambient-storage-secret",
			AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
			JWT_SECRET: "ambient-jwt-secret",
			GENERIC_SERVICE_SECRET: "ambient-generic-secret",
		};
		const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
		Object.assign(process.env, poisoned);
		let trafilaturaLookups = 0;
		vi.spyOn(piUtils, "$which").mockImplementation(command => {
			if (command === "uv") return "/usr/bin/uv";
			if (command === "trafilatura") {
				trafilaturaLookups++;
				return trafilaturaLookups === 1 ? null : "/usr/bin/trafilatura";
			}
			return null;
		});
		let installOptions: { env?: Record<string, string | undefined> } | undefined;
		vi.spyOn(piUtils.ptree, "exec").mockImplementation(async (_command, options) => {
			installOptions = options;
			return { ok: true, stdout: "", stderr: "", exitCode: 0 } as never;
		});

		try {
			expect(await ensureTool("trafilatura", { silent: true })).toBe("/usr/bin/trafilatura");
			expect(installOptions?.env).toBeDefined();
			expect(installOptions?.env?.PATH).toBe(process.env.PATH);
			expect(installOptions?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(installOptions?.env).not.toHaveProperty("DATABASE_URL");
			expect(installOptions?.env).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
			expect(installOptions?.env).not.toHaveProperty("JWT_SECRET");
			expect(installOptions?.env).not.toHaveProperty("GENERIC_SERVICE_SECRET");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
