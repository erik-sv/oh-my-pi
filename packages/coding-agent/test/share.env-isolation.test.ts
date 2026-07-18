import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const GITHUB_CREDENTIALS = {
	GH_TOKEN: "gh-token-for-share",
	GITHUB_TOKEN: "github-token-for-share",
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

async function writeFakeGh(tempDir: string, authCapturePath: string, gistCapturePath: string): Promise<void> {
	const handler = [
		`const args = process.argv.slice(2);`,
		`const target = args[0] === "auth" ? ${JSON.stringify(authCapturePath)} : ${JSON.stringify(gistCapturePath)};`,
		`await Bun.write(target, JSON.stringify(process.env));`,
		`if (args[0] === "gist") console.log("https://gist.github.com/0123456789abcdef0123456789abcdef");`,
	].join("\n");

	if (process.platform === "win32") {
		const handlerPath = path.join(tempDir, "fake-gh.ts");
		await Bun.write(handlerPath, handler);
		await Bun.write(path.join(tempDir, "gh.cmd"), `@echo off\r\n"${process.execPath}" "${handlerPath}" %*\r\n`);
		return;
	}

	const ghPath = path.join(tempDir, "gh");
	await Bun.write(ghPath, `#!${process.execPath}\n${handler}\n`);
	await fs.chmod(ghPath, 0o755);
}

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

function expectRepoToolEnv(childEnv: Record<string, string>, expectedPath: string, expectedHome: string): void {
	expect(childEnv.PATH).toBe(expectedPath);
	expect(childEnv.HOME).toBe(expectedHome);
	expect(childEnv.GH_TOKEN).toBe(GITHUB_CREDENTIALS.GH_TOKEN);
	expect(childEnv.GITHUB_TOKEN).toBe(GITHUB_CREDENTIALS.GITHUB_TOKEN);
	expect(
		Object.keys(FORBIDDEN_ENV).filter(key => childEnv[key] !== undefined),
		"GitHub CLI must not receive provider, database, session, JWT, or AgentDesk secrets",
	).toEqual([]);
}

describe("share GitHub CLI environment", () => {
	it("isolates both authentication and gist creation subprocesses to GitHub credentials and runtime values", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-share-env-"));
		const home = path.join(tempDir, "home");
		const authCapturePath = path.join(tempDir, "auth-env.json");
		const gistCapturePath = path.join(tempDir, "gist-env.json");
		const driverPath = path.join(tempDir, "share-driver.mjs");
		await writeFakeGh(tempDir, authCapturePath, gistCapturePath);
		const shareModuleUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/export/share.ts")).href;
		await Bun.write(
			driverPath,
			[
				`import { shareSession } from ${JSON.stringify(shareModuleUrl)};`,
				`const timestamp = "2026-07-18T00:00:00.000Z";`,
				`const entry = { type: "message", id: "message-1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "share environment boundary" }] } };`,
				`const manager = { getHeader: () => ({ type: "session", version: 3, id: "share-env-test", timestamp, cwd: "/tmp" }), getEntries: () => [entry], getLeafId: () => entry.id };`,
				`const result = await shareSession(manager, { store: "gist" });`,
				`process.stdout.write(result.method);`,
			].join("\n"),
		);

		try {
			const result = await runDriver(driverPath, {
				...process.env,
				PATH: tempDir,
				HOME: home,
				...GITHUB_CREDENTIALS,
				...FORBIDDEN_ENV,
			} as Record<string, string>);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toBe("gist");
			const authEnv = JSON.parse(await fs.readFile(authCapturePath, "utf8")) as Record<string, string>;
			const gistEnv = JSON.parse(await fs.readFile(gistCapturePath, "utf8")) as Record<string, string>;
			expectRepoToolEnv(authEnv, tempDir, home);
			expectRepoToolEnv(gistEnv, tempDir, home);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
