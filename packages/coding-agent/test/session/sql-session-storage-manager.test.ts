/**
 * Integration: `SessionManager` driven by `SqlSessionStorage` (SQLite
 * backend) instead of the file-backed store. Verifies the SQL substrate is
 * genuinely pluggable — append → flush → reload via `open()` works against
 * a real `Bun.SQL` connection, and `SessionManager.list()` enumerates rows
 * out of the table.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SQL } from "bun";

// Storage keys are platform paths; `/sessions/...` is only drive-relative on Windows,
// so a resolved `open()` would address a different key than `create()` wrote.
const virtualDir = (dir: string): string => path.resolve(dir);

function fakeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text" as const, text }],
		usage: fakeUsage(1, 1),
		api: "anthropic-messages" as const,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

async function sqlBody(client: SQL, sessionFile: string): Promise<string> {
	const rows = (await client.unsafe(`SELECT content FROM omp_session_chunks WHERE path = ? ORDER BY seq`, [
		sessionFile,
	])) as Array<{ content: string }>;
	return rows.map(row => row.content).join("");
}

/**
 * Bun.SQL wrapper that can pause the next rewrite or append inside its
 * transaction: the chunk backend publishes a rewrite as delete+insert, so the
 * first `DELETE` on the chunk table after `holdNextReplace` is set is the
 * replace; an append starts by reading the first chunk rows.
 */
class HeldSqlClient implements SqlSessionStorageClient {
	readonly options: SqlSessionStorageClient["options"];
	holdNextReplace = false;
	readonly replaceStarted = Promise.withResolvers<void>();
	readonly allowReplace = Promise.withResolvers<void>();
	holdNextAppend = false;
	readonly appendStarted = Promise.withResolvers<void>();
	readonly allowAppend = Promise.withResolvers<void>();
	readonly #client: InstanceType<typeof SQL>;

	constructor(client: InstanceType<typeof SQL>) {
		this.#client = client;
		this.options = client.options;
	}

	unsafe(query: string, values?: unknown[]) {
		return this.#client.unsafe(query, values);
	}

	begin<T>(callback: (transaction: SqlSessionStorageTransaction) => Promise<T>): Promise<T> {
		return this.#client.begin(transaction =>
			callback({
				unsafe: (query, values) => {
					if (this.holdNextReplace && query.startsWith("DELETE FROM omp_session_chunks")) {
						this.holdNextReplace = false;
						this.replaceStarted.resolve();
						return this.allowReplace.promise.then(() => transaction.unsafe(query, values));
					}
					if (this.holdNextAppend && query.startsWith("SELECT seq, content, title")) {
						this.holdNextAppend = false;
						this.appendStarted.resolve();
						return this.allowAppend.promise.then(() => transaction.unsafe(query, values));
					}
					return transaction.unsafe(query, values);
				},
			}),
		) as Promise<T>;
	}
}

describe("SessionManager + SqlSessionStorage (SQLite)", () => {
	it("persists appended assistant messages into SQL and reloads via open()", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/proj");

		const manager = SessionManager.create("/cwd", sessionDir, storage);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "hi" }],
			usage: fakeUsage(10, 5),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const sessionFilePath = sessionFile as string;
		expect(sessionFilePath.startsWith(sessionDir)).toBe(true);

		// `appendMessage` queues the cold-path rewrite onto SessionManager's
		// internal persist chain via a fire-and-forget call. `flush()` awaits
		// that chain; `drain()` mops up the storage-level pending tail.
		await manager.flush();
		await storage.drain();
		await manager.close();

		const chunkRows = (await client.unsafe(`SELECT content FROM omp_session_chunks WHERE path = ? ORDER BY seq`, [
			sessionFilePath,
		])) as Array<{ content: string }>;
		expect(chunkRows.length).toBeGreaterThanOrEqual(3);
		const content = chunkRows.map(r => r.content).join("");
		const lines = content.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
		// The fixed-width title slot is always the first physical line; the session header follows.
		const slot = JSON.parse(lines[0]);
		expect(slot.type).toBe("title");
		const header = JSON.parse(lines[1]);
		expect(header.type).toBe("session");
		const msg = JSON.parse(lines[lines.length - 1]);
		expect(msg.type).toBe("message");
		expect(msg.message.role).toBe("assistant");
		expect(msg.message.content[0].text).toBe("hi");

		const reopened = await SessionManager.open(sessionFilePath, sessionDir, storage);
		const leaf = reopened.getLeafEntry();
		expect(leaf).toBeDefined();
		expect(leaf?.type).toBe("message");
		await reopened.close();
		await client.end();
	});

	it("SessionManager.list returns SQL-backed sessions for the cwd", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/list-proj");

		const a = SessionManager.create("/cwd", sessionDir, storage);
		a.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "alpha" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await a.flush();
		await storage.drain();
		await a.close();

		const b = SessionManager.create("/cwd", sessionDir, storage);
		b.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "beta" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await b.flush();
		await storage.drain();
		await b.close();

		const aFile = a.getSessionFile();
		const bFile = b.getSessionFile();
		expect(aFile).toBeDefined();
		expect(bFile).toBeDefined();

		const sessions = await SessionManager.list("/cwd", sessionDir, storage);
		const sessionFiles = sessions.map(s => s.path).sort();
		expect(sessionFiles).toContain(aFile as string);
		expect(sessionFiles).toContain(bFile as string);
		await client.end();
	});

	it("rejects a stale rewrite after another SQL storage appends", async () => {
		const client = new SQL("sqlite::memory:");
		const firstStorage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/shared");
		const first = SessionManager.create("/cwd", sessionDir, firstStorage);
		await first.ensureOnDisk();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const secondStorage = await SqlSessionStorage.create({ client });
		const second = await SessionManager.open(sessionFile, sessionDir, secondStorage);
		second.appendMessage({ role: "user", content: "durable SQL peer turn", timestamp: Date.now() });
		await second.close();

		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(await secondStorage.readText(sessionFile)).toContain("durable SQL peer turn");
		await client.end();
	});

	it("seal()+close() lands a dispose-time exit record that self-raced the deferred SQL publish", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const manager = SessionManager.create("/cwd", "/sessions/dispose", storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// Dispose shape: final turn persist, then exit record + flushSync with no
		// await between them, so the second sync rewrite conflicts with the
		// first one's still-unconfirmed SQL publish.
		manager.appendMessage(assistantMessage("FINAL SQL MESSAGE"));
		let exitRecordError: unknown;
		try {
			manager.appendCustomEntry("session_exit", { reason: "dispose" });
			manager.flushSync();
		} catch (err) {
			exitRecordError = err;
		}
		expect(exitRecordError).toBeInstanceOf(SessionWriteConflictError);

		manager.seal();
		await manager.close();

		const body = await sqlBody(client, sessionFile);
		expect(body).toContain("FINAL SQL MESSAGE");
		expect(body).toContain("session_exit");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));

		const reloadedStorage = await SqlSessionStorage.create({ client });
		const reopened = await SessionManager.open(sessionFile, "/sessions/dispose", reloadedStorage);
		expect(reopened.getEntries().some(entry => entry.type === "custom" && entry.customType === "session_exit")).toBe(
			true,
		);
		await reopened.close();
		await client.end();
	});

	it("close() terminal retry never overwrites a peer's durable SQL turn after a conflict", async () => {
		const client = new SQL("sqlite::memory:");
		const firstStorage = await SqlSessionStorage.create({ client });
		const first = SessionManager.create("/cwd", "/sessions/peer", firstStorage);
		first.appendMessage(assistantMessage("original local turn"));
		await first.flush();
		await firstStorage.drain();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const secondStorage = await SqlSessionStorage.create({ client });
		const second = await SessionManager.open(sessionFile, "/sessions/peer", secondStorage);
		second.appendMessage({ role: "user", content: "durable SQL peer turn", timestamp: Date.now() });
		await second.close();
		const peerBody = await sqlBody(client, sessionFile);

		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		// close() retries the terminal rewrite for deferred-publish backends; the
		// SQL size precondition must reject it rather than replace the peer's body.
		first.seal();
		await expect(first.close()).rejects.toThrow();

		expect(await sqlBody(client, sessionFile)).toBe(peerBody);
		expect(peerBody).toContain("durable SQL peer turn");
		expect(peerBody).toContain("original local turn");
		await client.end();
	});

	it("recovers a fenced rewrite size conflict with the real SQLite backend", async () => {
		const client = new SQL("sqlite::memory:");
		const heldClient = new HeldSqlClient(client);
		const storage = await SqlSessionStorage.create({ client: heldClient });
		const manager = SessionManager.create("/cwd", virtualDir("/sessions/rewrite-race"), storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "seed reply" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		manager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await manager.flush();
		await storage.drain();
		const turn = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
		if (turn?.type !== "message" || turn.message.role !== "user") throw new Error("Expected user turn");
		turn.message.content = "pruned before rewrite";

		heldClient.holdNextReplace = true;
		const rewritePublished = manager.rewriteEntries();
		await heldClient.replaceStarted.promise;
		manager.appendMessage({ role: "user", content: "fenced append", timestamp: Date.now() });
		heldClient.allowReplace.resolve();
		await rewritePublished.catch(() => {});
		await manager.flush().catch(() => {});

		manager.appendMessage({ role: "user", content: "later turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const body = await storage.readText(sessionFile);
		expect(body).toContain("fenced append");
		expect(body).toContain("later turn");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		await manager.close();
		await client.end();
	});

	/**
	 * The incident shape: a hot append is still on the wire when rewriteEntries()
	 * arms its atomic fence, and turns recorded inside the fence replace the
	 * transcript synchronously while that append is unconfirmed.
	 */
	async function raceRewriteWithUnconfirmedAppend(sessionName: string) {
		const client = new SQL("sqlite::memory:");
		const heldClient = new HeldSqlClient(client);
		const storage = await SqlSessionStorage.create({ client: heldClient });
		const sessionDir = virtualDir(`/sessions/${sessionName}`);
		const manager = SessionManager.create("/cwd", sessionDir, storage);
		manager.appendMessage(assistantMessage("seed reply"));
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		heldClient.holdNextAppend = true;
		manager.appendCustomEntry("unconfirmed_append", { padding: "x".repeat(400) });
		await heldClient.appendStarted.promise;
		const rewrite = manager.rewriteEntries();
		// Let the scheduled rewrite arm its fence and park on the writer close.
		const fenceArmed = Promise.withResolvers<void>();
		setImmediate(fenceArmed.resolve);
		await fenceArmed.promise;
		manager.appendMessage({ role: "user", content: "fenced turn", timestamp: Date.now() });
		manager.appendMessage(assistantMessage("reply during the stalled append"));
		return { client, heldClient, storage, sessionDir, manager, sessionFile, rewrite };
	}

	/** The durable SQL body holds exactly the in-memory journal, and the CAS token describes it. */
	async function expectDurableJournal(client: SQL, sessionDir: string, manager: SessionManager, sessionFile: string) {
		const body = await sqlBody(client, sessionFile);
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		const reopened = await SessionManager.open(sessionFile, sessionDir, await SqlSessionStorage.create({ client }));
		expect(reopened.getEntries().map(entry => entry.id)).toEqual(manager.getEntries().map(entry => entry.id));
		await reopened.close();
	}

	it("persists turns recorded while a rewrite waits on an unconfirmed append", async () => {
		const { client, heldClient, storage, sessionDir, manager, sessionFile, rewrite } =
			await raceRewriteWithUnconfirmedAppend("append-rewrite-race");

		heldClient.allowAppend.resolve();
		await rewrite;
		await storage.drain();
		// Nothing else is appended: the session must converge on its own
		// instead of latching the self-race until a later turn retries it.
		await manager.flush();
		await expectDurableJournal(client, sessionDir, manager, sessionFile);

		manager.appendMessage({ role: "user", content: "later turn", timestamp: Date.now() });
		await manager.flush();
		await expectDurableJournal(client, sessionDir, manager, sessionFile);
		await manager.close();
		await client.end();
	});

	it("recovers when the unconfirmed append a rewrite waited on fails", async () => {
		const { client, heldClient, storage, sessionDir, manager, sessionFile, rewrite } =
			await raceRewriteWithUnconfirmedAppend("append-rewrite-race-failed");

		heldClient.allowAppend.reject(new Error("connection reset during append"));
		await rewrite.catch(() => {});
		// The failed publish surfaces through drain and the latched failure.
		await storage.drain().catch(() => {});
		await manager.flush().catch(() => {});

		// The next turn retries the whole journal against the size the store holds.
		manager.appendMessage({ role: "user", content: "later turn", timestamp: Date.now() });
		await manager.flush();
		await expectDurableJournal(client, sessionDir, manager, sessionFile);
		await manager.close();
		await client.end();
	});
});
