import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureGalleryScreenshots } from "@oh-my-pi/pi-coding-agent/cli/gallery-screenshot";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const SECRET_ENV = {
	OPENAI_API_KEY: "ambient-openai-secret",
	ANTHROPIC_API_KEY: "ambient-anthropic-secret",
	DATABASE_URL: "postgres://ambient-database-secret",
	OMP_SESSION_DB_URL: "postgres://ambient-session-secret",
	OMP_SESSION_DB_PASSWORD: "ambient-session-password",
	JWT_SECRET: "ambient-jwt-secret",
	JWT_SIGNING_KEY: "ambient-jwt-signing-key",
	AGENTDESK_API_KEY: "ambient-agentdesk-secret",
	AGENTDESK_CONTROL_TOKEN: "ambient-agentdesk-control-secret",
} as const;

function restoreEnv(saved: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");
});

describe("gallery screenshot subprocess environment", () => {
	it("runs VHS with its desktop environment but no ambient service secrets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gallery-env-"));
		const capturePath = path.join(tempDir, "vhs-env.json");
		const outputPath = path.join(tempDir, "gallery.png");
		const vhsPath = path.join(tempDir, "vhs");
		const home = path.join(tempDir, "home");
		const waylandDisplay = "wayland-omp-gallery-test";
		const testEnv = {
			PATH: tempDir,
			HOME: home,
			WAYLAND_DISPLAY: waylandDisplay,
			...SECRET_ENV,
		};
		const saved = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));

		await Bun.write(
			vhsPath,
			`#!${process.execPath}\nawait Bun.write(${JSON.stringify(capturePath)}, JSON.stringify(process.env));\nawait Bun.write(${JSON.stringify(outputPath)}, "png");\n`,
		);
		await fs.chmod(vhsPath, 0o755);
		Object.assign(process.env, testEnv);
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "vhs" ? vhsPath : null));

		try {
			const outputs = await captureGalleryScreenshots([{ heading: "bash", lines: ["bash", "done"] }], {
				width: 80,
				out: outputPath,
			});
			const childEnv = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;

			expect(outputs).toEqual([outputPath]);
			expect(childEnv.PATH).toBe(tempDir);
			expect(childEnv.HOME).toBe(home);
			expect(childEnv.WAYLAND_DISPLAY).toBe(waylandDisplay);
			expect(
				Object.keys(SECRET_ENV).filter(key => childEnv[key] !== undefined),
				"the VHS renderer must not receive ambient provider, database, JWT, or AgentDesk secrets",
			).toEqual([]);
		} finally {
			restoreEnv(saved);
			vi.restoreAllMocks();
			await removeWithRetries(tempDir);
		}
	});
});
