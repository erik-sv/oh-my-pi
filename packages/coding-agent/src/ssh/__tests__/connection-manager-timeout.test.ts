/**
 * Regression for #4232: `runSshSync` / `runSshCaptureSync` sit on the
 * `ensureHostInfo` → `probeHostInfo` / `ensureConnection` path that runs before
 * `SshTool.execute` applies the user's command timeout. Previously they invoked
 * `ssh` through `$`ssh ${args}`.quiet().nothrow()` with no timeout and no
 * abort signal, so an unreachable host or wedged control-master hung forever.
 *
 * The contract now is: each helper is bounded by `timeoutMs`, aborts a stalled
 * child, and returns a failure result (`exitCode !== 0`, non-empty
 * `stderr`) instead of throwing or blocking.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { _sshHelpersForTests } from "../connection-manager";

interface SpawnOptions {
	env?: Record<string, string | undefined>;
}

const { runSshSync, runSshCaptureSync } = _sshHelpersForTests;

let binDir: string;
let originalPath: string | undefined;

beforeAll(async () => {
	binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-timeout-"));
	// Fake `ssh` that traps SIGTERM and sleeps far past any test bound.
	// Simulates a wedged control-master / unreachable host.
	const fake = path.join(binDir, "ssh");
	await fs.writeFile(fake, "#!/usr/bin/env bash\ntrap '' TERM\nsleep 300\n", { mode: 0o755 });
	originalPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
});

afterAll(async () => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	await fs.rm(binDir, { recursive: true, force: true });
});

describe("SSH pre-command helpers bound their own runtime (#4232)", () => {
	it("runSshSync returns a failure result within the timeout on a wedged host", async () => {
		const timeoutMs = 200;
		const started = Date.now();
		const result = await runSshSync(["-o", "BatchMode=yes", "unreachable", "true"], timeoutMs);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(5_000);
		// timeout → aborted child, so exit code is null (aborted) or non-zero.
		expect(result.exitCode).not.toBe(0);
	}, 10_000);

	it("runSshCaptureSync returns a failure result within the timeout on a wedged host", async () => {
		const timeoutMs = 200;
		const started = Date.now();
		const result = await runSshCaptureSync(["-o", "BatchMode=yes", "unreachable", "true"], timeoutMs);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(5_000);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
	}, 10_000);

	it("keeps the SSH agent socket but strips ambient secrets", async () => {
		const poisoned = {
			SSH_AUTH_SOCK: "/tmp/omp-test-agent.sock",
			ANTHROPIC_API_KEY: "ambient-provider-secret",
			DATABASE_URL: "postgres://ambient-storage-secret",
			AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
			JWT_SECRET: "ambient-jwt-secret",
			GENERIC_SERVICE_SECRET: "ambient-generic-secret",
		};
		const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
		Object.assign(process.env, poisoned);
		let spawnOptions: SpawnOptions | undefined;
		const empty = () => new Response("").body as ReadableStream<Uint8Array>;
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(((_cmd: string[], options?: SpawnOptions) => {
			spawnOptions = options;
			return {
				pid: 12345,
				stdout: empty(),
				stderr: empty(),
				exitCode: 0,
				exited: Promise.resolve(0),
				kill: () => true,
			} as unknown as Subprocess;
		}) as typeof Bun.spawn);

		try {
			const result = await runSshCaptureSync(["env-probe"], 2_000);

			expect(result.exitCode).toBe(0);
			expect(spawnOptions?.env).toEqual(expect.objectContaining({ SSH_AUTH_SOCK: "/tmp/omp-test-agent.sock" }));
			expect(spawnOptions?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(spawnOptions?.env).not.toHaveProperty("DATABASE_URL");
			expect(spawnOptions?.env).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
			expect(spawnOptions?.env).not.toHaveProperty("JWT_SECRET");
			expect(spawnOptions?.env).not.toHaveProperty("GENERIC_SERVICE_SECRET");
		} finally {
			spawn.mockRestore();
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
