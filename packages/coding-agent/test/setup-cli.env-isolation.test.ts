import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSetupCommand } from "@oh-my-pi/pi-coding-agent/cli/setup-cli";
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

describe("setup CLI subprocess environment", () => {
	it("runs the Python probe with its runtime environment but no ambient service secrets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-setup-env-"));
		const capturePath = path.join(tempDir, "python-env.json");
		const pythonPath = path.join(tempDir, "python");
		const home = path.join(tempDir, "home");
		const pythonModulePath = path.join(tempDir, "python-modules");
		const testEnv = {
			PATH: tempDir,
			HOME: home,
			PYTHONPATH: pythonModulePath,
			...SECRET_ENV,
		};
		const saved = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));

		await Bun.write(
			pythonPath,
			`#!${process.execPath}\nawait Bun.write(${JSON.stringify(capturePath)}, JSON.stringify(process.env));\n`,
		);
		await fs.chmod(pythonPath, 0o755);
		Object.assign(process.env, testEnv);
		vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "python" ? pythonPath : null));
		vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await runSetupCommand({ component: "python", flags: { check: true, json: true } });
			const childEnv = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;

			expect(childEnv.PATH).toBe(tempDir);
			expect(childEnv.HOME).toBe(home);
			expect(childEnv.PYTHONPATH).toBe(pythonModulePath);
			expect(
				Object.keys(SECRET_ENV).filter(key => childEnv[key] !== undefined),
				"the Python setup probe must not receive ambient provider, database, JWT, or AgentDesk secrets",
			).toEqual([]);
		} finally {
			restoreEnv(saved);
			vi.restoreAllMocks();
			await removeWithRetries(tempDir);
		}
	});
});
