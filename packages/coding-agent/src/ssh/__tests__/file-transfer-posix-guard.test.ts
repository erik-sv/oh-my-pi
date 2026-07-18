import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Subprocess } from "bun";
import type { SSHConnectionTarget } from "../connection-manager";
import * as connectionManager from "../connection-manager";
import { listRemoteDir, readRemoteFile, statRemotePath, writeRemoteFile } from "../file-transfer";

interface SpawnOptions {
	env?: Record<string, string | undefined>;
}

describe("ssh file-transfer POSIX guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects a confirmed Windows remote before running any POSIX command", async () => {
		// Stub BOTH the connection and the host-info probe so the guard is reached
		// without opening a real SSH connection and before any command is spawned.
		const ensureConnectionSpy = vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		const ensureHostInfoSpy = vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "windows",
			shell: "powershell",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "winbox", host: "winbox" };
		await expect(readRemoteFile(target, "C:/x.txt", { maxBytes: 1024 })).rejects.toThrow(/Windows host/);
		await expect(writeRemoteFile(target, "C:/x.txt", new Uint8Array([1]), {})).rejects.toThrow(/Windows host/);
		// Prove the guard ran through the stubbed transport rather than failing early
		// for an unrelated reason (e.g. a future import refactor bypassing the mocks).
		expect(ensureConnectionSpy).toHaveBeenCalled();
		expect(ensureHostInfoSpy).toHaveBeenCalled();
	});

	it("rejects a non-Windows remote with no verified transferShell", async () => {
		// No transferShell means the capability probe never confirmed any of
		// sh/bash/zsh works. The guard refuses regardless of `shell` because the
		// real ssh:// contract is "did we verify a POSIX shell works", not
		// "what name did the login shell self-report" (#3719).
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "unknown",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "noshell", host: "noshell" };
		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/no verified POSIX shell/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(
			/no verified POSIX shell/,
		);
	});

	it("dispatches transfer commands through the verified transferShell, not the login shell", async () => {
		// The bug fix: if the login shell is fish/csh/tcsh, the legacy guard
		// would refuse the host — but allowing it isn't enough on its own.
		// OpenSSH still hands our snippets to `$SHELL -c`, so a fish login
		// shell would choke on `if [ … ]; then …`. Every transfer command
		// must be wrapped in `<transferShell> -c '…'` to force parsing
		// under the shell we verified can run it (#3719).
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			// Login shell is fish; only `transferShell` indicates a working POSIX shell.
			shell: "unknown",
			transferShell: "bash",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "fishbox", host: "fishbox" };

		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(/stop-before-spawn/);
		await expect(statRemotePath(target, "/etc/hosts")).rejects.toThrow(/stop-before-spawn/);
		await expect(listRemoteDir(target, "/etc")).rejects.toThrow(/stop-before-spawn/);

		// Each dispatch must start with `bash -c '…'` and embed the original
		// POSIX snippet inside the quoted command. Read also drops `-n`
		// (allowStdin: true) because cat-staging needs stdin streaming.
		const dispatches = buildSpy.mock.calls.map(call => call[1] as string);
		expect(dispatches[0]).toMatch(/^bash -c '.*head -c 1025/);
		expect(dispatches[1]).toMatch(/^bash -c '.*cat > /);
		expect(buildSpy.mock.calls[1]?.[2]).toMatchObject({ allowStdin: true });
		expect(dispatches[2]).toMatch(/^bash -c '.*if \[ -d /);
		expect(dispatches[3]).toMatch(/^bash -c '.*LC_ALL=C ls -1Ap /);
	});

	it("uses sh -c when transferShell is sh (the most universal POSIX fallback)", async () => {
		// Belt-and-suspenders: the common happy path with a sh-family login
		// shell still routes through `sh -c` to keep one dispatch shape.
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "sh",
			transferShell: "sh",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "shbox", host: "shbox" };

		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		expect(buildSpy.mock.calls[0]?.[1]).toMatch(/^sh -c '.*head -c 1025/);
	});

	it("keeps the SSH agent socket but strips ambient secrets from file-transfer children", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "sh",
			transferShell: "sh",
			compatEnabled: false,
		});
		vi.spyOn(connectionManager, "buildRemoteCommand").mockResolvedValue(["test-host", "sh -c 'cat'"]);
		const poisoned = {
			SSH_AUTH_SOCK: "/tmp/omp-transfer-agent.sock",
			ANTHROPIC_API_KEY: "ambient-provider-secret",
			DATABASE_URL: "postgres://ambient-storage-secret",
			AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
			JWT_SECRET: "ambient-jwt-secret",
			GENERIC_SERVICE_SECRET: "ambient-generic-secret",
		};
		const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
		Object.assign(process.env, poisoned);
		let spawnOptions: SpawnOptions | undefined;
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(((_cmd: string[], options?: SpawnOptions) => {
			spawnOptions = options;
			return {
				pid: 12345,
				stdout: new Response("ok").body,
				stderr: new Response("").body,
				exitCode: 0,
				exited: Promise.resolve(0),
				kill: () => true,
			} as unknown as Subprocess;
		}) as typeof Bun.spawn);

		try {
			const result = await readRemoteFile({ name: "env-host", host: "env-host" }, "/tmp/value", {
				maxBytes: 32,
			});
			expect(new TextDecoder().decode(result.bytes)).toBe("ok");
			expect(spawnOptions?.env).toEqual(expect.objectContaining({ SSH_AUTH_SOCK: "/tmp/omp-transfer-agent.sock" }));
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
