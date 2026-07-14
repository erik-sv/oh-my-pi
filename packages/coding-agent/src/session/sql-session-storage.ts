import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { toError } from "@oh-my-pi/pi-utils";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "./indexed-session-storage";
import type { SessionTitleUpdate } from "./session-title-slot";

/**
 * Supported `bun:sql` adapter dialects. `Bun.SQL` reports this string on
 * `client.options.adapter`; we detect it once at construction and pick the
 * correct DDL / insert / byte-length syntax for the underlying engine.
 */
export type SqlSessionStorageAdapter = "postgres" | "mysql" | "sqlite";

/**
 * Minimal subset of the `Bun.SQL` instance surface used by
 * {@link SqlSessionStorage}. Bun's SQL client exposes a tagged-template API too,
 * but this implementation intentionally uses `unsafe(query, values)` because
 * the table identifier is validated and then inlined while values remain bound
 * parameters.
 */
interface SqlSessionStorageTransactionClient {
	unsafe(query: string, values?: unknown[]): Promise<unknown[]>;
}

interface SqlSessionStorageReservedClient extends SqlSessionStorageClient {
	release(): void;
}

export interface SqlSessionStorageClient extends SqlSessionStorageTransactionClient {
	/** Run the callback on one connection inside a database transaction. */
	begin<T>(callback: (transaction: SqlSessionStorageTransactionClient) => Promise<T>): Promise<T>;
	/**
	 * `Bun.SQL` exposes the parsed connection options here. We only consult
	 * `adapter` to pick the dialect; the field is typed as
	 * `string | undefined` so the real `Bun.SQL` instance type slots in
	 * without casting (it reports `string | undefined` across adapters).
	 */
	options: { adapter?: string; [key: string]: unknown };
	end?(): Promise<void>;
	/** Reserve one physical connection for connection-scoped MySQL advisory locks. */
	reserve?(): Promise<SqlSessionStorageReservedClient>;
}

export interface SqlSessionStorageOptions {
	/** Connected `Bun.SQL` instance (PostgreSQL, MySQL, or SQLite). */
	client: SqlSessionStorageClient;
	/**
	 * Override the auto-detected adapter. Useful when the client is wrapped
	 * (e.g. by a pool) and `client.options.adapter` is unreliable.
	 */
	adapter?: SqlSessionStorageAdapter;
	/**
	 * Table name to use. Default: `omp_session_chunks`. Must match
	 * `[A-Za-z_][A-Za-z0-9_]{0,62}` — inlined into prepared statements at
	 * startup, so we accept identifier-safe inputs only (no quoted/dotted
	 * names).
	 */
	table?: string;
	/**
	 * If true, run `CREATE TABLE IF NOT EXISTS` (+ supporting index) during
	 * `create()`. Default: true. Disable when the table is owned by an
	 * external migration.
	 */
	createTable?: boolean;
}

interface DialectQueries {
	createTable: string;
	/** Supporting index for prefix listing. Empty when the PK already covers it (MySQL). */
	createIndex: string;
	/** Add title metadata columns to existing chunk tables created before title fields existed. */
	addTitleColumns: readonly string[];
	/** Update indexed title metadata without rewriting transcript chunks. */
	updateTitle: string;
	delete: string;
	rename: string;
	loadIndex: string;
	readChunks: string;
	readFirstChunks: string;
	maxSeq: string;
}

interface IndexRow {
	path: string;
	byte_len: number | bigint | string | null;
	mtime_ms: number | bigint | string | null;
	title?: string | null;
	title_source?: string | null;
	title_updated_at?: string | null;
}

interface ChunkRow {
	seq?: number | bigint | string;
	content: string;
	title?: string | null;
	title_source?: string | null;
	title_updated_at?: string | null;
}

interface LegacyRow {
	path: string;
	content: string;
	mtime_ms: number | bigint | string;
	title?: string | null;
	title_source?: string | null;
	title_updated_at?: string | null;
}

interface SeqRow {
	seq: number | bigint | string | null;
}

const DEFAULT_TABLE = "omp_session_chunks";
const LEGACY_TABLE = "omp_session_files";
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// Cap rows per batched INSERT below PostgreSQL's bound-parameter ceiling.
const MAX_INSERT_ROWS = 500;
const MYSQL_MIGRATION_SHADOW_SUFFIX = "_migration_shadow";
const MYSQL_MIGRATION_BACKUP_SUFFIX = "_migration_backup";

function mysqlMigrationTableName(table: string, suffix: string): string {
	const fingerprint = createHash("sha256").update(table).digest("hex").slice(0, 16);
	const prefixLength = 63 - fingerprint.length - suffix.length - 1;
	const name = `${table.slice(0, prefixLength)}_${fingerprint}${suffix}`;
	if (!IDENT_RE.test(name)) throw new Error(`SqlSessionStorage: invalid internal migration table name ${name}`);
	return name;
}

function enoent(p: string): NodeJS.ErrnoException {
	const err = new Error(`ENOENT: no such file, '${p}'`) as NodeJS.ErrnoException;
	err.code = "ENOENT";
	err.errno = -2;
	err.path = p;
	err.syscall = "open";
	return err;
}

/**
 * Split a full file body into per-line chunks, each retaining its trailing
 * `"\n"`. A final newline-less remainder is kept as its own chunk.
 *
 * The empty string is represented by one empty chunk so a zero-byte file still
 * has a durable database row and appears in metadata indexes after refresh.
 */
function splitChunks(content: string): string[] {
	if (content.length === 0) return [""];
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10 /* "\n" */) {
			out.push(content.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < content.length) out.push(content.slice(start));
	return out;
}

function detectAdapter(client: SqlSessionStorageClient): SqlSessionStorageAdapter {
	const reported = String(client.options?.adapter ?? "").toLowerCase();
	if (reported === "postgres" || reported === "postgresql" || reported === "pg") return "postgres";
	if (reported === "mysql" || reported === "mariadb") return "mysql";
	if (reported === "sqlite" || reported === "sqlite3") return "sqlite";
	throw new Error(
		`SqlSessionStorage: unable to infer adapter from client.options.adapter=${JSON.stringify(reported)}. ` +
			`Pass an explicit \`adapter\` option ("postgres" | "mysql" | "sqlite").`,
	);
}

function buildQueries(adapter: SqlSessionStorageAdapter, table: string): DialectQueries {
	const placeholder = adapter === "postgres" ? (n: number): string => `$${n}` : (_n: number): string => "?";
	const byteLengthExpr =
		adapter === "mysql"
			? "OCTET_LENGTH(content)"
			: adapter === "postgres"
				? "octet_length(content)"
				: "length(cast(content AS blob))";

	if (adapter === "mysql") {
		return {
			createTable:
				`CREATE TABLE IF NOT EXISTS ${table} (` +
				`path VARCHAR(512) NOT NULL, ` +
				`seq BIGINT NOT NULL, ` +
				`content LONGTEXT NOT NULL, ` +
				`mtime_ms BIGINT NOT NULL, ` +
				`title TEXT NULL, ` +
				`title_source VARCHAR(16) NULL, ` +
				`title_updated_at VARCHAR(64) NULL, ` +
				`PRIMARY KEY (path, seq)` +
				`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
			// `path` is the leftmost PK column, so prefix LIKE scans already use
			// the primary index - no secondary index needed (and MySQL lacks
			// `CREATE INDEX IF NOT EXISTS`).
			createIndex: "",
			addTitleColumns: [
				`ALTER TABLE ${table} ADD COLUMN title TEXT NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_source VARCHAR(16) NULL`,
				`ALTER TABLE ${table} ADD COLUMN title_updated_at VARCHAR(64) NULL`,
			],
			updateTitle: `UPDATE ${table} SET title = ?, title_source = ?, title_updated_at = ?, mtime_ms = ? WHERE path = ? AND seq = 0`,
			delete: `DELETE FROM ${table} WHERE path = ?`,
			rename: `UPDATE ${table} SET path = ?, mtime_ms = ? WHERE path = ?`,
			loadIndex:
				`SELECT path, SUM(${byteLengthExpr}) AS byte_len, MAX(mtime_ms) AS mtime_ms, ` +
				`MAX(CASE WHEN seq = 0 THEN title END) AS title, ` +
				`MAX(CASE WHEN seq = 0 THEN title_source END) AS title_source, ` +
				`MAX(CASE WHEN seq = 0 THEN title_updated_at END) AS title_updated_at ` +
				`FROM ${table} GROUP BY path`,
			readChunks: `SELECT content FROM ${table} WHERE path = ? ORDER BY seq`,
			readFirstChunks: `SELECT seq, content, title, title_source, title_updated_at FROM ${table} WHERE path = ? ORDER BY seq LIMIT 2`,
			maxSeq: `SELECT MAX(seq) AS seq FROM ${table} WHERE path = ?`,
		};
	}

	// PostgreSQL + SQLite — both support `CREATE INDEX IF NOT EXISTS` and the
	// same INSERT/DELETE syntax; only the integer type name and placeholder style differ.
	const intType = adapter === "postgres" ? "BIGINT" : "INTEGER";
	return {
		createTable:
			`CREATE TABLE IF NOT EXISTS ${table} (` +
			`path TEXT NOT NULL, ` +
			`seq ${intType} NOT NULL, ` +
			`content TEXT NOT NULL, ` +
			`mtime_ms ${intType} NOT NULL, ` +
			`title TEXT, ` +
			`title_source TEXT, ` +
			`title_updated_at TEXT, ` +
			`PRIMARY KEY (path, seq)` +
			`)`,
		createIndex: `CREATE INDEX IF NOT EXISTS idx_${table}_path ON ${table} (path)`,
		addTitleColumns: [
			`ALTER TABLE ${table} ADD COLUMN title TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_source TEXT`,
			`ALTER TABLE ${table} ADD COLUMN title_updated_at TEXT`,
		],
		updateTitle: `UPDATE ${table} SET title = ${placeholder(1)}, title_source = ${placeholder(2)}, title_updated_at = ${placeholder(3)}, mtime_ms = ${placeholder(4)} WHERE path = ${placeholder(5)} AND seq = 0`,
		delete: `DELETE FROM ${table} WHERE path = ${placeholder(1)}`,
		rename: `UPDATE ${table} SET path = ${placeholder(1)}, mtime_ms = ${placeholder(2)} WHERE path = ${placeholder(3)}`,
		loadIndex:
			`SELECT path, SUM(${byteLengthExpr}) AS byte_len, MAX(mtime_ms) AS mtime_ms, ` +
			`MAX(CASE WHEN seq = 0 THEN title END) AS title, ` +
			`MAX(CASE WHEN seq = 0 THEN title_source END) AS title_source, ` +
			`MAX(CASE WHEN seq = 0 THEN title_updated_at END) AS title_updated_at ` +
			`FROM ${table} GROUP BY path`,
		readChunks: `SELECT content FROM ${table} WHERE path = ${placeholder(1)} ORDER BY seq`,
		readFirstChunks: `SELECT seq, content, title, title_source, title_updated_at FROM ${table} WHERE path = ${placeholder(1)} ORDER BY seq LIMIT 2`,
		maxSeq: `SELECT MAX(seq) AS seq FROM ${table} WHERE path = ${placeholder(1)}`,
	};
}

function toNumber(value: number | bigint | string | null | undefined): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return Number.parseInt(value, 10);
}
function rowTitleSource(value: string | null | undefined): SessionTitleUpdate["source"] | undefined {
	return value === "auto" || value === "user" ? value : undefined;
}

function rowTitleUpdate(row: ChunkRow): SessionTitleUpdate | undefined {
	if (!row.title_updated_at) return undefined;
	return {
		title: row.title ?? undefined,
		source: rowTitleSource(row.title_source),
		updatedAt: row.title_updated_at,
	};
}

function isDuplicateColumnError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes("duplicate column") || message.includes("already exists");
}

function bytePrefix(chunks: readonly string[], maxBytes: number): string {
	if (!(maxBytes > 0)) return "";
	let remaining = Math.trunc(maxBytes);
	const buffers: Buffer[] = [];
	let total = 0;
	for (const chunk of chunks) {
		if (remaining <= 0) break;
		const buf = Buffer.from(chunk, "utf-8");
		const take = Math.min(remaining, buf.byteLength);
		buffers.push(take === buf.byteLength ? buf : buf.subarray(0, take));
		remaining -= take;
		total += take;
	}
	return Buffer.concat(buffers, total).toString("utf-8");
}

function byteSuffix(chunks: readonly string[], maxBytes: number): string {
	if (!(maxBytes > 0)) return "";
	let remaining = Math.trunc(maxBytes);
	const buffers: Buffer[] = [];
	let total = 0;
	for (let i = chunks.length - 1; i >= 0; i--) {
		if (remaining <= 0) break;
		const buf = Buffer.from(chunks[i], "utf-8");
		const take = Math.min(remaining, buf.byteLength);
		buffers.push(take === buf.byteLength ? buf : buf.subarray(buf.byteLength - take));
		remaining -= take;
		total += take;
	}
	buffers.reverse();
	return Buffer.concat(buffers, total).toString("utf-8");
}

/**
 * SQL-backed implementation of {@link SessionStorage} using `bun:sql`. Each
 * session JSONL file is stored as an append-only set of chunk rows — one row per
 * JSONL line, keyed by `(path, seq)`. The full file body for a path is the
 * concatenation of its `content` columns in ascending `seq` order.
 *
 * Why chunk rows instead of one growing blob: Postgres (and every other engine
 * here) stores TEXT values immutably, so appending to a single-blob row rewrites
 * the entire value on every line — O(n) per append, O(n²) over a transcript.
 * One row per line makes each append a single O(1) INSERT.
 */
export class SqlSessionStorage extends IndexedSessionStorage {
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;

	constructor(backend: SessionStorageBackend, adapter: SqlSessionStorageAdapter, table: string) {
		super(backend);
		this.#adapter = adapter;
		this.#table = table;
	}

	/**
	 * Apply the dialect-correct DDL (unless `createTable: false` is set) and warm
	 * the metadata index with every existing path. Must be awaited before passing
	 * the storage into `SessionManager.create()`.
	 */
	static async create(options: SqlSessionStorageOptions): Promise<SqlSessionStorage> {
		const backend = new SqlSessionStorageBackend(options);
		const storage = new SqlSessionStorage(backend, backend.adapter, backend.table);
		await storage.initialize();
		return storage;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		await super.deleteSessionWithArtifacts(sessionPath);
		const artifactsDir = sessionPath.slice(0, -6);
		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session rows deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{ cause: error },
			);
		}
	}
}

class SqlSessionStorageBackend implements SessionStorageBackend {
	readonly #client: SqlSessionStorageClient;
	readonly #adapter: SqlSessionStorageAdapter;
	readonly #table: string;
	readonly #q: DialectQueries;
	readonly #createTable: boolean;

	constructor(options: SqlSessionStorageOptions) {
		this.#client = options.client;
		this.#adapter = options.adapter ?? detectAdapter(options.client);
		const table = options.table ?? DEFAULT_TABLE;
		if (!IDENT_RE.test(table)) {
			throw new Error(`SqlSessionStorage: table name must match ${IDENT_RE.source} (got ${JSON.stringify(table)})`);
		}
		this.#table = table;
		this.#q = buildQueries(this.#adapter, table);
		this.#createTable = options.createTable !== false;
	}

	get adapter(): SqlSessionStorageAdapter {
		return this.#adapter;
	}

	get table(): string {
		return this.#table;
	}

	async init(): Promise<void> {
		if (!this.#createTable) return;
		if (this.#adapter !== "mysql") {
			await this.#initTables(this.#client);
			return;
		}

		if (!this.#client.reserve) {
			throw new Error(
				"SqlSessionStorage: MySQL initialization requires reserve() to pin advisory locking to one physical connection",
			);
		}
		const client = await this.#client.reserve();
		const lockName = mysqlMigrationTableName(this.#table, MYSQL_MIGRATION_SHADOW_SUFFIX);
		let locked = false;
		try {
			const rows = (await client.unsafe("SELECT GET_LOCK(?, 30) AS acquired", [lockName])) as Array<{
				acquired?: number | bigint | string | null;
			}>;
			locked = toNumber(rows[0]?.acquired ?? 0) === 1;
			if (!locked) throw new Error(`SqlSessionStorage: timed out waiting for MySQL migration lock ${lockName}`);
			await this.#initTables(client);
		} finally {
			try {
				if (locked) await client.unsafe("SELECT RELEASE_LOCK(?) AS released", [lockName]);
			} finally {
				client.release();
			}
		}
	}

	async #initTables(client: SqlSessionStorageClient): Promise<void> {
		const columns =
			this.#adapter === "mysql"
				? await this.#recoverMysqlLegacyMigration(client)
				: await this.#tableColumns(client, this.#table);
		if (columns.has("content") && !columns.has("seq")) {
			await this.#migrateLegacyTableInPlace(client, columns);
		} else {
			await client.unsafe(this.#q.createTable);
		}
		if (this.#q.createIndex) await client.unsafe(this.#q.createIndex);
		for (const query of this.#q.addTitleColumns) {
			try {
				await client.unsafe(query);
			} catch (err) {
				if (!isDuplicateColumnError(err)) throw err;
			}
		}
		if (this.#table === DEFAULT_TABLE) await this.#migrateDefaultLegacyRows(client);
	}

	async loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		const rows = (await this.#client.unsafe(this.#q.loadIndex)) as IndexRow[];
		return rows.map(row => ({
			path: row.path,
			size: toNumber(row.byte_len),
			mtimeMs: toNumber(row.mtime_ms),
			title: row.title ?? undefined,
			titleSource: rowTitleSource(row.title_source),
			titleUpdatedAt: row.title_updated_at ?? undefined,
		}));
	}

	async readFull(path: string): Promise<string | null> {
		const chunks = await this.#readChunks(path);
		return chunks.length === 0 ? null : chunks.join("");
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const chunks = await this.#readChunks(path);
		if (chunks.length === 0) throw enoent(path);
		return [bytePrefix(chunks, prefixBytes), byteSuffix(chunks, suffixBytes)];
	}

	async writeFull(path: string, content: string, mtimeMs: number, title?: SessionTitleUpdate): Promise<void> {
		await this.#client.begin(async transaction => {
			await transaction.unsafe(this.#q.delete, [path]);
			await this.#insertChunks(transaction, path, splitChunks(content), mtimeMs, 0, title);
		});
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number): Promise<void> {
		await this.#client.unsafe(this.#q.updateTitle, [
			title.title ?? null,
			title.source ?? null,
			title.updatedAt,
			mtimeMs,
			path,
		]);
	}

	async append(path: string, line: string, mtimeMs: number): Promise<void> {
		const firstChunks = (await this.#client.unsafe(this.#q.readFirstChunks, [path])) as ChunkRow[];
		if (firstChunks.length === 1 && firstChunks[0].content === "") {
			const title = rowTitleUpdate(firstChunks[0]);
			await this.#client.begin(async transaction => {
				await transaction.unsafe(this.#q.delete, [path]);
				await this.#insertChunks(transaction, path, [line], mtimeMs, 0, title);
			});
			return;
		}
		const lastFirstSeq = firstChunks.length === 1 ? toNumber(firstChunks[0].seq) + 1 : undefined;
		const seq = lastFirstSeq ?? (await this.#nextSeq(this.#client, path));
		await this.#insertChunks(this.#client, path, [line], mtimeMs, seq);
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		await this.writeFull(path, "", mtimeMs);
	}

	async remove(paths: string[]): Promise<void> {
		await this.#client.begin(async transaction => {
			for (const path of paths) await transaction.unsafe(this.#q.delete, [path]);
		});
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		await this.#client.begin(async transaction => {
			await transaction.unsafe(this.#q.delete, [dst]);
			await transaction.unsafe(this.#q.rename, [dst, mtimeMs, src]);
		});
	}

	async #migrateDefaultLegacyRows(client: SqlSessionStorageClient): Promise<void> {
		const columns = await this.#tableColumns(client, LEGACY_TABLE);
		if (!columns.has("content") || columns.has("seq")) return;

		await client.begin(async transaction => {
			const rows = await this.#readLegacyRows(transaction, LEGACY_TABLE, columns, true);
			for (const row of rows) {
				const current = (await transaction.unsafe(this.#q.maxSeq, [row.path])) as SeqRow[];
				if (current[0]?.seq !== null && current[0]?.seq !== undefined) continue;
				await this.#insertLegacyRow(transaction, row);
			}
			await transaction.unsafe(`DELETE FROM ${LEGACY_TABLE}`);
		});
	}

	async #migrateLegacyTableInPlace(client: SqlSessionStorageClient, columns: ReadonlySet<string>): Promise<void> {
		if (this.#adapter === "mysql") {
			await this.#migrateMysqlLegacyTable(client, columns);
			return;
		}

		const legacyTable = `${this.#table.slice(0, 40)}_legacy_migration`;
		if ((await this.#tableColumns(client, legacyTable)).size > 0) {
			throw new Error(`SqlSessionStorage: stale migration table ${legacyTable} already exists`);
		}
		await client.begin(async transaction => {
			await transaction.unsafe(`ALTER TABLE ${this.#table} RENAME TO ${legacyTable}`);
			await transaction.unsafe(this.#q.createTable);
			const rows = await this.#readLegacyRows(transaction, legacyTable, columns, false);
			for (const row of rows) await this.#insertLegacyRow(transaction, row);
			await transaction.unsafe(`DROP TABLE ${legacyTable}`);
		});
	}

	async #recoverMysqlLegacyMigration(client: SqlSessionStorageClient): Promise<Set<string>> {
		const shadow = mysqlMigrationTableName(this.#table, MYSQL_MIGRATION_SHADOW_SUFFIX);
		const backup = mysqlMigrationTableName(this.#table, MYSQL_MIGRATION_BACKUP_SUFFIX);
		const [columns, shadowColumns, backupColumns] = await Promise.all([
			this.#tableColumns(client, this.#table),
			this.#tableColumns(client, shadow),
			this.#tableColumns(client, backup),
		]);

		if (backupColumns.size > 0) {
			if (!backupColumns.has("content") || backupColumns.has("seq") || shadowColumns.size > 0) {
				throw new Error(`SqlSessionStorage: unowned MySQL migration backup for ${this.#table}`);
			}
			if (columns.has("seq")) {
				try {
					await client.unsafe(this.#q.loadIndex);
				} catch (error) {
					await client.unsafe(`RENAME TABLE ${this.#table} TO ${shadow}, ${backup} TO ${this.#table}`);
					await client.unsafe(`DROP TABLE IF EXISTS ${shadow}`);
					throw error;
				}
				await client.unsafe(`DROP TABLE IF EXISTS ${backup}`);
				return columns;
			}

			if (columns.size === 0) {
				await client.unsafe(`RENAME TABLE ${backup} TO ${this.#table}`);
				return this.#tableColumns(client, this.#table);
			}

			throw new Error(`SqlSessionStorage: ambiguous MySQL migration state for ${this.#table}`);
		}

		if (shadowColumns.size > 0) {
			if (!columns.has("content") || columns.has("seq")) {
				throw new Error(`SqlSessionStorage: unowned MySQL migration shadow for ${this.#table}`);
			}
			await client.unsafe(`DROP TABLE IF EXISTS ${shadow}`);
		}
		return columns;
	}

	async #migrateMysqlLegacyTable(client: SqlSessionStorageClient, columns: ReadonlySet<string>): Promise<void> {
		const shadow = mysqlMigrationTableName(this.#table, MYSQL_MIGRATION_SHADOW_SUFFIX);
		const backup = mysqlMigrationTableName(this.#table, MYSQL_MIGRATION_BACKUP_SUFFIX);
		await client.unsafe(buildQueries("mysql", shadow).createTable);
		await client.begin(async transaction => {
			const rows = await this.#readLegacyRows(transaction, this.#table, columns, true);
			for (const row of rows) await this.#insertLegacyRow(transaction, row, shadow);
		});
		await client.unsafe(`RENAME TABLE ${this.#table} TO ${backup}, ${shadow} TO ${this.#table}`);
		await client.unsafe(this.#q.loadIndex);
		await client.unsafe(`DROP TABLE IF EXISTS ${backup}`);
	}

	async #tableColumns(client: SqlSessionStorageTransactionClient, table: string): Promise<Set<string>> {
		let rows: Array<{ name?: string; column_name?: string }>;
		if (this.#adapter === "sqlite") {
			rows = (await client.unsafe(`PRAGMA table_info(${table})`)) as typeof rows;
		} else if (this.#adapter === "postgres") {
			rows = (await client.unsafe(
				"SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
				[table],
			)) as typeof rows;
		} else {
			rows = (await client.unsafe(
				"SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?",
				[table],
			)) as typeof rows;
		}
		return new Set(rows.map(row => (row.name ?? row.column_name ?? "").toLowerCase()).filter(Boolean));
	}

	async #readLegacyRows(
		client: SqlSessionStorageTransactionClient,
		table: string,
		columns: ReadonlySet<string>,
		lock: boolean,
	): Promise<LegacyRow[]> {
		const selectColumn = (name: string): string => (columns.has(name) ? name : `NULL AS ${name}`);
		const lockClause = lock && this.#adapter !== "sqlite" ? " FOR UPDATE" : "";
		return (await client.unsafe(
			`SELECT path, content, mtime_ms, ${selectColumn("title")}, ${selectColumn("title_source")}, ${selectColumn("title_updated_at")} FROM ${table}${lockClause}`,
		)) as LegacyRow[];
	}

	async #insertLegacyRow(
		client: SqlSessionStorageTransactionClient,
		row: LegacyRow,
		table = this.#table,
	): Promise<void> {
		const title = row.title_updated_at
			? {
					title: row.title ?? undefined,
					source: rowTitleSource(row.title_source),
					updatedAt: row.title_updated_at,
				}
			: undefined;
		await this.#insertChunks(client, row.path, splitChunks(row.content), toNumber(row.mtime_ms), 0, title, table);
	}
	async #readChunks(path: string): Promise<string[]> {
		const rows = (await this.#client.unsafe(this.#q.readChunks, [path])) as ChunkRow[];
		return rows.map(row => row.content);
	}

	async #nextSeq(client: SqlSessionStorageTransactionClient, path: string): Promise<number> {
		const rows = (await client.unsafe(this.#q.maxSeq, [path])) as SeqRow[];
		const max = rows[0]?.seq;
		return max === null || max === undefined ? 0 : toNumber(max) + 1;
	}

	async #insertChunks(
		client: SqlSessionStorageTransactionClient,
		path: string,
		chunks: readonly string[],
		mtimeMs: number,
		startSeq = 0,
		title?: SessionTitleUpdate,
		table = this.#table,
	): Promise<void> {
		for (let offset = 0; offset < chunks.length; offset += MAX_INSERT_ROWS) {
			const batch = chunks.slice(offset, offset + MAX_INSERT_ROWS);
			const values: unknown[] = [];
			let param = 1;
			const rows = batch.map((chunk, index) => {
				const seq = startSeq + offset + index;
				const rowTitle = seq === 0 ? title : undefined;
				values.push(
					path,
					seq,
					chunk,
					mtimeMs,
					rowTitle?.title ?? null,
					rowTitle?.source ?? null,
					rowTitle?.updatedAt ?? null,
				);
				if (this.#adapter === "postgres") {
					const row =
						`($${param}, $${param + 1}, $${param + 2}, $${param + 3}, ` +
						`$${param + 4}, $${param + 5}, $${param + 6})`;
					param += 7;
					return row;
				}
				return "(?, ?, ?, ?, ?, ?, ?)";
			});
			await client.unsafe(
				`INSERT INTO ${table} ` +
					`(path, seq, content, mtime_ms, title, title_source, title_updated_at) ` +
					`VALUES ${rows.join(", ")}`,
				values,
			);
		}
	}
}
