import { describe, expect, it } from "bun:test";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

type SqlRow = Record<string, unknown>;

type LegacySqlRow = SqlRow & {
	path: string;
	content: string;
	mtime_ms: number;
	title: string | null;
	title_source: string | null;
	title_updated_at: string | null;
};

interface MysqlTable {
	columns: string[];
	rows: SqlRow[];
}

interface TransactionState {
	rollbackPoint: Map<string, MysqlTable>;
}

interface MysqlLockWaiter {
	owner: number;
	resolve: (rows: unknown[]) => void;
}

interface MysqlLock {
	owner: number;
	depth: number;
	waiters: MysqlLockWaiter[];
}

class MysqlDatabase {
	tables = new Map<string, MysqlTable>();
	locks = new Map<string, MysqlLock>();
	nextClientId = 1;
	atomicRenameCount = 0;
}

function createBarrier(parties: number): () => Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	let arrived = 0;
	return async () => {
		arrived++;
		if (arrived === parties) resolve();
		await promise;
	};
}

const CHUNK_COLUMNS = ["path", "seq", "content", "mtime_ms", "title", "title_source", "title_updated_at"];
const LEGACY_COLUMNS = ["path", "content", "mtime_ms", "title", "title_source", "title_updated_at"];

function cloneTables(tables: ReadonlyMap<string, MysqlTable>): Map<string, MysqlTable> {
	return new Map(
		[...tables].map(([name, table]) => [
			name,
			{ columns: [...table.columns], rows: table.rows.map(row => ({ ...row })) },
		]),
	);
}

/**
 * Stateful MySQL client double for migration tests.
 *
 * DML inside begin() rolls back on callback failure. DDL does not: each DDL
 * statement implicitly commits the transaction before and after it, matching
 * MySQL. Multi-table RENAME TABLE validates and applies every rename against a
 * single pre-statement snapshot, then commits the whole swap atomically.
 */
class MysqlMigrationClient implements SqlSessionStorageClient {
	readonly options = { adapter: "mysql" };
	failNextChunkInsert = false;
	interruptBeforeNextAtomicRename = false;
	interruptAfterNextAtomicRename = false;
	readonly #database: MysqlDatabase;
	readonly #clientId: number;
	#reserved = false;

	constructor(database = new MysqlDatabase()) {
		this.#database = database;
		this.#clientId = database.nextClientId++;
	}

	async reserve(): Promise<MysqlMigrationClient> {
		if (this.#reserved) throw new Error(`MySQL physical connection ${this.#clientId} is already reserved`);
		this.#reserved = true;
		return this;
	}

	release(): void {
		if (!this.#reserved) throw new Error(`MySQL physical connection ${this.#clientId} is not reserved`);
		this.#reserved = false;
	}

	seedLegacyTable(name: string, rows: readonly LegacySqlRow[]): void {
		this.#database.tables.set(name, { columns: [...LEGACY_COLUMNS], rows: rows.map(row => ({ ...row })) });
	}

	seedChunkTable(name: string, rows: readonly SqlRow[]): void {
		this.#database.tables.set(name, { columns: [...CHUNK_COLUMNS], rows: rows.map(row => ({ ...row })) });
	}

	snapshot(): Map<string, MysqlTable> {
		return cloneTables(this.#database.tables);
	}

	atomicRenameCount(): number {
		return this.#database.atomicRenameCount;
	}

	tableNames(): string[] {
		return [...this.#database.tables.keys()].sort();
	}

	columns(table: string): string[] {
		return [...this.#requireTable(table).columns];
	}

	rows(table: string): SqlRow[] {
		return this.#requireTable(table).rows.map(row => ({ ...row }));
	}

	async begin<T>(
		callback: (transaction: { unsafe(sql: string, values?: unknown[]): Promise<unknown[]> }) => Promise<T>,
	): Promise<T> {
		const transaction: TransactionState = { rollbackPoint: cloneTables(this.#database.tables) };
		try {
			return await callback({
				unsafe: (sql, values) => this.#unsafe(sql, values, transaction),
			});
		} catch (error) {
			this.#database.tables = cloneTables(transaction.rollbackPoint);
			throw error;
		}
	}

	async unsafe(sql: string, values?: unknown[]): Promise<unknown[]> {
		return this.#unsafe(sql, values);
	}

	async #unsafe(sql: string, values: unknown[] = [], transaction?: TransactionState): Promise<unknown[]> {
		const statement = sql.trim().replace(/\s+/g, " ").replace(/;$/, "");

		if (/^SELECT GET_LOCK\(\?, \d+\) AS acquired$/i.test(statement)) {
			return this.#acquireLock(String(values[0]));
		}

		if (/^SELECT RELEASE_LOCK\(\?\) AS released$/i.test(statement)) {
			return this.#releaseLock(String(values[0]));
		}

		if (/^SELECT column_name FROM information_schema\.columns /i.test(statement)) {
			const table = String(values[0]);
			return (this.#database.tables.get(table)?.columns ?? []).map(column_name => ({ column_name }));
		}

		const create = statement.match(/^CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*) \(/i);
		if (create) {
			const table = create[1];
			if (!this.#database.tables.has(table))
				this.#database.tables.set(table, { columns: [...CHUNK_COLUMNS], rows: [] });
			this.#commitDdl(transaction);
			return [];
		}

		const alterRename = statement.match(/^ALTER TABLE ([A-Za-z_][A-Za-z0-9_]*) RENAME TO ([A-Za-z_][A-Za-z0-9_]*)$/i);
		if (alterRename) {
			this.#atomicRename([[alterRename[1], alterRename[2]]]);
			this.#commitDdl(transaction);
			return [];
		}

		const atomicRename = statement.match(/^RENAME TABLE (.+)$/i);
		if (atomicRename) {
			const renames = atomicRename[1].split(",").map(part => {
				const match = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*) TO ([A-Za-z_][A-Za-z0-9_]*)$/i);
				if (!match) throw new Error(`Unsupported RENAME TABLE clause in test double: ${part}`);
				return [match[1], match[2]] as const;
			});
			if (this.interruptBeforeNextAtomicRename) {
				this.interruptBeforeNextAtomicRename = false;
				throw new Error("simulated process interruption immediately before atomic rename swap");
			}
			this.#atomicRename(renames);
			this.#database.atomicRenameCount++;
			this.#commitDdl(transaction);
			if (this.interruptAfterNextAtomicRename) {
				this.interruptAfterNextAtomicRename = false;
				throw new Error("simulated process interruption immediately after atomic rename swap");
			}
			return [];
		}

		const addColumn = statement.match(/^ALTER TABLE ([A-Za-z_][A-Za-z0-9_]*) ADD COLUMN ([A-Za-z_][A-Za-z0-9_]*) /i);
		if (addColumn) {
			const table = this.#requireTable(addColumn[1]);
			const column = addColumn[2].toLowerCase();
			if (table.columns.includes(column)) throw new Error(`Duplicate column name '${column}'`);
			table.columns.push(column);
			for (const row of table.rows) row[column] = null;
			this.#commitDdl(transaction);
			return [];
		}

		const drop = statement.match(/^DROP TABLE(?: IF EXISTS)? (.+)$/i);
		if (drop) {
			for (const table of drop[1].split(",").map(name => name.trim())) this.#database.tables.delete(table);
			this.#commitDdl(transaction);
			return [];
		}

		const insert = statement.match(/^INSERT INTO ([A-Za-z_][A-Za-z0-9_]*) \(([^)]+)\) VALUES (.+)$/i);
		if (insert) {
			const table = this.#requireTable(insert[1]);
			const columns = insert[2].split(",").map(column => column.trim().toLowerCase());
			if (this.failNextChunkInsert && columns.includes("seq")) {
				this.failNextChunkInsert = false;
				throw new Error("injected MySQL migration chunk insert failure");
			}
			if (values.length % columns.length !== 0) throw new Error(`Invalid INSERT values for ${insert[1]}`);
			for (let offset = 0; offset < values.length; offset += columns.length) {
				const row: SqlRow = {};
				for (let index = 0; index < columns.length; index++) row[columns[index]] = values[offset + index];
				table.rows.push(row);
			}
			return [];
		}

		const legacySelect = statement.match(
			/^SELECT path, content, mtime_ms, (.+) FROM ([A-Za-z_][A-Za-z0-9_]*)(?: FOR UPDATE)?$/i,
		);
		if (legacySelect) return this.#requireTable(legacySelect[2]).rows.map(row => ({ ...row }));

		const loadIndex = statement.match(
			/^SELECT path, SUM\(OCTET_LENGTH\(content\)\) AS byte_len, .+ FROM ([A-Za-z_][A-Za-z0-9_]*) GROUP BY path$/i,
		);
		if (loadIndex) {
			const grouped = new Map<string, SqlRow[]>();
			for (const row of this.#requireTable(loadIndex[1]).rows) {
				const path = String(row.path);
				const rows = grouped.get(path) ?? [];
				rows.push(row);
				grouped.set(path, rows);
			}
			return [...grouped].map(([path, rows]) => {
				const first = rows.find(row => Number(row.seq) === 0);
				return {
					path,
					byte_len: rows.reduce((total, row) => total + Buffer.byteLength(String(row.content), "utf8"), 0),
					mtime_ms: Math.max(...rows.map(row => Number(row.mtime_ms))),
					title: first?.title ?? null,
					title_source: first?.title_source ?? null,
					title_updated_at: first?.title_updated_at ?? null,
				};
			});
		}

		const readFirst = statement.match(
			/^SELECT seq, content, title, title_source, title_updated_at FROM ([A-Za-z_][A-Za-z0-9_]*) WHERE path = \? ORDER BY seq LIMIT 2$/i,
		);
		if (readFirst) return this.#rowsForPath(readFirst[1], String(values[0])).slice(0, 2);

		const readChunks = statement.match(
			/^SELECT content FROM ([A-Za-z_][A-Za-z0-9_]*) WHERE path = \? ORDER BY seq$/i,
		);
		if (readChunks) return this.#rowsForPath(readChunks[1], String(values[0])).map(row => ({ content: row.content }));

		const maxSeq = statement.match(/^SELECT MAX\(seq\) AS seq FROM ([A-Za-z_][A-Za-z0-9_]*) WHERE path = \?$/i);
		if (maxSeq) {
			const rows = this.#rowsForPath(maxSeq[1], String(values[0]));
			return [{ seq: rows.length === 0 ? null : Math.max(...rows.map(row => Number(row.seq))) }];
		}

		const deleteRows = statement.match(/^DELETE FROM ([A-Za-z_][A-Za-z0-9_]*)(?: WHERE path = \?)?$/i);
		if (deleteRows) {
			const table = this.#requireTable(deleteRows[1]);
			if (/ WHERE path = \?$/i.test(statement)) {
				table.rows = table.rows.filter(row => row.path !== values[0]);
			} else {
				table.rows = [];
			}
			return [];
		}

		throw new Error(`Unsupported SQL in MySQL migration test double: ${statement}`);
	}

	#rowsForPath(tableName: string, path: string): SqlRow[] {
		return this.#requireTable(tableName)
			.rows.filter(row => row.path === path)
			.sort((left, right) => Number(left.seq) - Number(right.seq))
			.map(row => ({ ...row }));
	}

	#atomicRename(renames: readonly (readonly [string, string])[]): void {
		const before = cloneTables(this.#database.tables);
		const sources = new Set(renames.map(([source]) => source));
		for (const [source, destination] of renames) {
			if (!before.has(source)) throw new Error(`Table '${source}' doesn't exist`);
			if (before.has(destination) && !sources.has(destination))
				throw new Error(`Table '${destination}' already exists`);
		}
		for (const [source] of renames) this.#database.tables.delete(source);
		for (const [source, destination] of renames) this.#database.tables.set(destination, before.get(source)!);
	}

	#commitDdl(transaction?: TransactionState): void {
		if (transaction) transaction.rollbackPoint = cloneTables(this.#database.tables);
	}

	async #acquireLock(name: string): Promise<unknown[]> {
		const lock = this.#database.locks.get(name);
		if (!lock) {
			this.#database.locks.set(name, { owner: this.#clientId, depth: 1, waiters: [] });
			return [{ acquired: 1 }];
		}
		if (lock.owner === this.#clientId) {
			lock.depth++;
			return [{ acquired: 1 }];
		}

		const { promise, resolve } = Promise.withResolvers<unknown[]>();
		lock.waiters.push({ owner: this.#clientId, resolve });
		return promise;
	}

	#releaseLock(name: string): unknown[] {
		const lock = this.#database.locks.get(name);
		if (!lock || lock.owner !== this.#clientId) return [{ released: 0 }];
		if (lock.depth > 1) {
			lock.depth--;
			return [{ released: 1 }];
		}

		const next = lock.waiters.shift();
		if (!next) {
			this.#database.locks.delete(name);
		} else {
			lock.owner = next.owner;
			lock.depth = 1;
			next.resolve([{ acquired: 1 }]);
		}
		return [{ released: 1 }];
	}

	#requireTable(name: string): MysqlTable {
		const table = this.#database.tables.get(name);
		if (!table) throw new Error(`Table '${name}' doesn't exist`);
		return table;
	}
}

interface RoutedMysqlQuery {
	physicalConnection: number;
	sql: string;
	values: unknown[];
	result?: unknown[];
}

class RoundRobinMysqlClient implements SqlSessionStorageClient {
	readonly options = { adapter: "mysql" };
	readonly queries: RoutedMysqlQuery[] = [];
	readonly #database: MysqlDatabase;
	readonly #connections: MysqlMigrationClient[];
	#nextConnection = 0;

	constructor(connectionCount = 3) {
		this.#database = new MysqlDatabase();
		this.#connections = Array.from({ length: connectionCount }, () => new MysqlMigrationClient(this.#database));
	}

	async begin<T>(
		callback: (transaction: { unsafe(sql: string, values?: unknown[]): Promise<unknown[]> }) => Promise<T>,
	): Promise<T> {
		return this.#takeConnection().client.begin(callback);
	}

	async unsafe(sql: string, values: unknown[] = []): Promise<unknown[]> {
		const connection = this.#takeConnection();
		const query: RoutedMysqlQuery = { physicalConnection: connection.number, sql, values };
		this.queries.push(query);
		const result = await connection.client.unsafe(sql, values);
		query.result = result;
		return result;
	}

	activeLocks(): Array<{ name: string; physicalConnection: number }> {
		return [...this.#database.locks].map(([name, lock]) => ({ name, physicalConnection: lock.owner }));
	}

	#takeConnection(): { number: number; client: MysqlMigrationClient } {
		const index = this.#nextConnection++ % this.#connections.length;
		return { number: index + 1, client: this.#connections[index]! };
	}
}

class ReservingMysqlClient implements SqlSessionStorageClient {
	readonly options = { adapter: "mysql" };
	readonly queries: RoutedMysqlQuery[] = [];
	readonly pooledQueries: RoutedMysqlQuery[] = [];
	reserveCount = 0;
	releaseCount = 0;
	readonly #database = new MysqlDatabase();
	readonly #connection = new MysqlMigrationClient(this.#database);

	async begin<T>(
		callback: (transaction: { unsafe(sql: string, values?: unknown[]): Promise<unknown[]> }) => Promise<T>,
	): Promise<T> {
		return this.#connection.begin(callback);
	}

	async unsafe(sql: string, values: unknown[] = []): Promise<unknown[]> {
		if (this.#database.locks.size > 0) {
			throw new Error(`initialization escaped the reserved physical connection: ${sql}`);
		}
		const query: RoutedMysqlQuery = { physicalConnection: 1, sql, values };
		this.pooledQueries.push(query);
		const result = await this.#connection.unsafe(sql, values);
		query.result = result;
		return result;
	}

	async reserve() {
		this.reserveCount++;
		return {
			options: this.options,
			begin: <T>(
				callback: (transaction: { unsafe(sql: string, values?: unknown[]): Promise<unknown[]> }) => Promise<T>,
			): Promise<T> => this.#connection.begin(callback),
			unsafe: async (sql: string, values: unknown[] = []): Promise<unknown[]> => {
				const query: RoutedMysqlQuery = { physicalConnection: 1, sql, values };
				this.queries.push(query);
				const result = await this.#connection.unsafe(sql, values);
				query.result = result;
				return result;
			},
			release: () => {
				this.releaseCount++;
			},
		};
	}

	activeLocks(): Array<{ name: string; physicalConnection: number }> {
		return [...this.#database.locks].map(([name, lock]) => ({ name, physicalConnection: lock.owner }));
	}
}

describe("SqlSessionStorage (MySQL advisory-lock connection pinning)", () => {
	it("rejects an unreservable pooled client before GET_LOCK can leak across physical connections", async () => {
		const client = new RoundRobinMysqlClient();
		let failure: unknown;

		try {
			await SqlSessionStorage.create({ client, table: "agent_sessions" });
		} catch (error) {
			failure = error;
		}

		const lockQueries = client.queries.filter(query => /(?:GET|RELEASE)_LOCK/i.test(query.sql));
		expect({
			error: failure instanceof Error ? failure.message : null,
			queries: client.queries,
			lockQueries,
			activeLocks: client.activeLocks(),
		}).toEqual({
			error: "SqlSessionStorage: MySQL initialization requires reserve() to pin advisory locking to one physical connection",
			queries: [],
			lockQueries: [],
			activeLocks: [],
		});
	});

	it("runs GET_LOCK, initialization, and RELEASE_LOCK on one reserved physical connection", async () => {
		const client = new ReservingMysqlClient();

		await SqlSessionStorage.create({ client, table: "agent_sessions" });

		const lockQueries = client.queries.filter(query => /(?:GET|RELEASE)_LOCK/i.test(query.sql));
		expect({
			reservation: { acquired: client.reserveCount, released: client.releaseCount },
			physicalConnections: [...new Set(client.queries.map(query => query.physicalConnection))],
			lockQueries,
			pooledLockQueries: client.pooledQueries.filter(query => /(?:GET|RELEASE)_LOCK/i.test(query.sql)),
			activeLocks: client.activeLocks(),
		}).toEqual({
			reservation: { acquired: 1, released: 1 },
			physicalConnections: [1],
			lockQueries: [
				{
					physicalConnection: 1,
					sql: "SELECT GET_LOCK(?, 30) AS acquired",
					values: ["agent_sessions_da1314c869fc1b11_migration_shadow"],
					result: [{ acquired: 1 }],
				},
				{
					physicalConnection: 1,
					sql: "SELECT RELEASE_LOCK(?) AS released",
					values: ["agent_sessions_da1314c869fc1b11_migration_shadow"],
					result: [{ released: 1 }],
				},
			],
			pooledLockQueries: [],
			activeLocks: [],
		});
	});
});

function legacyRow(overrides: Partial<LegacySqlRow> = {}): LegacySqlRow {
	return {
		path: "/sessions/mysql/legacy.jsonl",
		content: "first line\nsecond line without newline",
		mtime_ms: 1_735_689_845_680,
		title: null,
		title_source: null,
		title_updated_at: null,
		...overrides,
	};
}

describe("SqlSessionStorage (MySQL custom legacy-table migration)", () => {
	it("chunk insert failure before the swap leaves the configured legacy table intact and retryable", async () => {
		const client = new MysqlMigrationClient();
		const original = legacyRow();
		client.seedLegacyTable("agent_sessions", [original]);
		client.failNextChunkInsert = true;

		await expect(SqlSessionStorage.create({ client, table: "agent_sessions" })).rejects.toThrow(
			"injected MySQL migration chunk insert failure",
		);

		expect(client.columns("agent_sessions")).toEqual(LEGACY_COLUMNS);
		expect(client.rows("agent_sessions")).toEqual([original]);

		const recovered = await SqlSessionStorage.create({ client, table: "agent_sessions" });
		expect(await recovered.readText(String(original.path))).toBe(original.content);
		expect(client.tableNames()).toEqual(["agent_sessions"]);
	});

	it("create recovers an interruption immediately after the atomic rename swap", async () => {
		const client = new MysqlMigrationClient();
		const original = legacyRow({
			path: "/sessions/mysql/interrupted.jsonl",
			content: "swap-safe first line\nswap-safe tail",
		});
		client.seedLegacyTable("agent_sessions", [original]);
		client.interruptAfterNextAtomicRename = true;

		await expect(SqlSessionStorage.create({ client, table: "agent_sessions" })).rejects.toThrow(
			"simulated process interruption immediately after atomic rename swap",
		);

		const recovered = await SqlSessionStorage.create({ client, table: "agent_sessions" });
		expect(await recovered.readText(String(original.path))).toBe(original.content);
		expect(client.tableNames()).toEqual(["agent_sessions"]);
	});

	it("successful conversion preserves exact content and title metadata without temp tables", async () => {
		const client = new MysqlMigrationClient();
		const title = {
			title: "Exact MySQL title: 東京 / café",
			source: "user" as const,
			updatedAt: "2026-07-14T12:34:56.789Z",
		};
		const titleLine = serializeTitleSlot(title);
		const headerLine = `${JSON.stringify({ type: "session", id: "mysql-exact", timestamp: "t0", cwd: "/repo" })}\n`;
		const blankLine = "\n";
		const tail = JSON.stringify({
			type: "message",
			id: "m1",
			message: { role: "user", content: "preserve trailing spaces  \n雪" },
		});
		const content = `${titleLine}${headerLine}${blankLine}${tail}`;
		const mtimeMs = 1_735_689_845_681;
		const original = legacyRow({
			path: "/sessions/mysql/exact.jsonl",
			content,
			mtime_ms: mtimeMs,
			title: title.title,
			title_source: title.source,
			title_updated_at: title.updatedAt,
		});
		client.seedLegacyTable("agent_sessions", [original]);

		const storage = await SqlSessionStorage.create({ client, table: "agent_sessions" });

		expect(await storage.readText(String(original.path))).toBe(content);
		expect(storage.statSync(String(original.path))).toMatchObject({ size: Buffer.byteLength(content), mtimeMs });
		expect(client.rows("agent_sessions")).toEqual([
			{
				path: original.path,
				seq: 0,
				content: titleLine,
				mtime_ms: mtimeMs,
				title: title.title,
				title_source: title.source,
				title_updated_at: title.updatedAt,
			},
			{
				path: original.path,
				seq: 1,
				content: headerLine,
				mtime_ms: mtimeMs,
				title: null,
				title_source: null,
				title_updated_at: null,
			},
			{
				path: original.path,
				seq: 2,
				content: blankLine,
				mtime_ms: mtimeMs,
				title: null,
				title_source: null,
				title_updated_at: null,
			},
			{
				path: original.path,
				seq: 3,
				content: tail,
				mtime_ms: mtimeMs,
				title: null,
				title_source: null,
				title_updated_at: null,
			},
		]);
		expect(client.tableNames()).toEqual(["agent_sessions"]);
	});

	it("preserves a populated unowned migration shadow beside a healthy configured table", async () => {
		const client = new MysqlMigrationClient();
		const target = "agent_sessions";
		const shadow = `${target}_migration_shadow`;
		client.seedChunkTable(target, [
			{
				path: "/sessions/mysql/healthy.jsonl",
				seq: 0,
				content: "healthy target",
				mtime_ms: 1_735_689_845_700,
				title: null,
				title_source: null,
				title_updated_at: null,
			},
		]);
		client.seedChunkTable(shadow, [
			{
				path: "/unrelated/shadow.jsonl",
				seq: 7,
				content: "unrelated populated shadow",
				mtime_ms: 1_735_689_845_701,
				title: "must survive",
				title_source: "user",
				title_updated_at: "2026-07-14T13:00:00.000Z",
			},
		]);
		const beforeStartup = client.snapshot();

		try {
			await SqlSessionStorage.create({ client, table: target });
		} catch {}

		expect(client.snapshot()).toEqual(beforeStartup);
	});

	it("preserves a populated unowned migration backup beside a healthy configured table", async () => {
		const client = new MysqlMigrationClient();
		const target = "agent_sessions";
		const backup = `${target}_migration_backup`;
		client.seedChunkTable(target, [
			{
				path: "/sessions/mysql/healthy.jsonl",
				seq: 0,
				content: "healthy target",
				mtime_ms: 1_735_689_845_710,
				title: null,
				title_source: null,
				title_updated_at: null,
			},
		]);
		client.seedChunkTable(backup, [
			{
				path: "/unrelated/backup.jsonl",
				seq: 11,
				content: "unrelated populated backup",
				mtime_ms: 1_735_689_845_711,
				title: "must survive",
				title_source: "user",
				title_updated_at: "2026-07-14T13:01:00.000Z",
			},
		]);
		const beforeStartup = client.snapshot();

		try {
			await SqlSessionStorage.create({ client, table: target });
		} catch {}

		expect(client.snapshot()).toEqual(beforeStartup);
	});

	for (const interruption of ["before", "after"] as const) {
		it(`63-character target names do not share ${interruption === "before" ? "shadow" : "backup"} auxiliaries`, async () => {
			const retainedPrefix = "t".repeat(46);
			const firstTable = `${retainedPrefix}${"a".repeat(17)}`;
			const secondTable = `${retainedPrefix}${"b".repeat(17)}`;
			const client = new MysqlMigrationClient();
			const firstRow = legacyRow({
				path: "/sessions/mysql/long-first.jsonl",
				content: "first long-name payload",
			});
			const secondRow = legacyRow({
				path: "/sessions/mysql/long-second.jsonl",
				content: "second long-name payload",
			});
			client.seedLegacyTable(firstTable, [firstRow]);
			client.seedLegacyTable(secondTable, [secondRow]);
			if (interruption === "before") client.interruptBeforeNextAtomicRename = true;
			else client.interruptAfterNextAtomicRename = true;

			await expect(SqlSessionStorage.create({ client, table: firstTable })).rejects.toThrow(
				`simulated process interruption immediately ${interruption} atomic rename swap`,
			);
			const auxiliaryNames = client.tableNames().filter(name => name !== firstTable && name !== secondTable);
			expect(auxiliaryNames).toHaveLength(1);
			const firstAuxiliary = auxiliaryNames[0]!;
			const firstAuxiliaryContents = client.snapshot().get(firstAuxiliary);

			const secondStorage = await SqlSessionStorage.create({ client, table: secondTable });

			expect(client.snapshot().get(firstAuxiliary)).toEqual(firstAuxiliaryContents);
			const firstStorage = await SqlSessionStorage.create({ client, table: firstTable });
			expect(await firstStorage.readText(firstRow.path)).toBe(firstRow.content);
			expect(await secondStorage.readText(secondRow.path)).toBe(secondRow.content);
			expect(client.tableNames()).toEqual([firstTable, secondTable].sort());
		});
	}

	it("serializes concurrent migration of one configured table across client instances", async () => {
		const database = new MysqlDatabase();
		const firstClient = new MysqlMigrationClient(database);
		const secondClient = new MysqlMigrationClient(database);
		const table = "agent_sessions";
		const original = legacyRow({
			path: "/sessions/mysql/concurrent.jsonl",
			content: "one exact concurrent payload",
			mtime_ms: 1_735_689_845_720,
		});
		firstClient.seedLegacyTable(table, [original]);
		const start = createBarrier(2);
		const create = async (client: MysqlMigrationClient) => {
			await start();
			return SqlSessionStorage.create({ client, table });
		};

		const [firstStorage, secondStorage] = await Promise.all([create(firstClient), create(secondClient)]);

		expect(await firstStorage.readText(original.path)).toBe(original.content);
		expect(await secondStorage.readText(original.path)).toBe(original.content);
		expect(firstClient.atomicRenameCount()).toBe(1);
		expect(firstClient.rows(table)).toEqual([
			{
				path: original.path,
				seq: 0,
				content: original.content,
				mtime_ms: original.mtime_ms,
				title: null,
				title_source: null,
				title_updated_at: null,
			},
		]);
		expect(firstClient.tableNames()).toEqual([table]);
	});
});
