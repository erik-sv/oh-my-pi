import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const EXTENSION_RUNTIME_ENV = {
	GH_TOKEN: "gh-token-for-extension",
	GITHUB_TOKEN: "github-token-for-extension",
	GPG_TTY: "/dev/ttys008",
	SSH_AUTH_SOCK: "/tmp/omp-extension-ssh-agent.sock",
	SSH_AGENT_PID: "4343",
} as const;

const FORBIDDEN_ENV = {
	ANTHROPIC_API_KEY: "ambient-anthropic-secret",
	OPENAI_API_KEY: "ambient-openai-secret",
	DATABASE_URL: "postgres://ambient-database-secret",
	OMP_SESSION_DB_URL: "postgres://ambient-session-secret",
	OMP_SESSION_DB_PASSWORD: "ambient-session-password",
	SESSION_SECRET: "ambient-session-cookie-secret",
	JWT_SECRET: "ambient-jwt-secret",
	JWT_SIGNING_KEY: "ambient-jwt-signing-key",
	AGENTDESK_API_KEY: "ambient-agentdesk-secret",
	AGENTDESK_CONTROL_TOKEN: "ambient-agentdesk-control-secret",
} as const;

async function runDriver(
	driverPath: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const child = Bun.spawn([process.execPath, driverPath], {
		cwd: path.resolve(import.meta.dir, ".."),
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

describe("extension command subprocess environment", () => {
	it("retains repository and SSH runtime values without ambient service secrets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-exec-env-"));
		const home = path.join(tempDir, "home");
		const probePath = path.join(tempDir, "print-env.ts");
		const driverPath = path.join(tempDir, "exec-driver.mjs");
		await Bun.write(probePath, "process.stdout.write(JSON.stringify(process.env));\n");
		const execModuleUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/exec/exec.ts")).href;
		await Bun.write(
			driverPath,
			[
				`import { execCommand } from ${JSON.stringify(execModuleUrl)};`,
				`const result = await execCommand(process.execPath, [${JSON.stringify(probePath)}], ${JSON.stringify(tempDir)});`,
				`if (result.code !== 0) throw new Error(result.stderr || "extension command failed");`,
				`process.stdout.write(result.stdout);`,
			].join("\n"),
		);

		try {
			const result = await runDriver(driverPath, {
				...process.env,
				PATH: tempDir,
				HOME: home,
				...EXTENSION_RUNTIME_ENV,
				...FORBIDDEN_ENV,
			} as Record<string, string>);
			expect(result.code, result.stderr).toBe(0);
			const childEnv = JSON.parse(result.stdout) as Record<string, string>;
			expect(childEnv.PATH).toBe(tempDir);
			expect(childEnv.HOME).toBe(home);
			for (const [key, value] of Object.entries(EXTENSION_RUNTIME_ENV)) expect(childEnv[key]).toBe(value);
			expect(
				Object.keys(FORBIDDEN_ENV).filter(key => childEnv[key] !== undefined),
				"extension commands must not receive provider, database, session, JWT, or AgentDesk secrets",
			).toEqual([]);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
