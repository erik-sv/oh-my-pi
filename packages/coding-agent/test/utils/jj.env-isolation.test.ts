import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const REPO_ENV = {
	GH_TOKEN: "gh-token-for-jj",
	GITHUB_TOKEN: "github-token-for-jj",
	GPG_TTY: "/dev/ttys009",
	SSH_AUTH_SOCK: "/tmp/omp-jj-ssh-agent.sock",
	SSH_AGENT_PID: "4242",
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

async function writeFakeJj(tempDir: string, capturePath: string): Promise<void> {
	const handler = [
		`await Bun.write(${JSON.stringify(capturePath)}, JSON.stringify(process.env));`,
		`process.stdout.write("diff --git a/file.txt b/file.txt\\n");`,
	].join("\n");
	if (process.platform === "win32") {
		const handlerPath = path.join(tempDir, "fake-jj.ts");
		await Bun.write(handlerPath, handler);
		await Bun.write(path.join(tempDir, "jj.cmd"), `@echo off\r\n"${process.execPath}" "${handlerPath}" %*\r\n`);
		return;
	}
	const jjPath = path.join(tempDir, "jj");
	await Bun.write(jjPath, `#!${process.execPath}\n${handler}\n`);
	await fs.chmod(jjPath, 0o755);
}

async function runDriver(
	driverPath: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const child = Bun.spawn([process.execPath, driverPath], {
		cwd: path.resolve(import.meta.dir, "../.."),
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

describe("jj subprocess environment", () => {
	it("retains repository runtime and authentication values without ambient service secrets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jj-env-"));
		const home = path.join(tempDir, "home");
		const capturePath = path.join(tempDir, "jj-env.json");
		const driverPath = path.join(tempDir, "jj-driver.mjs");
		await writeFakeJj(tempDir, capturePath);
		const jjModuleUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/utils/jj.ts")).href;
		await Bun.write(
			driverPath,
			[
				`import * as jj from ${JSON.stringify(jjModuleUrl)};`,
				`process.stdout.write(await jj.diff(${JSON.stringify(tempDir)}));`,
			].join("\n"),
		);

		try {
			const result = await runDriver(driverPath, {
				...process.env,
				PATH: tempDir,
				HOME: home,
				...REPO_ENV,
				...FORBIDDEN_ENV,
			} as Record<string, string>);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toBe("diff --git a/file.txt b/file.txt\n");
			const childEnv = JSON.parse(await fs.readFile(capturePath, "utf8")) as Record<string, string>;
			expect(childEnv.PATH).toBe(tempDir);
			expect(childEnv.HOME).toBe(home);
			for (const [key, value] of Object.entries(REPO_ENV)) expect(childEnv[key]).toBe(value);
			expect(
				Object.keys(FORBIDDEN_ENV).filter(key => childEnv[key] !== undefined),
				"jj must not receive provider, database, session, JWT, or AgentDesk secrets",
			).toEqual([]);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
