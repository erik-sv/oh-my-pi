import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isMounted } from "../sshfs-mount";

describe("isMounted", () => {
	it("detects a macOS mount point when mountpoint is unavailable", async () => {
		const parentPath = import.meta.dir;
		const mountPath = path.join(parentPath, "mounted");
		const stat = async (filePath: string) => ({ dev: filePath === mountPath ? 2 : 1 });

		await expect(isMounted(mountPath, { platform: "darwin", stat, which: () => null })).resolves.toBe(true);
	});

	it("keeps the SSH agent socket but strips ambient secrets from mount helpers", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sshfs-env-"));
		const mountpoint = path.join(tempDir, "mountpoint");
		const dump = path.join(tempDir, "env.txt");
		await fs.writeFile(mountpoint, `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(dump)}\nexit 1\n`, { mode: 0o755 });
		const poisoned = {
			SSH_AUTH_SOCK: "/tmp/omp-sshfs-agent.sock",
			ANTHROPIC_API_KEY: "ambient-provider-secret",
			DATABASE_URL: "postgres://ambient-storage-secret",
			AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
			JWT_SECRET: "ambient-jwt-secret",
			GENERIC_SERVICE_SECRET: "ambient-generic-secret",
		};
		const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
		Object.assign(process.env, poisoned);

		try {
			await expect(
				isMounted(path.join(tempDir, "not-mounted"), {
					platform: "linux",
					which: command => (command === "mountpoint" ? mountpoint : null),
				}),
			).resolves.toBe(false);
			const childEnv = Object.fromEntries(
				(await fs.readFile(dump, "utf8"))
					.trim()
					.split("\n")
					.map(line => {
						const separator = line.indexOf("=");
						return [line.slice(0, separator), line.slice(separator + 1)];
					}),
			) as Record<string, string>;

			expect(childEnv.SSH_AUTH_SOCK).toBe("/tmp/omp-sshfs-agent.sock");
			expect(childEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(childEnv).not.toHaveProperty("DATABASE_URL");
			expect(childEnv).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
			expect(childEnv).not.toHaveProperty("JWT_SECRET");
			expect(childEnv).not.toHaveProperty("GENERIC_SERVICE_SECRET");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
