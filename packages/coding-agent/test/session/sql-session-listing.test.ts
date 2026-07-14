import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listAllSessions, resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const originalAgentDir = getAgentDir();
const originalEnv = {
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	OMP_PROFILE: process.env.OMP_PROFILE,
	PI_PROFILE: process.env.PI_PROFILE,
};

function restoreEnv(name: keyof typeof originalEnv): void {
	const value = originalEnv[name];
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

describe("SQL-only all-project session discovery", () => {
	let tempAgentDir: string;
	let client: InstanceType<typeof SQL>;
	let storage: SqlSessionStorage;
	let sessionPath: string;

	beforeEach(async () => {
		tempAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-sql-listing-"));
		setAgentDir(tempAgentDir);
		client = new SQL("sqlite::memory:");
		storage = await SqlSessionStorage.create({ client });
		sessionPath = path.join(
			tempAgentDir,
			"sessions",
			"-work-sql-only-project",
			"2026-07-14T10-11-12-000Z_sqlonly1234.jsonl",
		);
		await storage.writeText(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				id: "sqlonly1234",
				timestamp: "2026-07-14T10:11:12.000Z",
				cwd: "/work/sql-only-project",
				title: "SQL-only session",
			})}\n${JSON.stringify({
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: "2026-07-14T10:11:13.000Z",
				message: { role: "user", content: "resume the database transcript", timestamp: 1 },
			})}\n`,
		);
	});

	afterEach(async () => {
		await client.end();
		await fsp.rm(tempAgentDir, { recursive: true, force: true });
		setAgentDir(originalAgentDir);
		restoreEnv("PI_CODING_AGENT_DIR");
		restoreEnv("OMP_PROFILE");
		restoreEnv("PI_PROFILE");
		__resetDirsFromEnvForTests();
	});

	it("lists a session stored under another project without a physical JSONL file", async () => {
		expect(await Bun.file(sessionPath).exists()).toBe(false);

		const sessions = await listAllSessions(storage);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			path: sessionPath,
			id: "sqlonly1234",
			cwd: "/work/sql-only-project",
			title: "SQL-only session",
			firstMessage: "resume the database transcript",
		});
	});

	it("resolves a SQL-only session by id through all-project fallback", async () => {
		expect(await Bun.file(sessionPath).exists()).toBe(false);

		const match = await resolveResumableSession(
			"sqlonly",
			"/work/current-project",
			path.join(tempAgentDir, "empty-local-session-dir"),
			storage,
			{ allowGlobalFallback: true },
		);

		expect(match).toEqual({
			scope: "global",
			session: expect.objectContaining({
				path: sessionPath,
				id: "sqlonly1234",
				cwd: "/work/sql-only-project",
			}),
		});
	});
});
