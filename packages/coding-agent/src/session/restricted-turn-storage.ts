import {
	canonicalRestrictedJson,
	type RestrictedEngineeringDatabaseReceipt,
	restrictedSha256,
} from "../modes/rpc/restricted-rpc-profile";
import type { SessionMessageEntry } from "./session-entries";
import type { SqlSessionStorageClient } from "./sql-session-storage";

export const RESTRICTED_SCHEMA_CONTRACT_NAME = "agentdesk_restricted_rpc" as const;
export const RESTRICTED_SCHEMA_CONTRACT_VERSION = 1 as const;
export const RESTRICTED_TURNS_TABLE = "omp_restricted_rpc_turns" as const;

const descriptorRecords = [
	["column", "public", "agentdesk_database_identity", 1, "database_instance_uuid", "uuid", false],
	["column", "public", "agentdesk_database_identity", 2, "created_at", "timestamptz", false],
	["column", "public", "omp_schema_contracts", 1, "contract_name", "text", false],
	["column", "public", "omp_schema_contracts", 2, "contract_version", "int4", false],
	["column", "public", "omp_schema_contracts", 3, "required_pg_min", "int4", false],
	["column", "public", "omp_schema_contracts", 4, "required_pg_max", "int4", false],
	["column", "public", "omp_schema_contracts", 5, "descriptor_bytes", "bytea", false],
	["column", "public", "omp_schema_contracts", 6, "digest", "text", false],
	["column", "public", "omp_schema_contracts", 7, "created_at", "timestamptz", false],
	["column", "public", "omp_session_chunks", 1, "path", "text", false],
	["column", "public", "omp_session_chunks", 2, "seq", "int8", false],
	["column", "public", "omp_session_chunks", 3, "content", "text", false],
	["column", "public", "omp_session_chunks", 4, "mtime_ms", "int8", false],
	["column", "public", "omp_session_chunks", 5, "title", "text", true],
	["column", "public", "omp_session_chunks", 6, "title_source", "text", true],
	["column", "public", "omp_session_chunks", 7, "title_updated_at", "text", true],
	["column", "public", RESTRICTED_TURNS_TABLE, 1, "client_turn_id", "uuid", false],
	["column", "public", RESTRICTED_TURNS_TABLE, 2, "session_id", "text", false],
	["column", "public", RESTRICTED_TURNS_TABLE, 3, "accepted_turn_id", "uuid", false],
	["column", "public", RESTRICTED_TURNS_TABLE, 4, "prompt_bytes", "text", false],
	["column", "public", RESTRICTED_TURNS_TABLE, 5, "prompt_digest", "text", false],
	["column", "public", RESTRICTED_TURNS_TABLE, 6, "state", "text", false],
	["column", "public", RESTRICTED_TURNS_TABLE, 7, "accepted_at", "timestamptz", false],
	["column", "public", RESTRICTED_TURNS_TABLE, 8, "activation_started_at", "timestamptz", true],
	["column", "public", RESTRICTED_TURNS_TABLE, 9, "active_at", "timestamptz", true],
	["column", "public", RESTRICTED_TURNS_TABLE, 10, "terminal_status", "text", true],
	["column", "public", RESTRICTED_TURNS_TABLE, 11, "terminal_entry_event_digest", "text", true],
	["column", "public", RESTRICTED_TURNS_TABLE, 12, "ordered_tool_call_digest", "text", true],
	["column", "public", RESTRICTED_TURNS_TABLE, 13, "high_water_mark", "int8", true],
	["column", "public", RESTRICTED_TURNS_TABLE, 14, "terminal_at", "timestamptz", true],
] as const;

const definitionToken = (definition: unknown): string =>
	`v1:${Buffer.from(canonicalRestrictedJson(definition), "utf-8").toString("base64url")}`;

const columnDescriptors = descriptorRecords.map(([kind, schema, object, ordinal, name, type, nullable]) => ({
	kind,
	schema,
	object,
	ordinal,
	name,
	type,
	nullable,
	default: null,
	definition: null,
	privilege: null,
}));
const constraintDescriptorRecords: ReadonlyArray<readonly [string, string, unknown]> = [
	["agentdesk_database_identity", "agentdesk_database_identity_pkey", ["pk", ["database_instance_uuid"]]],
	["omp_schema_contracts", "omp_schema_contracts_pkey", ["pk", ["contract_name", "contract_version"]]],
	["omp_session_chunks", "omp_session_chunks_pkey", ["pk", ["path", "seq"]]],
	[RESTRICTED_TURNS_TABLE, "omp_restricted_rpc_turns_accepted_turn_id_key", ["unique", ["accepted_turn_id"], false]],
	[RESTRICTED_TURNS_TABLE, "omp_restricted_rpc_turns_high_water_mark_check", ["check-name", "high_water_mark"]],
	[RESTRICTED_TURNS_TABLE, "omp_restricted_rpc_turns_pkey", ["pk", ["client_turn_id"]]],
	[RESTRICTED_TURNS_TABLE, "omp_restricted_rpc_turns_prompt_digest_check", ["check-name", "prompt_digest"]],
	[RESTRICTED_TURNS_TABLE, "omp_restricted_rpc_turns_session_id_key", ["unique", ["session_id"], false]],
	[RESTRICTED_TURNS_TABLE, "omp_restricted_rpc_turns_state_check", ["check-name", "state"]],
	[RESTRICTED_TURNS_TABLE, "omp_restricted_rpc_turns_terminal_digest_check", ["check-name", "terminal_digest"]],
	[RESTRICTED_TURNS_TABLE, "omp_restricted_rpc_turns_terminal_shape_check", ["check-name", "terminal_shape"]],
];
const constraintDescriptors = constraintDescriptorRecords.map(([object, name, definition]) => ({
	kind: "constraint",
	schema: "public",
	object,
	ordinal: null,
	name,
	type: null,
	nullable: null,
	default: null,
	definition: definitionToken(definition),
	privilege: null,
}));

/** Exact UTF-8 descriptor bytes migration 076 must insert. */
export const RESTRICTED_SCHEMA_DESCRIPTOR_BYTES = canonicalRestrictedJson([
	...columnDescriptors,
	...constraintDescriptors,
]);
export const RESTRICTED_SCHEMA_DESCRIPTOR_DIGEST = restrictedSha256(RESTRICTED_SCHEMA_DESCRIPTOR_BYTES);

export type RestrictedTurnState = "accepted" | "activating" | "active" | "terminal";
export type RestrictedTerminalStatus = "completed" | "failed" | "cancelled";

export interface RestrictedTurnRecord {
	clientTurnId: string;
	sessionId: string;
	acceptedTurnId: string;
	promptDigest: string;
	state: RestrictedTurnState;
	terminalStatus?: RestrictedTerminalStatus;
	terminalEntryEventDigest?: string;
	orderedToolCallDigest?: string;
	highWaterMark?: number;
	acceptedAt: string;
	activationStartedAt?: string;
	activeAt?: string;
	terminalAt?: string;
}

interface TurnRow {
	client_turn_id: string;
	session_id: string;
	accepted_turn_id: string;
	prompt_digest: string;
	state: RestrictedTurnState;
	accepted_at: string;
	activation_started_at: string | null;
	active_at: string | null;
	terminal_status: RestrictedTerminalStatus | null;
	terminal_entry_event_digest: string | null;
	ordered_tool_call_digest: string | null;
	high_water_mark: number | bigint | string | null;
	terminal_at: string | null;
}

interface ContractRow {
	contract_name: string;
	contract_version: number | bigint | string;
	required_pg_min: number | bigint | string;
	required_pg_max: number | bigint | string;
	descriptor_bytes: Uint8Array | string;
	digest: Uint8Array | string;
}

function bytes(value: Uint8Array | string): Uint8Array {
	if (typeof value === "string") {
		if (/^[0-9a-f]{64}$/i.test(value)) return Uint8Array.from(Buffer.from(value, "hex"));
		return new TextEncoder().encode(value);
	}
	return value;
}

function text(value: Uint8Array | string): string {
	return typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function digestText(value: Uint8Array | string): string {
	if (typeof value === "string") return value.toLowerCase();
	return Buffer.from(value).toString("hex");
}

function number(value: number | bigint | string | null): number | undefined {
	if (value === null) return undefined;
	return Number(value);
}

function record(row: TurnRow): RestrictedTurnRecord {
	return {
		clientTurnId: row.client_turn_id,
		sessionId: row.session_id,
		acceptedTurnId: row.accepted_turn_id,
		promptDigest: row.prompt_digest,
		state: row.state,
		acceptedAt: row.accepted_at,
		...(row.activation_started_at ? { activationStartedAt: row.activation_started_at } : {}),
		...(row.active_at ? { activeAt: row.active_at } : {}),
		...(row.terminal_status ? { terminalStatus: row.terminal_status } : {}),
		...(row.terminal_entry_event_digest ? { terminalEntryEventDigest: row.terminal_entry_event_digest } : {}),
		...(row.ordered_tool_call_digest ? { orderedToolCallDigest: row.ordered_tool_call_digest } : {}),
		...(row.high_water_mark !== null ? { highWaterMark: number(row.high_water_mark) } : {}),
		...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
	};
}

const TURN_COLUMNS =
	"client_turn_id, session_id, accepted_turn_id, prompt_digest, state, accepted_at, activation_started_at, active_at, terminal_status, terminal_entry_event_digest, ordered_tool_call_digest, high_water_mark, terminal_at";

const EXPECTED_COLUMNS = descriptorRecords.map(([, schema, object, ordinal, name, type, nullable]) => ({
	schema,
	object,
	ordinal,
	name,
	type,
	nullable,
}));

export interface RestrictedDatabaseDigestMaterial {
	grantBytes: string;
	structuralValidatorBytes: string;
	grantDigest: string;
	structuralValidatorDigest: string;
}

/**
 * Frozen cross-language receipt algorithm for agentdesk_restricted_rpc v1.
 *
 * Both digests cover UTF-8 RFC 8785-style canonical JSON bytes. The grant
 * digest covers the one-row grant query result. The structural digest covers
 * the validated PostgreSQL major, live columns, live constraints, and that
 * same grant row. Field names and array order are part of the wire contract.
 */
export function restrictedDatabaseDigestMaterial(input: {
	serverMajor: number;
	columns: readonly Record<string, unknown>[];
	constraints: readonly Record<string, unknown>[];
	grants: readonly Record<string, unknown>[];
}): RestrictedDatabaseDigestMaterial {
	const grantBytes = canonicalRestrictedJson(input.grants);
	const structuralValidatorBytes = canonicalRestrictedJson({
		serverMajor: input.serverMajor,
		columns: input.columns,
		constraints: input.constraints,
		grants: input.grants,
	});
	return {
		grantBytes,
		structuralValidatorBytes,
		grantDigest: restrictedSha256(grantBytes),
		structuralValidatorDigest: restrictedSha256(structuralValidatorBytes),
	};
}

export function restrictedDatabaseCompiledDigestMaterial(
	serverMajor: number,
	currentUser: string,
): RestrictedDatabaseDigestMaterial {
	const constraints = constraintDescriptors.map(item => ({
		object: item.object,
		name: item.name,
		type: item.name.endsWith("_pkey") ? "p" : item.name.endsWith("_key") ? "u" : "c",
	}));
	const grants = [
		{
			role: currentUser,
			identity_select: true,
			contract_select: true,
			chunks_required: true,
			chunks_forbidden: false,
			turns_required: true,
			turns_forbidden: false,
			turns_update: true,
		},
	];
	return restrictedDatabaseDigestMaterial({
		serverMajor,
		columns: EXPECTED_COLUMNS,
		constraints,
		grants,
	});
}

/** PostgreSQL-only storage for the restricted one-turn protocol. It never runs DDL. */
export class RestrictedTurnStorage {
	readonly #client: SqlSessionStorageClient;

	constructor(client: SqlSessionStorageClient) {
		this.#client = client;
	}

	async validateContract(): Promise<RestrictedEngineeringDatabaseReceipt> {
		const serverRows = (await this.#client.unsafe(
			"SELECT current_setting('server_version_num')::int AS server_version_num, current_database() AS database, current_user AS current_user",
		)) as Array<{ server_version_num: number | string; database: string; current_user: string }>;
		const server = serverRows[0];
		if (!server) throw new Error("Restricted SQL contract validation returned no server identity");
		const major = Math.trunc(Number(server.server_version_num) / 10000);
		if (major < 15 || major > 18) throw new Error(`Restricted SQL contract does not support PostgreSQL ${major}`);
		const identityRows = (await this.#client.unsafe(
			"SELECT database_instance_uuid::text AS database_instance_uuid FROM public.agentdesk_database_identity",
		)) as Array<{ database_instance_uuid: string }>;
		const identity = identityRows[0];
		if (!identity || identityRows.length !== 1) {
			throw new Error("Restricted SQL database identity must contain exactly one row");
		}

		const contractRows = (await this.#client.unsafe(
			"SELECT contract_name, contract_version, required_pg_min, required_pg_max, descriptor_bytes, digest FROM public.omp_schema_contracts WHERE contract_name = $1 AND contract_version = $2",
			[RESTRICTED_SCHEMA_CONTRACT_NAME, RESTRICTED_SCHEMA_CONTRACT_VERSION],
		)) as ContractRow[];
		const contract = contractRows[0];
		if (!contract || contractRows.length !== 1) throw new Error("Restricted SQL schema contract v1 is missing");
		if (Number(contract.required_pg_min) !== 15 || Number(contract.required_pg_max) !== 18) {
			throw new Error("Restricted SQL schema contract PostgreSQL range mismatch");
		}
		const descriptor = text(contract.descriptor_bytes);
		const contractDigest = digestText(contract.digest);
		if (descriptor !== RESTRICTED_SCHEMA_DESCRIPTOR_BYTES || contractDigest !== RESTRICTED_SCHEMA_DESCRIPTOR_DIGEST) {
			throw new Error("Restricted SQL schema contract bytes or digest mismatch");
		}
		if (restrictedSha256(bytes(contract.descriptor_bytes)) !== contractDigest) {
			throw new Error("Restricted SQL schema contract digest is inconsistent with its bytes");
		}

		const objects = [...new Set(EXPECTED_COLUMNS.map(column => column.object))];
		const columnRows = (await this.#client.unsafe(
			"SELECT table_schema AS schema, table_name AS object, ordinal_position AS ordinal, column_name AS name, CASE format_type(a.atttypid,a.atttypmod) WHEN 'integer' THEN 'int4' WHEN 'bigint' THEN 'int8' WHEN 'timestamp with time zone' THEN 'timestamptz' ELSE lower(format_type(a.atttypid,a.atttypmod)) END AS type, NOT a.attnotnull AS nullable FROM information_schema.columns c JOIN pg_catalog.pg_namespace n ON n.nspname=c.table_schema JOIN pg_catalog.pg_class cl ON cl.relnamespace=n.oid AND cl.relname=c.table_name JOIN pg_catalog.pg_attribute a ON a.attrelid=cl.oid AND a.attname=c.column_name AND a.attnum>0 AND NOT a.attisdropped WHERE c.table_schema='public' AND c.table_name = ANY($1::text[]) ORDER BY array_position($1::text[],c.table_name),c.ordinal_position",
			[objects],
		)) as typeof EXPECTED_COLUMNS;
		if (canonicalRestrictedJson(columnRows) !== canonicalRestrictedJson(EXPECTED_COLUMNS)) {
			throw new Error("Restricted SQL live column structure does not match the compiled contract");
		}
		const expectedConstraints = constraintDescriptors.map(item => ({
			object: item.object,
			name: item.name,
			type: item.name.endsWith("_pkey") ? "p" : item.name.endsWith("_key") ? "u" : "c",
		}));
		const constraintRows = (await this.#client.unsafe(
			"SELECT c.relname AS object, con.conname AS name, con.contype::text AS type FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND con.contype <> 'n' AND c.relname = ANY($1::text[]) ORDER BY array_position($1::text[],c.relname),con.conname",
			[objects],
		)) as typeof expectedConstraints;
		if (canonicalRestrictedJson(constraintRows) !== canonicalRestrictedJson(expectedConstraints)) {
			throw new Error("Restricted SQL live constraints do not match the compiled contract");
		}

		const grants = (await this.#client.unsafe(
			"SELECT current_user AS role, has_table_privilege(current_user,'public.agentdesk_database_identity','SELECT') AS identity_select, has_table_privilege(current_user,'public.omp_schema_contracts','SELECT') AS contract_select, has_table_privilege(current_user,'public.omp_session_chunks','SELECT,INSERT') AS chunks_required, has_table_privilege(current_user,'public.omp_session_chunks','UPDATE,DELETE,TRUNCATE') AS chunks_forbidden, has_table_privilege(current_user,'public.omp_restricted_rpc_turns','SELECT,INSERT') AS turns_required, has_table_privilege(current_user,'public.omp_restricted_rpc_turns','DELETE,TRUNCATE') AS turns_forbidden, has_any_column_privilege(current_user,'public.omp_restricted_rpc_turns','UPDATE') AS turns_update",
		)) as Array<Record<string, unknown>>;
		const grant = grants[0];
		if (
			grant?.identity_select !== true ||
			grant.contract_select !== true ||
			grant.chunks_required !== true ||
			grant.chunks_forbidden !== false ||
			grant.turns_required !== true ||
			grant.turns_forbidden !== false ||
			grant.turns_update !== true
		) {
			throw new Error("Restricted SQL role grants do not match the compiled least-authority contract");
		}
		const digestMaterial = restrictedDatabaseDigestMaterial({
			serverMajor: major,
			columns: columnRows,
			constraints: constraintRows,
			grants,
		});
		return {
			databaseInstanceUuid: identity.database_instance_uuid,
			database: server.database,
			currentUser: server.current_user,
			grantDigest: digestMaterial.grantDigest,
			contractName: RESTRICTED_SCHEMA_CONTRACT_NAME,
			contractVersion: RESTRICTED_SCHEMA_CONTRACT_VERSION,
			contractDigest,
			structuralValidatorDigest: digestMaterial.structuralValidatorDigest,
		};
	}

	async acceptTurn(input: {
		clientTurnId: string;
		sessionId: string;
		acceptedTurnId: string;
		prompt: string;
		promptDigest: string;
		sessionPath: string;
		userEntry: SessionMessageEntry;
	}): Promise<{ turn: RestrictedTurnRecord; inserted: boolean }> {
		const entryLine = `${JSON.stringify(input.userEntry)}\n`;
		return this.#client.begin(async transaction => {
			const existingRows = (await transaction.unsafe(
				`SELECT ${TURN_COLUMNS} FROM public.${RESTRICTED_TURNS_TABLE} WHERE client_turn_id = $1 FOR UPDATE`,
				[input.clientTurnId],
			)) as TurnRow[];
			const existing = existingRows[0];
			if (existing) {
				if (existing.session_id !== input.sessionId || existing.prompt_digest !== input.promptDigest) {
					throw new Error("clientTurnId is already bound to a different session or prompt digest");
				}
				return { turn: record(existing), inserted: false };
			}
			await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [input.sessionPath]);
			const seqRows = (await transaction.unsafe(
				"SELECT COALESCE(MAX(seq),-1)+1 AS seq FROM public.omp_session_chunks WHERE path=$1",
				[input.sessionPath],
			)) as Array<{ seq: number | bigint | string }>;
			const seq = Number(seqRows[0]?.seq ?? 0);
			await transaction.unsafe(
				"INSERT INTO public.omp_session_chunks(path,seq,content,mtime_ms) VALUES($1,$2,$3,$4)",
				[input.sessionPath, seq, entryLine, Date.parse(input.userEntry.timestamp)],
			);
			const insertedRows = (await transaction.unsafe(
				`INSERT INTO public.${RESTRICTED_TURNS_TABLE}(client_turn_id,session_id,accepted_turn_id,prompt_bytes,prompt_digest,state,accepted_at) VALUES($1,$2,$3,$4,$5,'accepted',clock_timestamp()) RETURNING ${TURN_COLUMNS}`,
				[input.clientTurnId, input.sessionId, input.acceptedTurnId, input.prompt, input.promptDigest],
			)) as TurnRow[];
			const inserted = insertedRows[0];
			if (!inserted) throw new Error("Restricted turn acceptance insert returned no row");
			return { turn: record(inserted), inserted: true };
		});
	}

	async activateTurn(
		clientTurnId: string,
		acceptedTurnId: string,
	): Promise<{ turn: RestrictedTurnRecord; schedule: boolean }> {
		return this.#client.begin(async transaction => {
			const rows = (await transaction.unsafe(
				`SELECT ${TURN_COLUMNS} FROM public.${RESTRICTED_TURNS_TABLE} WHERE client_turn_id=$1 FOR UPDATE`,
				[clientTurnId],
			)) as TurnRow[];
			const current = rows[0];
			if (!current || current.accepted_turn_id !== acceptedTurnId) {
				throw new Error("Restricted activation does not match a persisted accepted turn");
			}
			if (current.state !== "accepted") return { turn: record(current), schedule: false };
			await transaction.unsafe(
				`UPDATE public.${RESTRICTED_TURNS_TABLE} SET state='activating',activation_started_at=clock_timestamp() WHERE client_turn_id=$1 AND state='accepted'`,
				[clientTurnId],
			);
			const activeRows = (await transaction.unsafe(
				`UPDATE public.${RESTRICTED_TURNS_TABLE} SET state='active',active_at=clock_timestamp() WHERE client_turn_id=$1 AND state='activating' RETURNING ${TURN_COLUMNS}`,
				[clientTurnId],
			)) as TurnRow[];
			const active = activeRows[0];
			if (!active) throw new Error("Restricted activation CAS failed");
			return { turn: record(active), schedule: true };
		});
	}

	async persistTerminal(input: {
		clientTurnId: string;
		acceptedTurnId: string;
		status: RestrictedTerminalStatus;
		terminalEntryEventDigest: string;
		orderedToolCallDigest: string;
		highWaterMark: number;
	}): Promise<RestrictedTurnRecord> {
		const rows = (await this.#client.unsafe(
			`UPDATE public.${RESTRICTED_TURNS_TABLE} SET state='terminal',terminal_status=$3,terminal_entry_event_digest=$4,ordered_tool_call_digest=$5,high_water_mark=$6,terminal_at=clock_timestamp() WHERE client_turn_id=$1 AND accepted_turn_id=$2 AND state='active' RETURNING ${TURN_COLUMNS}`,
			[
				input.clientTurnId,
				input.acceptedTurnId,
				input.status,
				input.terminalEntryEventDigest,
				input.orderedToolCallDigest,
				input.highWaterMark,
			],
		)) as TurnRow[];
		if (rows[0]) return record(rows[0]);
		const current = await this.getTurn(input.clientTurnId);
		if (!current || current.acceptedTurnId !== input.acceptedTurnId)
			throw new Error("Restricted terminal turn mismatch");
		if (
			current.state !== "terminal" ||
			current.terminalStatus !== input.status ||
			current.terminalEntryEventDigest !== input.terminalEntryEventDigest ||
			current.orderedToolCallDigest !== input.orderedToolCallDigest ||
			current.highWaterMark !== input.highWaterMark
		) {
			throw new Error("Restricted terminal receipt conflicts with persisted terminal state");
		}
		return current;
	}

	async getTurn(clientTurnId: string): Promise<RestrictedTurnRecord | undefined> {
		const rows = (await this.#client.unsafe(
			`SELECT ${TURN_COLUMNS} FROM public.${RESTRICTED_TURNS_TABLE} WHERE client_turn_id=$1`,
			[clientTurnId],
		)) as TurnRow[];
		return rows[0] ? record(rows[0]) : undefined;
	}
}
