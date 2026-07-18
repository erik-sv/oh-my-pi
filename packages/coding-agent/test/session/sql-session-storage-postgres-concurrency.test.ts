import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";

interface ReservedSqlClient extends SqlSessionStorageClient {
	release(): void;
}

interface StorageHandle {
	pool: InstanceType<typeof SQL>;
	connection: ReservedSqlClient;
	storage: SqlSessionStorage;
	pid: number;
}

interface ChunkRow {
	path: string;
	seq: number;
	content: string;
	title: string | null;
	title_source: string | null;
	title_updated_at: string | null;
}

interface AdvisoryGate {
	namespace: number;
	id: number;
	release(): Promise<void>;
}

interface ChildResult {
	prefix: string;
	acknowledged: string[];
	subjectRole?: string;
	adminCredentialPresent: boolean;
	error?: string;
}

interface RunningChild {
	proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	stdout: Promise<string>;
	stderr: Promise<string>;
}

let uniqueId = 0;
const postgresAdminUrl = process.env.OMP_TEST_POSTGRES_ADMIN_URL;
const postgresRuntimeUrl = process.env.OMP_TEST_POSTGRES_RUNTIME_URL;
const postgresIt = it.skipIf(!postgresAdminUrl || !postgresRuntimeUrl);
const packageRoot = path.resolve(import.meta.dir, "..", "..");
const childProgram = path.join(import.meta.dir, "sql-session-storage-postgres-child.ts");

function nextId(): number {
	uniqueId++;
	return uniqueId;
}

function uniqueTable(): string {
	return `omp_pg_lock_${process.pid}_${Date.now().toString(36)}_${nextId()}`;
}

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function errorMessage(error: unknown): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const credential of [postgresAdminUrl, postgresRuntimeUrl]) {
		if (!credential) continue;
		message = message.replaceAll(credential, "[REDACTED POSTGRES URL]");
		try {
			const password = decodeURIComponent(new URL(credential).password);
			if (password) message = message.replaceAll(password, "[REDACTED POSTGRES PASSWORD]");
		} catch {}
	}
	return message;
}

function settledErrors(results: PromiseSettledResult<unknown>[]): string[] {
	return results.flatMap(result => (result.status === "rejected" ? [errorMessage(result.reason)] : []));
}

function assertContiguous(rows: ChunkRow[], start = 0): void {
	expect(rows.map(row => row.seq)).toEqual(Array.from({ length: rows.length }, (_, index) => start + index));
}

function assertAcknowledgedRows(rows: ChunkRow[], acknowledged: string[]): void {
	assertContiguous(rows);
	expect(rows.map(row => row.content).toSorted()).toEqual(acknowledged.toSorted());
	expect(rows).toHaveLength(acknowledged.length);
}

class PostgresHarness {
	readonly adminUrl: string;
	readonly runtimeUrl: string;
	readonly table: string;
	readonly admin: InstanceType<typeof SQL>;
	readonly pools: InstanceType<typeof SQL>[] = [];
	readonly connections: ReservedSqlClient[] = [];
	readonly functions: string[] = [];
	readonly tables = new Set<string>();
	readonly gates = new Set<{ connection: ReservedSqlClient; namespace: number; id: number }>();
	#runtimeRole: string | undefined;

	constructor(adminUrl: string, runtimeUrl: string) {
		this.adminUrl = adminUrl;
		this.runtimeUrl = runtimeUrl;
		this.table = uniqueTable();
		this.tables.add(this.table);
		this.admin = new SQL(adminUrl);
	}

	get runtimeRole(): string {
		if (!this.#runtimeRole) throw new Error("PostgreSQL harness setup has not resolved the runtime role");
		return this.#runtimeRole;
	}

	async setup(): Promise<void> {
		const identityPool = new SQL(this.runtimeUrl);
		try {
			const roleRows = (await identityPool.unsafe("SELECT current_user AS subject_role")) as Array<{
				subject_role: string;
			}>;
			const runtimeRole = roleRows[0]?.subject_role;
			if (!runtimeRole) throw new Error("PostgreSQL runtime connection did not report current_user");

			await this.admin.unsafe(
				`CREATE TABLE ${this.table} (` +
					"path TEXT NOT NULL, " +
					"seq BIGINT NOT NULL, " +
					"content TEXT NOT NULL, " +
					"mtime_ms BIGINT NOT NULL, " +
					"title TEXT, " +
					"title_source TEXT, " +
					"title_updated_at TEXT, " +
					"PRIMARY KEY (path, seq)" +
					")",
			);
			await this.admin.unsafe(`CREATE INDEX idx_${this.table}_path ON ${this.table} (path)`);
			await this.admin.unsafe(`REVOKE ALL ON TABLE ${this.table} FROM PUBLIC`);
			await this.admin.unsafe(
				`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${this.table} TO ${quoteIdentifier(runtimeRole)}`,
			);
			this.#runtimeRole = runtimeRole;
		} finally {
			await identityPool.end();
		}
	}

	createDdlProbeTableName(): string {
		const table = `${this.table}_ddl_${nextId()}`;
		this.tables.add(table);
		return table;
	}

	async createStorage(): Promise<StorageHandle> {
		const pool = new SQL(this.runtimeUrl);
		this.pools.push(pool);
		const connection = (await pool.reserve()) as ReservedSqlClient;
		this.connections.push(connection);
		const identityRows = (await connection.unsafe(
			"SELECT pg_backend_pid() AS pid, current_user AS subject_role",
		)) as Array<{ pid: number | string; subject_role: string }>;
		const identity = identityRows[0];
		if (identity?.subject_role !== this.runtimeRole) {
			throw new Error(
				`PostgreSQL storage connected as ${String(identity?.subject_role)} instead of runtime role ${this.runtimeRole}`,
			);
		}
		const storage = await SqlSessionStorage.create({
			client: connection,
			adapter: "postgres",
			table: this.table,
			createTable: false,
		});
		return { pool, connection, storage, pid: Number(identity.pid) };
	}

	async rows(paths: string[]): Promise<ChunkRow[]> {
		const placeholders = paths.map((_, index) => `$${index + 1}`).join(", ");
		const rows = (await this.admin.unsafe(
			`SELECT path, seq, content, title, title_source, title_updated_at FROM ${this.table} WHERE path IN (${placeholders}) ORDER BY path, seq`,
			paths,
		)) as Array<Omit<ChunkRow, "seq"> & { seq: number | bigint | string }>;
		return rows.map(row => ({ ...row, seq: Number(row.seq) }));
	}

	async acquireGate(): Promise<AdvisoryGate> {
		const connection = (await this.admin.reserve()) as ReservedSqlClient;
		const gate = {
			connection,
			namespace: Math.abs(process.pid % 2_000_000_000),
			id: Math.abs((Date.now() + nextId()) % 2_000_000_000),
		};
		this.gates.add(gate);
		await connection.unsafe("SELECT pg_advisory_lock($1, $2)", [gate.namespace, gate.id]);
		let released = false;
		return {
			namespace: gate.namespace,
			id: gate.id,
			release: async () => {
				if (released) return;
				released = true;
				await connection.unsafe("SELECT pg_advisory_unlock($1, $2)", [gate.namespace, gate.id]);
				this.gates.delete(gate);
				connection.release();
			},
		};
	}

	async installBlockingTrigger(
		event: "DELETE" | "INSERT" | "UPDATE",
		sessionPath: string,
		gate: AdvisoryGate,
	): Promise<void> {
		const suffix = `${event.toLowerCase()}_${nextId()}`;
		const functionName = `fn_${this.table}_${suffix}`;
		const triggerName = `trg_${suffix}`;
		const record = event === "DELETE" ? "OLD" : "NEW";
		this.functions.push(functionName);
		await this.admin.unsafe(`
			CREATE FUNCTION ${functionName}() RETURNS trigger AS $body$
			BEGIN
				IF ${record}.path = TG_ARGV[0] THEN
					PERFORM pg_advisory_xact_lock(TG_ARGV[1]::integer, TG_ARGV[2]::integer);
				END IF;
				RETURN ${record};
			END
			$body$ LANGUAGE plpgsql
		`);
		await this.admin.unsafe(`GRANT EXECUTE ON FUNCTION ${functionName}() TO ${quoteIdentifier(this.runtimeRole)}`);
		await this.admin.unsafe(
			`CREATE TRIGGER ${triggerName} BEFORE ${event} ON ${this.table} FOR EACH ROW EXECUTE FUNCTION ${functionName}(${quoteLiteral(sessionPath)}, ${quoteLiteral(String(gate.namespace))}, ${quoteLiteral(String(gate.id))})`,
		);
	}

	async installAppendFailureTrigger(sessionPath: string, content: string): Promise<void> {
		const suffix = `failure_${nextId()}`;
		const functionName = `fn_${this.table}_${suffix}`;
		this.functions.push(functionName);
		await this.admin.unsafe(`
			CREATE FUNCTION ${functionName}() RETURNS trigger AS $body$
			BEGIN
				IF NEW.path = TG_ARGV[0] AND NEW.content = TG_ARGV[1] THEN
					RAISE EXCEPTION 'forced PostgreSQL append insert failure';
				END IF;
				RETURN NEW;
			END
			$body$ LANGUAGE plpgsql
		`);
		await this.admin.unsafe(`GRANT EXECUTE ON FUNCTION ${functionName}() TO ${quoteIdentifier(this.runtimeRole)}`);
		await this.admin.unsafe(
			`CREATE TRIGGER trg_${suffix} BEFORE INSERT ON ${this.table} FOR EACH ROW EXECUTE FUNCTION ${functionName}(${quoteLiteral(sessionPath)}, ${quoteLiteral(content)})`,
		);
	}

	async dispose(): Promise<void> {
		const errors: unknown[] = [];
		for (const gate of this.gates) {
			try {
				await gate.connection.unsafe("SELECT pg_advisory_unlock($1, $2)", [gate.namespace, gate.id]);
			} catch (error) {
				errors.push(error);
			}
			try {
				gate.connection.release();
			} catch (error) {
				errors.push(error);
			}
		}
		this.gates.clear();
		for (const connection of this.connections) {
			try {
				connection.release();
			} catch (error) {
				errors.push(error);
			}
		}
		const poolResults = await Promise.allSettled(this.pools.map(pool => pool.end()));
		for (const result of poolResults) if (result.status === "rejected") errors.push(result.reason);
		for (const table of this.tables) {
			try {
				await this.admin.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
			} catch (error) {
				errors.push(error);
			}
		}
		for (const functionName of this.functions) {
			try {
				await this.admin.unsafe(`DROP FUNCTION IF EXISTS ${functionName}() CASCADE`);
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			await this.admin.end();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) {
			throw new AggregateError(errors.map(errorMessage), "PostgreSQL harness cleanup failed");
		}
	}
}

async function waitForBackendLocks(
	admin: InstanceType<typeof SQL>,
	pids: number[],
	signal?: AbortSignal,
): Promise<void> {
	const pidList = pids.map(pid => Math.trunc(pid)).join(", ");
	while (!signal?.aborted) {
		const rows = (await admin.unsafe(
			`SELECT pid, wait_event_type FROM pg_stat_activity WHERE pid IN (${pidList})`,
		)) as Array<{ pid: number | string; wait_event_type: string | null }>;
		const blocked = new Set(rows.filter(row => row.wait_event_type === "Lock").map(row => Number(row.pid)));
		if (pids.every(pid => blocked.has(pid))) return;
	}
	throw new Error("lock wait cancelled");
}

async function waitForAdvisoryWaiters(
	admin: InstanceType<typeof SQL>,
	gate: AdvisoryGate,
	count: number,
	signal?: AbortSignal,
): Promise<void> {
	while (!signal?.aborted) {
		const rows = (await admin.unsafe(
			"SELECT count(*)::integer AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 AND NOT granted",
			[gate.namespace, gate.id],
		)) as Array<{ count: number | string }>;
		if (Number(rows[0]?.count) >= count) return;
	}
	throw new Error("advisory lock wait cancelled");
}

async function waitForBlockedOperations(
	harness: PostgresHarness,
	pids: number[],
	operations: Promise<unknown>[],
): Promise<void> {
	const controller = new AbortController();
	try {
		await Promise.race([
			waitForBackendLocks(harness.admin, pids, controller.signal),
			...operations.map(operation =>
				operation.then(
					() => {
						throw new Error("operation completed before the PostgreSQL race barrier was reached");
					},
					error => {
						throw error;
					},
				),
			),
		]);
	} finally {
		controller.abort();
	}
}

async function waitForBlockedOrSettled(
	harness: PostgresHarness,
	pid: number,
	operation: Promise<unknown>,
): Promise<void> {
	const controller = new AbortController();
	try {
		await Promise.race([
			waitForBackendLocks(harness.admin, [pid], controller.signal),
			operation.then(
				() => undefined,
				error => {
					throw error;
				},
			),
		]);
	} finally {
		controller.abort();
	}
}

async function appendMany(
	storage: SqlSessionStorage,
	lines: string[],
): Promise<{ acknowledged: string[]; errors: string[] }> {
	const writer = storage.openWriter("/sessions/postgres/instances.jsonl");
	const acknowledged: string[] = [];
	const errors: string[] = [];
	for (const line of lines) {
		try {
			await writer.append(line);
			acknowledged.push(line);
		} catch (error) {
			errors.push(errorMessage(error));
			break;
		}
	}
	try {
		await writer.close();
	} catch (error) {
		if (errors.length === 0) errors.push(errorMessage(error));
	}
	return { acknowledged, errors };
}

function spawnAppendChild(
	harness: PostgresHarness,
	sessionPath: string,
	prefix: string,
	count: number,
	gate: AdvisoryGate,
): RunningChild {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => name !== "DATABASE_URL" && !name.startsWith("PG") && !name.startsWith("OMP_TEST_POSTGRES_"),
		),
	);
	Object.assign(env, {
		OMP_TEST_POSTGRES_RUNTIME_URL: harness.runtimeUrl,
		OMP_TEST_SQL_TABLE: harness.table,
		OMP_TEST_SESSION_PATH: sessionPath,
		OMP_TEST_WRITER_PREFIX: prefix,
		OMP_TEST_APPEND_COUNT: String(count),
		OMP_TEST_GATE_NAMESPACE: String(gate.namespace),
		OMP_TEST_GATE_ID: String(gate.id),
	});
	const proc = Bun.spawn(["bun", childProgram], {
		cwd: packageRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	return {
		proc,
		stdout: new Response(proc.stdout).text(),
		stderr: new Response(proc.stderr).text(),
	};
}

function parseChildResult(stdout: string): ChildResult {
	const lines = stdout
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	if (lines.length !== 1) throw new Error(`expected one child result line, received ${JSON.stringify(lines)}`);
	return JSON.parse(lines[0]) as ChildResult;
}

function requirePostgresAdminUrl(): string {
	if (!postgresAdminUrl) throw new Error("OMP_TEST_POSTGRES_ADMIN_URL is required for this test");
	return postgresAdminUrl;
}

function requirePostgresRuntimeUrl(): string {
	if (!postgresRuntimeUrl) throw new Error("OMP_TEST_POSTGRES_RUNTIME_URL is required for this test");
	return postgresRuntimeUrl;
}

async function createPostgresHarness(): Promise<PostgresHarness> {
	const harness = new PostgresHarness(requirePostgresAdminUrl(), requirePostgresRuntimeUrl());
	try {
		await harness.setup();
		return harness;
	} catch (error) {
		await harness.dispose();
		throw error;
	}
}

describe("SqlSessionStorage PostgreSQL path serialization", () => {
	postgresIt(
		"uses admin fixtures while the runtime role cannot create tables",
		async () => {
			const harness = await createPostgresHarness();
			try {
				const handle = await harness.createStorage();
				const ddlProbeTable = harness.createDdlProbeTableName();

				await expect(
					(async () => {
						await handle.connection.unsafe(`CREATE TABLE ${ddlProbeTable} (id BIGINT PRIMARY KEY)`);
					})(),
				).rejects.toThrow();
				const rows = (await harness.admin.unsafe("SELECT to_regclass($1) AS table_name", [
					ddlProbeTable,
				])) as Array<{
					table_name: string | null;
				}>;
				expect(rows[0]?.table_name).toBeNull();
			} finally {
				await harness.dispose();
			}
		},
		60_000,
	);

	postgresIt(
		"keeps every acknowledged append exactly once across independent storage pools",
		async () => {
			const harness = await createPostgresHarness();
			try {
				const first = await harness.createStorage();
				const sessionPath = "/sessions/postgres/instances.jsonl";
				const seed = `${JSON.stringify({ writer: "seed", index: 0 })}\n`;
				await first.storage.writeText(sessionPath, seed);
				const second = await harness.createStorage();
				const firstLines = Array.from(
					{ length: 200 },
					(_, index) => `${JSON.stringify({ writer: "pool-a", index })}\n`,
				);
				const secondLines = Array.from(
					{ length: 200 },
					(_, index) => `${JSON.stringify({ writer: "pool-b", index })}\n`,
				);

				const [firstResult, secondResult] = await Promise.all([
					appendMany(first.storage, firstLines),
					appendMany(second.storage, secondLines),
				]);
				const acknowledged = [seed, ...firstResult.acknowledged, ...secondResult.acknowledged];
				const rows = await harness.rows([sessionPath]);

				assertAcknowledgedRows(rows, acknowledged);
				expect([...firstResult.errors, ...secondResult.errors]).toEqual([]);
				expect(acknowledged).toHaveLength(401);
			} finally {
				await harness.dispose();
			}
		},
		120_000,
	);

	postgresIt(
		"keeps every acknowledged append exactly once across independent Bun processes",
		async () => {
			const harness = await createPostgresHarness();
			const children: RunningChild[] = [];
			try {
				const parent = await harness.createStorage();
				const sessionPath = "/sessions/postgres/processes.jsonl";
				const seed = `${JSON.stringify({ writer: "seed", index: 0 })}\n`;
				await parent.storage.writeText(sessionPath, seed);
				const gate = await harness.acquireGate();
				children.push(
					spawnAppendChild(harness, sessionPath, "process-a", 150, gate),
					spawnAppendChild(harness, sessionPath, "process-b", 150, gate),
				);

				const controller = new AbortController();
				try {
					await Promise.race([
						waitForAdvisoryWaiters(harness.admin, gate, 2, controller.signal),
						...children.map(child =>
							child.proc.exited.then(code => {
								throw new Error(`append child exited with code ${code} before the start barrier opened`);
							}),
						),
					]);
				} finally {
					controller.abort();
				}
				await gate.release();

				const exitCodes = await Promise.all(children.map(child => child.proc.exited));
				const stdout = await Promise.all(children.map(child => child.stdout));
				const stderr = await Promise.all(children.map(child => child.stderr));
				const results = stdout.map(parseChildResult);
				expect(results.map(result => result.subjectRole)).toEqual([harness.runtimeRole, harness.runtimeRole]);
				expect(results.map(result => result.adminCredentialPresent)).toEqual([false, false]);
				const acknowledged = [seed, ...results.flatMap(result => result.acknowledged)];
				const rows = await harness.rows([sessionPath]);

				assertAcknowledgedRows(rows, acknowledged);
				expect(
					results.flatMap((result, index) =>
						result.error ? [`${result.prefix}: ${result.error}\n${stderr[index]}`] : [],
					),
				).toEqual([]);
				expect(exitCodes).toEqual([0, 0]);
				expect(acknowledged).toHaveLength(301);
			} finally {
				for (const child of children) {
					try {
						child.proc.kill();
					} catch {}
				}
				await Promise.allSettled(children.map(child => child.proc.exited));
				await harness.dispose();
			}
		},
		120_000,
	);

	postgresIt(
		"replaces one empty sentinel with both concurrent appends and preserves its title row",
		async () => {
			const harness = await createPostgresHarness();
			try {
				const first = await harness.createStorage();
				const sessionPath = "/sessions/postgres/empty-race.jsonl";
				await first.storage.writeText(sessionPath, "");
				await first.storage.updateSessionTitle(sessionPath, {
					title: "Empty session",
					source: "user",
					updatedAt: "2026-07-18T00:00:00.000Z",
				});
				const second = await harness.createStorage();
				const gate = await harness.acquireGate();
				await harness.installBlockingTrigger("DELETE", sessionPath, gate);
				const firstWriter = first.storage.openWriter(sessionPath);
				const secondWriter = second.storage.openWriter(sessionPath);
				const firstAppend = firstWriter.append('{"writer":"empty-a"}\n');
				await waitForBlockedOperations(harness, [first.pid], [firstAppend]);
				const secondAppend = secondWriter.append('{"writer":"empty-b"}\n');
				await waitForBlockedOperations(harness, [first.pid, second.pid], [firstAppend, secondAppend]);
				await gate.release();

				const results = await Promise.allSettled([firstAppend, secondAppend]);
				expect(settledErrors(results)).toEqual([]);
				await Promise.all([firstWriter.close(), secondWriter.close()]);
				const rows = await harness.rows([sessionPath]);
				assertAcknowledgedRows(rows, ['{"writer":"empty-a"}\n', '{"writer":"empty-b"}\n']);
				expect(rows[0]).toMatchObject({
					title: "Empty session",
					title_source: "user",
					title_updated_at: "2026-07-18T00:00:00.000Z",
				});
			} finally {
				await harness.dispose();
			}
		},
		60_000,
	);

	postgresIt(
		"makes append racing writeText equivalent to one complete serial order",
		async () => {
			const harness = await createPostgresHarness();
			try {
				const replacement = await harness.createStorage();
				const sessionPath = "/sessions/postgres/replace-race.jsonl";
				await replacement.storage.writeText(sessionPath, "old-0\nold-1\nold-2\n");
				const appender = await harness.createStorage();
				const gate = await harness.acquireGate();
				await harness.installBlockingTrigger("INSERT", sessionPath, gate);
				const writer = appender.storage.openWriter(sessionPath);
				const replace = replacement.storage.writeText(sessionPath, "replacement-0\nreplacement-1\n");
				await waitForBlockedOperations(harness, [replacement.pid], [replace]);
				const append = writer.append("concurrent-append\n");
				await waitForBlockedOperations(harness, [replacement.pid, appender.pid], [replace, append]);
				await gate.release();

				const results = await Promise.allSettled([replace, append]);
				expect(settledErrors(results)).toEqual([]);
				await writer.close();
				const rows = await harness.rows([sessionPath]);
				assertContiguous(rows);
				const actual = rows.map(row => ({ seq: row.seq, content: row.content }));
				expect([
					[
						{ seq: 0, content: "replacement-0\n" },
						{ seq: 1, content: "replacement-1\n" },
					],
					[
						{ seq: 0, content: "replacement-0\n" },
						{ seq: 1, content: "replacement-1\n" },
						{ seq: 2, content: "concurrent-append\n" },
					],
				]).toContainEqual(actual);
			} finally {
				await harness.dispose();
			}
		},
		60_000,
	);

	postgresIt(
		"does not lose a concurrent title update when the empty sentinel becomes the first line",
		async () => {
			const harness = await createPostgresHarness();
			try {
				const titleWriter = await harness.createStorage();
				const sessionPath = "/sessions/postgres/title-race.jsonl";
				await titleWriter.storage.writeText(sessionPath, "");
				await titleWriter.storage.updateSessionTitle(sessionPath, {
					title: "Before",
					source: "auto",
					updatedAt: "2026-07-18T00:00:00.000Z",
				});
				const appender = await harness.createStorage();
				const gate = await harness.acquireGate();
				await harness.installBlockingTrigger("UPDATE", sessionPath, gate);
				const update = titleWriter.storage.updateSessionTitle(sessionPath, {
					title: "After",
					source: "user",
					updatedAt: "2026-07-18T00:00:01.000Z",
				});
				await waitForBlockedOperations(harness, [titleWriter.pid], [update]);
				const writer = appender.storage.openWriter(sessionPath);
				const append = writer.append("first-line\n");
				await waitForBlockedOperations(harness, [titleWriter.pid, appender.pid], [update, append]);
				await gate.release();

				const results = await Promise.allSettled([update, append]);
				expect(settledErrors(results)).toEqual([]);
				await writer.close();
				const rows = await harness.rows([sessionPath]);
				expect(rows).toEqual([
					{
						path: sessionPath,
						seq: 0,
						content: "first-line\n",
						title: "After",
						title_source: "user",
						title_updated_at: "2026-07-18T00:00:01.000Z",
					},
				]);
			} finally {
				await harness.dispose();
			}
		},
		60_000,
	);

	postgresIt(
		"makes rename and unlink races with append equivalent to a complete serial order",
		async () => {
			const harness = await createPostgresHarness();
			try {
				const mutator = await harness.createStorage();
				const appender = await harness.createStorage();

				const renameSource = "/sessions/postgres/rename-source.jsonl";
				const renameDestination = "/sessions/postgres/rename-destination.jsonl";
				await mutator.storage.writeText(renameSource, "rename-base\n");
				await appender.storage.refresh();
				const renameGate = await harness.acquireGate();
				await harness.installBlockingTrigger("INSERT", renameSource, renameGate);
				const renameWriter = appender.storage.openWriter(renameSource);
				const renameAppend = renameWriter.append("rename-append\n");
				await waitForBlockedOperations(harness, [appender.pid], [renameAppend]);
				const rename = mutator.storage.rename(renameSource, renameDestination);
				await waitForBlockedOrSettled(harness, mutator.pid, rename);
				await renameGate.release();
				const renameResults = await Promise.allSettled([renameAppend, rename]);
				expect(settledErrors(renameResults)).toEqual([]);
				await renameWriter.close();
				const renamedRows = await harness.rows([renameSource, renameDestination]);
				const renamedState = renamedRows.map(row => ({ path: row.path, seq: row.seq, content: row.content }));
				expect([
					[
						{ path: renameDestination, seq: 0, content: "rename-base\n" },
						{ path: renameDestination, seq: 1, content: "rename-append\n" },
					],
					[
						{ path: renameDestination, seq: 0, content: "rename-base\n" },
						{ path: renameSource, seq: 0, content: "rename-append\n" },
					],
				]).toContainEqual(renamedState);

				const unlinkPath = "/sessions/postgres/unlink-source.jsonl";
				await mutator.storage.writeText(unlinkPath, "unlink-base\n");
				await appender.storage.refresh();
				const unlinkGate = await harness.acquireGate();
				await harness.installBlockingTrigger("INSERT", unlinkPath, unlinkGate);
				const unlinkWriter = appender.storage.openWriter(unlinkPath);
				const unlinkAppend = unlinkWriter.append("unlink-append\n");
				await waitForBlockedOperations(harness, [appender.pid], [unlinkAppend]);
				const unlink = mutator.storage.unlink(unlinkPath);
				await waitForBlockedOrSettled(harness, mutator.pid, unlink);
				await unlinkGate.release();
				const unlinkResults = await Promise.allSettled([unlinkAppend, unlink]);
				expect(settledErrors(unlinkResults)).toEqual([]);
				await unlinkWriter.close();
				const unlinkedRows = await harness.rows([unlinkPath]);
				const unlinkedState = unlinkedRows.map(row => ({ seq: row.seq, content: row.content }));
				expect([[], [{ seq: 0, content: "unlink-append\n" }]]).toContainEqual(unlinkedState);
			} finally {
				await harness.dispose();
			}
		},
		60_000,
	);

	postgresIt(
		"rejects a forced append insert failure without acknowledging partial state",
		async () => {
			const harness = await createPostgresHarness();
			try {
				const handle = await harness.createStorage();
				const sessionPath = "/sessions/postgres/forced-failure.jsonl";
				await handle.storage.writeText(sessionPath, "kept-0\nkept-1\n");
				await harness.installAppendFailureTrigger(sessionPath, "doomed\n");
				const writer = handle.storage.openWriter(sessionPath);

				await expect(writer.append("doomed\n")).rejects.toThrow("forced PostgreSQL append insert failure");
				const rows = await harness.rows([sessionPath]);
				expect(rows.map(row => ({ seq: row.seq, content: row.content }))).toEqual([
					{ seq: 0, content: "kept-0\n" },
					{ seq: 1, content: "kept-1\n" },
				]);
			} finally {
				await harness.dispose();
			}
		},
		60_000,
	);
});
