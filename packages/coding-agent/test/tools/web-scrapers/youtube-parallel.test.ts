import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as parallelModule from "@oh-my-pi/pi-coding-agent/web/parallel";
import { handleYouTube } from "@oh-my-pi/pi-coding-agent/web/scrapers/youtube";
import { ptree } from "@oh-my-pi/pi-utils";

describe("handleYouTube with Parallel extract", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		process.env.PARALLEL_API_KEY = "test-parallel-key";
		await Settings.init({ inMemory: true, overrides: { "providers.fetch": "auto" } });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
	});

	it("returns Parallel extract content before yt-dlp fallback", async () => {
		const ensureToolSpy = vi.spyOn(toolsManager, "ensureTool");
		vi.spyOn(parallelModule, "extractWithParallel").mockResolvedValue({
			requestId: "extract-youtube-1",
			results: [
				{
					url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
					title: "Video page",
					excerpts: [
						"Parallel summary for the video page that is comfortably longer than one hundred characters. ".repeat(
							2,
						),
					],
				},
			],
			errors: [],
			warnings: [],
			usage: [],
		});
		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10);
		expect(result?.method).toBe("parallel");
		expect(result?.finalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Parallel summary for the video page");
		expect(result?.notes).toContain("Used Parallel extract for YouTube");
		expect(ensureToolSpy).not.toHaveBeenCalled();
	});

	it("passes an explicit sanitized env to every yt-dlp child", async () => {
		delete process.env.PARALLEL_API_KEY;
		const poisoned = {
			ANTHROPIC_API_KEY: "ambient-provider-secret",
			KAGI_API_KEY: "ambient-fetch-provider-secret",
			DATABASE_URL: "postgres://ambient-storage-secret",
			AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
			JWT_SECRET: "ambient-jwt-secret",
			GENERIC_SERVICE_SECRET: "ambient-generic-secret",
		};
		const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
		Object.assign(process.env, poisoned);
		vi.spyOn(toolsManager, "ensureTool").mockResolvedValue("/usr/bin/yt-dlp");
		const childOptions: Array<{ env?: Record<string, string | undefined> }> = [];
		vi.spyOn(ptree, "exec").mockImplementation(async (command, options) => {
			if (!options) throw new Error("yt-dlp must receive explicit exec options");
			childOptions.push(options);
			return {
				ok: true,
				stdout: command.includes("--dump-json")
					? JSON.stringify({ title: "Env Test", channel: "OMP", duration: 42 })
					: "",
				stderr: "",
				exitCode: 0,
			} as never;
		});

		try {
			const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10);
			expect(result?.method).toBe("youtube");
			expect(childOptions).toHaveLength(2);
			for (const options of childOptions) {
				expect(options.env).toBeDefined();
				expect(options.env?.PATH).toBe(process.env.PATH);
				expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
				expect(options.env).not.toHaveProperty("KAGI_API_KEY");
				expect(options.env).not.toHaveProperty("DATABASE_URL");
				expect(options.env).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
				expect(options.env).not.toHaveProperty("JWT_SECRET");
				expect(options.env).not.toHaveProperty("GENERIC_SERVICE_SECRET");
			}
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
