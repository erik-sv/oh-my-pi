import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const PROVIDER_CREDENTIALS = {
	ANTHROPIC_API_KEY: "anthropic-key-for-config-command",
	OPENAI_API_KEY: "openai-key-for-config-command",
} as const;

const FORBIDDEN_ENV = {
	DATABASE_URL: "postgres://ambient-database-secret",
	OMP_SESSION_DB_URL: "postgres://ambient-session-secret",
	OMP_SESSION_DB_PASSWORD: "ambient-session-password",
	SESSION_SECRET: "ambient-session-cookie-secret",
	JWT_SECRET: "ambient-jwt-secret",
	JWT_SIGNING_KEY: "ambient-jwt-signing-key",
	AGENTDESK_API_KEY: "ambient-agentdesk-secret",
	AGENTDESK_CONTROL_TOKEN: "ambient-agentdesk-control-secret",
} as const;

function shellQuote(value: string): string {
	if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`;
	return `'${value.replaceAll("'", `'"'"'`)}'`;
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

describe("config shell-value command environment", () => {
	it("retains provider credentials but denies database, session, JWT, and AgentDesk secrets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-value-env-"));
		const probePath = path.join(tempDir, "print-env.ts");
		const driverPath = path.join(tempDir, "config-driver.mjs");
		await Bun.write(probePath, "process.stdout.write(JSON.stringify(process.env));\n");
		const resolverUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/config/resolve-config-value.ts")).href;
		const command = `!${shellQuote(process.execPath)} ${shellQuote(probePath)}`;
		await Bun.write(
			driverPath,
			[
				`import { resolveConfigValue } from ${JSON.stringify(resolverUrl)};`,
				`const resolved = await resolveConfigValue(${JSON.stringify(command)});`,
				`if (resolved === undefined) throw new Error("config command returned no output");`,
				`process.stdout.write(resolved);`,
			].join("\n"),
		);

		try {
			const result = await runDriver(driverPath, {
				...process.env,
				...PROVIDER_CREDENTIALS,
				...FORBIDDEN_ENV,
			} as Record<string, string>);
			expect(result.code, result.stderr).toBe(0);
			const childEnv = JSON.parse(result.stdout) as Record<string, string>;
			expect(childEnv.ANTHROPIC_API_KEY).toBe(PROVIDER_CREDENTIALS.ANTHROPIC_API_KEY);
			expect(childEnv.OPENAI_API_KEY).toBe(PROVIDER_CREDENTIALS.OPENAI_API_KEY);
			expect(
				Object.keys(FORBIDDEN_ENV).filter(key => childEnv[key] !== undefined),
				"config commands must not receive database, session, JWT, or AgentDesk secrets",
			).toEqual([]);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
