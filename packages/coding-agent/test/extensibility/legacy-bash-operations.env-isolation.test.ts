import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type BashSpawnContext,
	createBashToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const BASH_RUNTIME_ENV = {
	GH_TOKEN: "gh-token-for-legacy-bash",
	GITHUB_TOKEN: "github-token-for-legacy-bash",
	GPG_TTY: "/dev/ttys007",
	SSH_AUTH_SOCK: "/tmp/omp-legacy-bash-ssh-agent.sock",
	SSH_AGENT_PID: "4444",
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

function restoreEnv(saved: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function expectLegacyBashEnv(childEnv: NodeJS.ProcessEnv, expectedPath: string, expectedHome: string): void {
	expect(childEnv.PATH).toBe(expectedPath);
	expect(childEnv.HOME).toBe(expectedHome);
	for (const [key, value] of Object.entries(BASH_RUNTIME_ENV)) expect(childEnv[key]).toBe(value);
	expect(
		Object.keys(FORBIDDEN_ENV).filter(key => childEnv[key] !== undefined),
		"legacy Bash extension seams must not receive provider, database, session, JWT, or AgentDesk secrets",
	).toEqual([]);
}

describe("legacy Bash operations environment", () => {
	it("sanitizes the spawn hook and injected exec environments while preserving explicit hook additions", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-bash-env-"));
		const home = path.join(tempDir, "home");
		const testEnv = { PATH: tempDir, HOME: home, ...BASH_RUNTIME_ENV, ...FORBIDDEN_ENV };
		const saved = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
		Object.assign(process.env, testEnv);
		let spawnHookEnv: NodeJS.ProcessEnv | undefined;
		let operationsEnv: NodeJS.ProcessEnv | undefined;

		try {
			const tool = createBashToolDefinition(tempDir, {
				spawnHook(context: BashSpawnContext): BashSpawnContext {
					spawnHookEnv = { ...context.env };
					return { ...context, env: { ...context.env, EXTENSION_EXPLICIT_VALUE: "from-spawn-hook" } };
				},
				operations: {
					async exec(_command, _cwd, options) {
						operationsEnv = { ...options.env };
						options.onData(Buffer.from("legacy operation complete"));
						return { exitCode: 0 };
					},
				},
			});
			const result = await tool.execute(
				"legacy-env-call",
				{ command: "status" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(result.content).toEqual([{ type: "text", text: "legacy operation complete" }]);
		} finally {
			restoreEnv(saved);
			await removeWithRetries(tempDir);
		}

		expect(spawnHookEnv).toBeDefined();
		expect(operationsEnv).toBeDefined();
		expectLegacyBashEnv(spawnHookEnv as NodeJS.ProcessEnv, tempDir, home);
		expectLegacyBashEnv(operationsEnv as NodeJS.ProcessEnv, tempDir, home);
		expect(spawnHookEnv?.EXTENSION_EXPLICIT_VALUE).toBeUndefined();
		expect(operationsEnv?.EXTENSION_EXPLICIT_VALUE).toBe("from-spawn-hook");
	});
});
