import { afterEach, describe, expect, test, vi } from "bun:test";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import type { Subprocess } from "bun";

interface SpawnOptions {
	env?: Record<string, string | undefined>;
}

const POISONED_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	SSH_AUTH_SOCK: "/tmp/omp-test-ssh-agent.sock",
	SSH_AGENT_PID: "4242",
	OPENAI_API_KEY: "ambient-openai-secret",
	ANTHROPIC_API_KEY: "ambient-anthropic-secret",
	DATABASE_URL: "postgres://ambient-database-secret",
	OMP_SESSION_DB_URL: "postgres://ambient-session-secret",
	OMP_SESSION_DB_OPTIONS: "ambient-session-options",
	JWT_SECRET: "ambient-jwt-secret",
	AGENTDESK_API_KEY: "ambient-agentdesk-secret",
	AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
} as const;

const savedEnv = Object.fromEntries(Object.keys(POISONED_ENV).map(key => [key, process.env[key]]));

afterEach(() => {
	vi.restoreAllMocks();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("auth-broker remote login environment", () => {
	test("SSH keeps path and agent access without inheriting provider, storage, JWT, or control-plane secrets", async () => {
		Object.assign(process.env, POISONED_ENV);
		let spawnOptions: SpawnOptions | undefined;
		vi.spyOn(Bun, "spawn").mockImplementation(((options: SpawnOptions) => {
			spawnOptions = options;
			return {
				exitCode: 0,
				exited: Promise.resolve(0),
			} as unknown as Subprocess;
		}) as typeof Bun.spawn);

		await runAuthBrokerCommand({
			action: "login",
			flags: { provider: "anthropic", via: "agent@example.test" },
		});

		const childEnv = { ...(spawnOptions?.env ?? Bun.env) } as Record<string, string | undefined>;
		expect(childEnv.PATH).toBe(POISONED_ENV.PATH);
		expect(childEnv.SSH_AUTH_SOCK).toBe(POISONED_ENV.SSH_AUTH_SOCK);
		expect(childEnv.SSH_AGENT_PID).toBe(POISONED_ENV.SSH_AGENT_PID);
		for (const key of [
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"DATABASE_URL",
			"OMP_SESSION_DB_URL",
			"OMP_SESSION_DB_OPTIONS",
			"JWT_SECRET",
			"AGENTDESK_API_KEY",
			"AGENTDESK_CONTROL_TOKEN",
		]) {
			expect(childEnv[key], `${key} must not cross the remote SSH boundary`).toBeUndefined();
		}
		expect(spawnOptions?.env).toBeDefined();
	});
});
