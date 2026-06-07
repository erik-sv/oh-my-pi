/**
 * Functional tests for {@link SqlSessionStorage}. Driven by a real
 * `Bun.SQL` SQLite instance (in-memory) so the storage exercises actual SQL
 * execution, not a hand-rolled mock. PostgreSQL/MySQL behaviour is covered by
 * dialect-specific query capture below.
 */

import { describe, expect, it } from "bun:test";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";

async function createSqlite(): Promise<{ client: InstanceType<typeof SQL>; storage: SqlSessionStorage }> {
	const client = new SQL("sqlite::memory:");
	const storage = await SqlSessionStorage.create({ client });
	return { client, storage };
}

/** Reassemble a path's full body from its chunk rows, ordered by seq. */
async function readChunks(
	client: InstanceType<typeof SQL>,
	path: string,
	table = "omp_session_chunks",
): Promise<string> {
	const rows = (await client.unsafe(`SELECT content FROM ${table} WHERE path = ? ORDER BY seq`, [path])) as Array<{
		content: string;
	}>;
	return rows.map(r => r.content).join("");
}

/** List the distinct paths present in the chunk table, sorted. */
async function listChunkPaths(client: InstanceType<typeof SQL>, table = "omp_session_chunks"): Promise<string[]> {
	const rows = (await client.unsafe(`SELECT DISTINCT path FROM ${table} ORDER BY path`)) as Array<{ path: string }>;
	return rows.map(r => r.path);
}

describe("SqlSessionStorage (SQLite backend)", () => {
	it("stores writeText as per-line chunks and reads content asynchronously", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const rows = (await client.unsafe(`SELECT seq, content FROM omp_session_chunks WHERE path = ? ORDER BY seq`, [
			"/sessions/p/a.jsonl",
		])) as Array<{ seq: number; content: string }>;
		expect(rows).toEqual([
			{ seq: 0, content: "line1\n" },
			{ seq: 1, content: "line2\n" },
		]);
		expect(await readChunks(client, "/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
		await client.end();
	});

	it("create() warms the metadata index without selecting full content", async () => {
		const client = new SQL("sqlite::memory:");
		await client.unsafe(
			`CREATE TABLE omp_session_chunks (path TEXT NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, PRIMARY KEY (path, seq))`,
		);
		await client.unsafe(
			`INSERT INTO omp_session_chunks (path, seq, content, mtime_ms, title, title_source, title_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["/sessions/p/huge.jsonl", 0, "0123456789", Date.now(), "Huge", "auto", "t1"],
		);

		const storage = await SqlSessionStorage.create({ client, createTable: false });
		expect(storage.existsSync("/sessions/p/huge.jsonl")).toBe(true);
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);
		expect(await storage.readText("/sessions/p/huge.jsonl")).toBe("0123456789");
		await client.end();
	});

	it("represents empty files durably in the chunk table and metadata index", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/empty.jsonl", "");

		expect(storage.statSync("/sessions/p/empty.jsonl").size).toBe(0);
		expect(await storage.readText("/sessions/p/empty.jsonl")).toBe("");
		expect(await listChunkPaths(client)).toEqual(["/sessions/p/empty.jsonl"]);

		const reloaded = await SqlSessionStorage.create({ client, createTable: false });
		expect(reloaded.existsSync("/sessions/p/empty.jsonl")).toBe(true);
		expect(reloaded.statSync("/sessions/p/empty.jsonl").size).toBe(0);
		await client.end();
	});

	it("writeText splits a trailing newline-less remainder into its own chunk", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/partial.jsonl", "a\nb\nlast-no-newline");

		const rows = (await client.unsafe(`SELECT seq, content FROM omp_session_chunks WHERE path = ? ORDER BY seq`, [
			"/sessions/p/partial.jsonl",
		])) as Array<{ seq: number; content: string }>;
		expect(rows).toEqual([
			{ seq: 0, content: "a\n" },
			{ seq: 1, content: "b\n" },
			{ seq: 2, content: "last-no-newline" },
		]);
		expect(await storage.readText("/sessions/p/partial.jsonl")).toBe("a\nb\nlast-no-newline");
		await client.end();
	});

	it("listFilesSync returns only direct children matching the glob", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z");
		await storage.writeText("/dir/note.bak", "skip");

		expect(storage.listFilesSync("/dir", "*.jsonl").sort()).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);
		expect(storage.listFilesSync("/dir", "*.bak")).toEqual(["/dir/note.bak"]);
		await client.end();
	});

	it("writer.append appends one chunk row per line after drain", async () => {
		const { client, storage } = await createSqlite();
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		await storage.drain();
		const rows = (await client.unsafe(`SELECT seq, content FROM omp_session_chunks WHERE path = ? ORDER BY seq`, [
			"/sessions/p/session.jsonl",
		])) as Array<{ seq: number; content: string }>;
		expect(rows).toEqual([
			{ seq: 0, content: '{"type":"session"}\n' },
			{ seq: 1, content: '{"type":"message"}\n' },
		]);

		await writer.close();
		await client.end();
	});

	it("flags='w' truncates both index and chunk rows", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/keep.jsonl", "old1\nold2\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		const rows = (await client.unsafe(`SELECT seq, content FROM omp_session_chunks WHERE path = ? ORDER BY seq`, [
			"/sessions/p/keep.jsonl",
		])) as Array<{ seq: number; content: string }>;
		expect(rows).toEqual([{ seq: 0, content: "fresh\n" }]);
		await client.end();
	});

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");
		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
		await client.end();
	});

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");

		// Force a SQL error: drop the table so the next append throws.
		await client.unsafe("DROP TABLE omp_session_chunks");
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow();
		expect(writer.getError()).toBeDefined();
		await client.end();
	});

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);
		expect(await listChunkPaths(client)).toEqual(["/sessions/p/other.jsonl"]);
		await client.end();
	});

	it("rename moves content and overwrites an existing destination", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "from-a\n");
		await storage.writeText("/sessions/p/b.jsonl", "from-b1\nfrom-b2\n");
		const originalMtime = storage.statSync("/sessions/p/a.jsonl").mtimeMs;

		await storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");
		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/b.jsonl")).toBe("from-a\n");
		expect(storage.statSync("/sessions/p/b.jsonl").mtimeMs).toBe(originalMtime);
		expect(await listChunkPaths(client)).toEqual(["/sessions/p/b.jsonl"]);
		expect(await readChunks(client, "/sessions/p/b.jsonl")).toBe("from-a\n");
		await client.end();
	});

	it("refresh() reloads metadata from chunk rows after out-of-band writes", async () => {
		const { client, storage } = await createSqlite();
		const mtime = Date.now() + 5_000;
		await client.unsafe(`INSERT INTO omp_session_chunks (path, seq, content, mtime_ms) VALUES (?, ?, ?, ?)`, [
			"/peer/x.jsonl",
			0,
			"from peer line1\n",
			mtime,
		]);
		await client.unsafe(`INSERT INTO omp_session_chunks (path, seq, content, mtime_ms) VALUES (?, ?, ?, ?)`, [
			"/peer/x.jsonl",
			1,
			"from peer line2\n",
			mtime,
		]);
		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);

		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer line1\nfrom peer line2\n");

		const writer = storage.openWriter("/peer/x.jsonl");
		await writer.append("from peer line3\n");
		await writer.close();
		expect(await readChunks(client, "/peer/x.jsonl")).toBe("from peer line1\nfrom peer line2\nfrom peer line3\n");
		await client.end();
	});

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		await client.end();
	});

	it("persists title updates as indexed fields across storage reloads", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		const initialContent = `${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`;
		await storage.writeText(sessionPath, initialContent);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const rows = (await client.unsafe(
			`SELECT seq, content, title, title_source, title_updated_at FROM omp_session_chunks WHERE path = ? ORDER BY seq`,
			[sessionPath],
		)) as Array<{
			seq: number;
			content: string;
			title: string | null;
			title_source: string | null;
			title_updated_at: string | null;
		}>;
		expect(rows.map(row => row.content).join("")).toBe(initialContent);
		expect(rows[0]).toMatchObject({ title: "New", title_source: "user", title_updated_at: "t2" });
		expect(rows.slice(1).every(row => row.title === null && row.title_source === null && row.title_updated_at === null)).toBe(true);

		const reloaded = await SqlSessionStorage.create({ client });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		await client.end();
	});

	it("custom table name is honored", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client, table: "agent_sessions" });
		await storage.writeText("/sessions/p/x.jsonl", "hello\n");
		expect(await readChunks(client, "/sessions/p/x.jsonl", "agent_sessions")).toBe("hello\n");
		expect(await listChunkPaths(client, "agent_sessions")).toEqual(["/sessions/p/x.jsonl"]);
		await client.end();
	});

	it("rejects table names that aren't safe identifiers", async () => {
		const client = new SQL("sqlite::memory:");
		await expect(SqlSessionStorage.create({ client, table: "drop table users; --" })).rejects.toThrow(
			/table name must match/,
		);
		await client.end();
	});

	it("unlink on a missing key throws ENOENT", async () => {
		const { client, storage } = await createSqlite();
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("createTable: false skips the DDL when consumer manages migrations", async () => {
		const client = new SQL("sqlite::memory:");
		await client.unsafe(
			`CREATE TABLE omp_session_chunks (path TEXT NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, PRIMARY KEY (path, seq))`,
		);
		const storage = await SqlSessionStorage.create({ client, createTable: false });
		await storage.writeText("/s/x.jsonl", "ok");
		expect(await storage.readText("/s/x.jsonl")).toBe("ok");
		expect(await readChunks(client, "/s/x.jsonl")).toBe("ok");
		await client.end();
	});
});

// ---------------------------------------------------------------------------
// Dialect-specific statement coverage. We can't run a real Postgres/MySQL
// instance from the test process, so we stub `client.unsafe` to capture rendered
// SQL. This catches dialect-specific query-builder regressions.
// ---------------------------------------------------------------------------

interface CapturedQuery {
	sql: string;
	values: unknown[] | undefined;
}

function capturingClient(adapter: "postgres" | "mysql"): {
	client: SqlSessionStorageClient;
	queries: CapturedQuery[];
} {
	const queries: CapturedQuery[] = [];
	const client: SqlSessionStorageClient = {
		options: { adapter },
		async unsafe(sql, values) {
			queries.push({ sql, values });
			return [];
		},
	};
	return { client, queries };
}

describe("SqlSessionStorage (dialect-specific SQL)", () => {
	it("PostgreSQL uses numbered placeholders and per-line chunk INSERT", async () => {
		const { client, queries } = capturingClient("postgres");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/s/p.jsonl");
		await writer.append("chunk\n");
		await writer.close();

		const ddl = queries.find(q => q.sql.startsWith("CREATE TABLE"));
		expect(ddl?.sql).toContain("path TEXT NOT NULL");
		expect(ddl?.sql).toContain("seq BIGINT NOT NULL");
		expect(ddl?.sql).toContain("mtime_ms BIGINT NOT NULL");
		expect(ddl?.sql).toContain("PRIMARY KEY (path, seq)");

		const loadIndex = queries.find(q => q.sql.startsWith("SELECT path"));
		expect(loadIndex?.sql).toContain("SUM(octet_length(content))");
		expect(loadIndex?.sql).not.toMatch(/SELECT\s+path,\s*content\b/i);

		const append = queries.find(q => q.sql.startsWith("INSERT INTO") && q.sql.includes("$7"));
		expect(append?.sql).toContain("(path, seq, content, mtime_ms, title, title_source, title_updated_at)");
		expect(append?.sql).toContain("$1");
		expect(append?.sql).toContain("$2");
		expect(append?.sql).toContain("$3");
		expect(append?.sql).toContain("$4");
		expect(append?.sql).toContain("$7");
		expect(append?.sql).not.toContain("ON CONFLICT");
		expect(append?.sql).not.toContain("||");
		expect(append?.values).toEqual(["/s/p.jsonl", 0, "chunk\n", expect.any(Number), null, null, null]);
		expect(storage.adapter).toBe("postgres");
	});

	it("MySQL uses `?` placeholders and per-line chunk INSERT", async () => {
		const { client, queries } = capturingClient("mysql");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/s/m.jsonl");
		await writer.append("chunk\n");
		await writer.close();

		const ddl = queries.find(q => q.sql.startsWith("CREATE TABLE"));
		expect(ddl?.sql).toContain("VARCHAR(512)");
		expect(ddl?.sql).toContain("LONGTEXT");
		expect(ddl?.sql).toContain("ENGINE=InnoDB");
		expect(ddl?.sql).toContain("utf8mb4");
		expect(ddl?.sql).toContain("PRIMARY KEY (path, seq)");

		const loadIndex = queries.find(q => q.sql.startsWith("SELECT path"));
		expect(loadIndex?.sql).toContain("SUM(OCTET_LENGTH(content))");
		expect(loadIndex?.sql).not.toMatch(/SELECT\s+path,\s*content\b/i);

		const append = queries.find(q => q.sql.startsWith("INSERT INTO") && q.sql.includes("content"));
		expect(append?.sql).toContain("(path, seq, content, mtime_ms, title, title_source, title_updated_at)");
		expect(append?.sql).toContain("(?, ?, ?, ?, ?, ?, ?)");
		expect(append?.sql).not.toContain("ON DUPLICATE KEY UPDATE");
		expect(append?.sql).not.toContain("$1");
		expect(append?.values).toEqual(["/s/m.jsonl", 0, "chunk\n", expect.any(Number), null, null, null]);
		expect(storage.adapter).toBe("mysql");
	});

	it("rejects clients reporting an unknown adapter without an override", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "weirdb" },
			async unsafe() {
				return [];
			},
		};
		await expect(SqlSessionStorage.create({ client })).rejects.toThrow(/unable to infer adapter/);
	});

	it("explicit `adapter` option overrides the reported adapter", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "" },
			async unsafe() {
				return [];
			},
		};
		const storage = await SqlSessionStorage.create({ client, adapter: "postgres" });
		expect(storage.adapter).toBe("postgres");
	});
});
