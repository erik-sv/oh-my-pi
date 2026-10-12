import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, setupSessionStorageBackend } from "@oh-my-pi/pi-coding-agent/main";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	getRecentSessions,
	listAllSessions,
	listSessionsReadOnly,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getDefaultSessionStorage,
	setDefaultSessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const savedEnv: Record<string, string | undefined> = Object.fromEntries(
	["OMP_SESSION_DB_URL", "OMP_SESSION_DB_OPTIONS", "PI_CODING_AGENT_DIR", "PI_PROFILE", "OMP_PROFILE"].map(key => [
		key,
		process.env[key],
	]),
);
const originalStorage = getDefaultSessionStorage();
let root: string;
let sessionDir: string;
let otherDir: string;
let firstPath: string;
let otherPath: string;
let foreignPath: string;
let databasePath: string;
let client: InstanceType<typeof SQL>;
const managers: SessionManager[] = [];
const startupClients: InstanceType<typeof SQL>[] = [];
const settings = Settings.isolated({ autoResume: false });

function transcript(id: string, text: string): string {
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
		{
			type: "message",
			id: `${id}-user`,
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: text, timestamp: 1 },
		},
	];
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-direct-sql-resume-"));
	setAgentDir(path.join(root, "agent"));
	sessionDir = path.join(root, "sessions", "project");
	otherDir = path.join(root, "sessions", "foreign");
	firstPath = path.join(sessionDir, "2026-01-01_first.jsonl");
	otherPath = path.join(sessionDir, "2026-01-02_other.jsonl");
	foreignPath = path.join(otherDir, "2026-01-03_foreign.jsonl");
	databasePath = path.join(root, "sessions.sqlite");
	client = new SQL(`sqlite://${databasePath}`);
	const storage = await SqlSessionStorage.create({ client, sessionRoot: path.join(root, "sessions") });
	await storage.writeText(firstPath, transcript("first", "Resume the original café conversation"));
	await storage.writeText(otherPath, transcript("other", "Unrelated local history remains available"));
	await storage.writeText(foreignPath, transcript("foreign", "Cross-project history remains available"));
	// Deterministic recency, independent of SQLite clock resolution.
	await client.unsafe("UPDATE omp_session_chunks SET mtime_ms = ? WHERE path = ?", [1, firstPath]);
	await client.unsafe("UPDATE omp_session_chunks SET mtime_ms = ? WHERE path = ?", [2, otherPath]);
	await client.unsafe("UPDATE omp_session_chunks SET mtime_ms = ? WHERE path = ?", [3, foreignPath]);
	process.env.OMP_SESSION_DB_URL = `sqlite://${databasePath}`;
	delete process.env.OMP_SESSION_DB_OPTIONS;
});

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	await getDefaultSessionStorage().drain();
	for (const startupClient of startupClients.splice(0)) await startupClient.end();
	await client.end();
	setDefaultSessionStorage(originalStorage);
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	__resetDirsFromEnvForTests();
	await fs.rm(root, { recursive: true, force: true });
});

async function partialStorage(): Promise<SqlSessionStorage> {
	const storage = await SqlSessionStorage.create({ client, initialPath: firstPath });
	setDefaultSessionStorage(storage);
	return storage;
}

async function openFirst(storage: SessionStorage): Promise<SessionManager> {
	const manager = await SessionManager.open(firstPath, sessionDir, storage, { suppressBreadcrumb: true });
	managers.push(manager);
	return manager;
}

async function setupBackend(args: Args): Promise<void> {
	// Track connections created by CLI startup for cleanup, while exercising
	// the real SQL implementation and real database in every assertion.
	const create = SqlSessionStorage.create.bind(SqlSessionStorage);
	const capture = spyOn(SqlSessionStorage, "create").mockImplementation(async options => {
		startupClients.push(options.client as InstanceType<typeof SQL>);
		return create(options);
	});
	try {
		await setupSessionStorageBackend(args);
	} finally {
		capture.mockRestore();
	}
}

describe("direct SQL resume caller boundaries", () => {
	it("resumes the requested transcript without reading unrelated history, then discovers all history on demand", async () => {
		// Resolution must match SessionManager.open, not the parsed workspace cwd.
		const args = parseArgs([
			"--mode",
			"rpc",
			"--session-storage",
			"sql",
			"--resume",
			path.relative(process.cwd(), firstPath),
			"--cwd",
			otherDir,
		]);
		await setupBackend(args);
		const storage = getDefaultSessionStorage();
		const reads: string[] = [];
		const readText = storage.readText.bind(storage);
		const read = spyOn(storage, "readText").mockImplementation(async file => {
			reads.push(file);
			return readText(file);
		});
		try {
			const manager = await createSessionManager(args, root, settings);
			if (!manager) throw new Error("Expected direct resume");
			managers.push(manager);
			expect(manager.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "Resume the original café conversation" },
			]);
			expect(reads).toEqual([firstPath]);
			// The caller has not paid for the global metadata scan yet.
			expect(() => storage.listFilesSync(sessionDir, "*.jsonl")).toThrow();
			const sessions = await SessionManager.list(root, sessionDir, storage);
			expect(sessions.map(session => session.id)).toEqual(["other", "first"]);
			expect(sessions[0].firstMessage).toBe("Unrelated local history remains available");
			const all = await listAllSessions(storage, path.join(root, "sessions"));
			expect(all.map(session => session.id)).toEqual(["foreign", "other", "first"]);
		} finally {
			read.mockRestore();
		}
	});

	it.each(["read-only", "recent", "id"] as const)(
		"keeps unseeded history discoverable through %s lookup without a prior full listing",
		async boundary => {
			const storage = await partialStorage();
			if (boundary === "read-only") {
				const sessions = await listSessionsReadOnly(sessionDir, storage);
				expect(sessions.map(session => session.id)).toEqual(["other", "first"]);
			} else if (boundary === "recent") {
				const sessions = await getRecentSessions(sessionDir, 1, storage);
				expect(sessions[0]).toMatchObject({ path: otherPath, name: "Unrelated local history remains available" });
			} else {
				const match = await resolveResumableSession("oth", root, sessionDir, storage);
				expect(match?.session.path).toBe(otherPath);
				expect(match?.session.firstMessage).toBe("Unrelated local history remains available");
			}
		},
	);

	it.each(["open", "switch"] as const)(
		"loads an unseeded transcript through %s instead of overwriting it",
		async boundary => {
			const storage = await partialStorage();
			const manager =
				boundary === "open" ? await SessionManager.open(otherPath, sessionDir, storage) : await openFirst(storage);
			if (boundary === "open") managers.push(manager);
			else await manager.setSessionFile(otherPath);
			expect(manager.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "Unrelated local history remains available" },
			]);
			expect(await storage.readText(otherPath)).toBe(
				transcript("other", "Unrelated local history remains available"),
			);
		},
	);

	it("branches a direct resume into a durable fresh path while retaining the selected history", async () => {
		const storage = await partialStorage();
		const manager = await openFirst(storage);
		const leaf = manager.getLeafId();
		if (!leaf) throw new Error("Expected branchable resumed history");
		const branch = await manager.createBranchedSession(leaf);
		if (!branch) throw new Error("Expected persisted branch");
		await manager.flush();
		const reopened = await SessionManager.open(branch, sessionDir, storage);
		managers.push(reopened);
		expect(reopened.getSessionId()).not.toBe("first");
		expect(reopened.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: "Resume the original café conversation" },
		]);
		expect(await storage.readText(firstPath)).toBe(transcript("first", "Resume the original café conversation"));
	});

	it("keeps default RPC startup ready for a fresh SDK-created session instead of selecting existing history", async () => {
		const args = parseArgs(["--mode", "rpc", "--session-storage", "sql"]);
		await setupBackend(args);
		expect(await createSessionManager(args, root, settings)).toBeUndefined();
		const storage = getDefaultSessionStorage();
		const manager = SessionManager.create(root, sessionDir, storage);
		managers.push(manager);
		manager.appendMessage({ role: "user", content: "A new conversation", timestamp: 10 });
		await manager.ensureOnDisk();
		const fresh = manager.getSessionFile();
		if (!fresh) throw new Error("Expected persisted new conversation");
		const reopened = await SessionManager.open(fresh, sessionDir, storage);
		managers.push(reopened);
		expect(reopened.buildSessionContext().messages).toMatchObject([{ role: "user", content: "A new conversation" }]);
		expect((await SessionManager.list(root, sessionDir, storage)).map(session => session.id)).toContain("other");
	});

	it("persists a fresh-session boundary after a direct resume without hiding older history", async () => {
		const storage = await partialStorage();
		const manager = await openFirst(storage);
		const fresh = await manager.newSession();
		if (!fresh) throw new Error("Expected persisted fresh session");
		expect(manager.buildSessionContext().messages).toEqual([]);
		const reopened = await SessionManager.open(fresh, sessionDir, storage);
		managers.push(reopened);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.buildSessionContext().messages).toEqual([]);
		expect((await SessionManager.list(root, sessionDir, storage)).map(session => session.id)).toContain("other");
	});

	it("forks after a direct resume without losing the source transcript", async () => {
		const storage = await partialStorage();
		const manager = await openFirst(storage);
		const fork = await manager.fork();
		if (!fork) throw new Error("Expected persisted fork");
		const reopened = await SessionManager.open(fork.newSessionFile, sessionDir, storage);
		managers.push(reopened);
		expect(reopened.getSessionId()).not.toBe("first");
		expect(reopened.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: "Resume the original café conversation" },
		]);
		expect(await storage.readText(firstPath)).toBe(transcript("first", "Resume the original café conversation"));
	});

	it.each([
		{ name: "explicit new session", flags: [] },
		{ name: "continue", flags: ["--continue"] },
		{ name: "ID resume", flags: ["--resume", "oth"] },
		{ name: "picker", flags: ["--resume"] },
		{ name: "fork", flags: ["--fork", "SOURCE"] },
		{ name: "foreign import", flags: ["--from-claude"] },
		{ name: "interactive resume", flags: ["--mode", "text", "--resume", "SOURCE"] },
		{ name: "RPC UI resume", flags: ["--mode", "rpc-ui", "--resume", "SOURCE"] },
	])("leaves $name startup history complete", async ({ name, flags }) => {
		const args: Args = parseArgs([
			"--mode",
			"rpc",
			"--session-storage",
			"sql",
			"--session-dir",
			sessionDir,
			...flags.map(flag => (flag === "SOURCE" ? firstPath : flag)),
		]);
		await setupBackend(args);
		const storage = getDefaultSessionStorage();
		expect(storage.listFilesSync(sessionDir, "*.jsonl").sort()).toEqual([firstPath, otherPath].sort());
		if (["explicit new session", "continue", "ID resume", "fork"].includes(name)) {
			const manager = await createSessionManager(args, root, settings);
			if (!manager) throw new Error("Expected selected session");
			managers.push(manager);
			if (name === "explicit new session") {
				expect(manager.buildSessionContext().messages).toEqual([]);
				expect(manager.getSessionId()).not.toBe("first");
				expect(manager.getSessionId()).not.toBe("other");
			} else {
				const text =
					name === "fork" ? "Resume the original café conversation" : "Unrelated local history remains available";
				expect(manager.buildSessionContext().messages).toMatchObject([{ role: "user", content: text }]);
			}
		}
	});
});
