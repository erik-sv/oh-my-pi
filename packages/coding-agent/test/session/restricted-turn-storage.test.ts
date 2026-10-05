import { describe, expect, it } from "bun:test";
import {
	RESTRICTED_SCHEMA_DESCRIPTOR_BYTES,
	RESTRICTED_SCHEMA_DESCRIPTOR_DIGEST,
	RestrictedTurnStorage,
} from "@oh-my-pi/pi-coding-agent/session/restricted-turn-storage";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type {
	SqlSessionStorageClient,
	SqlSessionStorageTransactionClient,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

interface StoredRow {
	client_turn_id: string;
	session_id: string;
	accepted_turn_id: string;
	prompt_digest: string;
	state: "accepted" | "activating" | "active" | "terminal";
	accepted_at: string;
	activation_started_at: string | null;
	active_at: string | null;
	terminal_status: "completed" | "failed" | "cancelled" | null;
	terminal_entry_event_digest: string | null;
	ordered_tool_call_digest: string | null;
	high_water_mark: number | null;
	terminal_at: string | null;
}

class TurnClient implements SqlSessionStorageClient {
	options = { adapter: "postgres" };
	rows = new Map<string, StoredRow>();
	chunks: Array<{ path: string; seq: number; content: string }> = [];
	failAfterChunk = false;

	async begin<T>(callback: (transaction: SqlSessionStorageTransactionClient) => Promise<T>): Promise<T> {
		const rows = structuredClone(this.rows);
		const chunks = structuredClone(this.chunks);
		try {
			return await callback(this);
		} catch (error) {
			this.rows = rows;
			this.chunks = chunks;
			throw error;
		}
	}

	async unsafe(query: string, values: unknown[] = []): Promise<unknown[]> {
		if (query.includes("pg_advisory_xact_lock")) return [];
		if (query.startsWith("SELECT COALESCE(MAX(seq)")) {
			const path = String(values[0]);
			const max = this.chunks
				.filter(chunk => chunk.path === path)
				.reduce((value, chunk) => Math.max(value, chunk.seq), -1);
			return [{ seq: max + 1 }];
		}
		if (query.startsWith("INSERT INTO public.omp_session_chunks")) {
			this.chunks.push({ path: String(values[0]), seq: Number(values[1]), content: String(values[2]) });
			if (this.failAfterChunk) throw new Error("acceptance failpoint");
			return [];
		}
		if (query.startsWith("INSERT INTO public.omp_restricted_rpc_turns")) {
			const id = String(values[0]);
			if (this.rows.has(id)) throw new Error("duplicate client turn");
			const row: StoredRow = {
				client_turn_id: id,
				session_id: String(values[1]),
				accepted_turn_id: String(values[2]),
				prompt_digest: String(values[4]),
				state: "accepted",
				accepted_at: "2026-08-25T00:00:00.000Z",
				activation_started_at: null,
				active_at: null,
				terminal_status: null,
				terminal_entry_event_digest: null,
				ordered_tool_call_digest: null,
				high_water_mark: null,
				terminal_at: null,
			};
			this.rows.set(id, row);
			return [structuredClone(row)];
		}
		if (query.includes("SET state='activating'")) {
			const row = this.rows.get(String(values[0]));
			if (row?.state === "accepted") {
				row.state = "activating";
				row.activation_started_at = "2026-08-25T00:00:01.000Z";
			}
			return [];
		}
		if (query.includes("SET state='active'")) {
			const row = this.rows.get(String(values[0]));
			if (row?.state !== "activating") return [];
			row.state = "active";
			row.active_at = "2026-08-25T00:00:02.000Z";
			return [structuredClone(row)];
		}
		if (query.includes("SET state='terminal'")) {
			const row = this.rows.get(String(values[0]));
			if (!row || row.accepted_turn_id !== values[1] || row.state !== "active") return [];
			row.state = "terminal";
			row.terminal_status = values[2] as StoredRow["terminal_status"];
			row.terminal_entry_event_digest = String(values[3]);
			row.ordered_tool_call_digest = String(values[4]);
			row.high_water_mark = Number(values[5]);
			row.terminal_at = "2026-08-25T00:00:03.000Z";
			return [structuredClone(row)];
		}
		if (query.startsWith("SELECT client_turn_id")) {
			const row = this.rows.get(String(values[0]));
			return row ? [structuredClone(row)] : [];
		}
		throw new Error(`Unexpected SQL in test: ${query}`);
	}
}

class WrongContractClient implements SqlSessionStorageClient {
	options = { adapter: "postgres" };
	queries: string[] = [];

	async begin<T>(callback: (transaction: SqlSessionStorageTransactionClient) => Promise<T>): Promise<T> {
		return callback(this);
	}

	async unsafe(query: string): Promise<unknown[]> {
		this.queries.push(query);
		if (query.includes("server_version_num")) {
			return [{ server_version_num: 180000, database: "agentdesk", current_user: "agentdesk_engineering_omp" }];
		}
		if (query.includes("agentdesk_database_identity")) {
			return [{ database_instance_uuid: "018f47f2-a397-7000-8000-000000000000" }];
		}
		if (query.includes("omp_schema_contracts")) {
			return [
				{
					contract_name: "agentdesk_restricted_rpc",
					contract_version: 1,
					required_pg_min: 15,
					required_pg_max: 18,
					descriptor_bytes: new TextEncoder().encode("[]"),
					digest: Bun.SHA256.hash("[]"),
				},
			];
		}
		throw new Error(`Unexpected validator query: ${query}`);
	}
}

const entry: SessionMessageEntry = {
	type: "message",
	id: "entry-1",
	parentId: null,
	timestamp: "2026-08-25T00:00:00.000Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "build it" }],
		attribution: "user",
		timestamp: Date.parse("2026-08-25T00:00:00.000Z"),
	},
};

const request = {
	clientTurnId: "018f47f2-a397-7000-8000-000000000001",
	sessionId: "session-1",
	acceptedTurnId: "018f47f2-a397-7000-8000-000000000002",
	prompt: "build it",
	promptDigest: "a".repeat(64),
	sessionPath: "/sessions/one.jsonl",
	userEntry: entry,
};

describe("RestrictedTurnStorage", () => {
	it("atomically dedupes acceptance and rolls the user chunk back at a failpoint", async () => {
		const client = new TurnClient();
		const storage = new RestrictedTurnStorage(client);
		const first = await storage.acceptTurn(request);
		expect(first.inserted).toBe(true);
		expect(client.chunks).toHaveLength(1);
		const duplicate = await storage.acceptTurn({ ...request, acceptedTurnId: crypto.randomUUID() });
		expect(duplicate.inserted).toBe(false);
		expect(duplicate.turn.acceptedTurnId).toBe(request.acceptedTurnId);
		expect(client.chunks).toHaveLength(1);
		await expect(storage.acceptTurn({ ...request, sessionId: "changed" })).rejects.toThrow("different session");

		const failedClient = new TurnClient();
		failedClient.failAfterChunk = true;
		await expect(new RestrictedTurnStorage(failedClient).acceptTurn(request)).rejects.toThrow("failpoint");
		expect(failedClient.chunks).toEqual([]);
		expect(failedClient.rows.size).toBe(0);
	});

	it("schedules activation once and persists an idempotent terminal receipt", async () => {
		const client = new TurnClient();
		const storage = new RestrictedTurnStorage(client);
		await storage.acceptTurn(request);
		const first = await storage.activateTurn(request.clientTurnId, request.acceptedTurnId);
		expect(first.schedule).toBe(true);
		expect(first.turn.state).toBe("active");
		const duplicate = await storage.activateTurn(request.clientTurnId, request.acceptedTurnId);
		expect(duplicate.schedule).toBe(false);
		const terminal = await storage.persistTerminal({
			clientTurnId: request.clientTurnId,
			acceptedTurnId: request.acceptedTurnId,
			status: "completed",
			terminalEntryEventDigest: "b".repeat(64),
			orderedToolCallDigest: "c".repeat(64),
			highWaterMark: 19,
		});
		expect(terminal).toMatchObject({ state: "terminal", terminalStatus: "completed", highWaterMark: 19 });
		await expect(
			storage.persistTerminal({
				clientTurnId: request.clientTurnId,
				acceptedTurnId: request.acceptedTurnId,
				status: "completed",
				terminalEntryEventDigest: "b".repeat(64),
				orderedToolCallDigest: "c".repeat(64),
				highWaterMark: 19,
			}),
		).resolves.toEqual(terminal);
	});

	it("rejects wrong contract bytes using read-only SQL only", async () => {
		const client = new WrongContractClient();
		await expect(new RestrictedTurnStorage(client).validateContract()).rejects.toThrow(
			"contract bytes or digest mismatch",
		);
		expect(client.queries.length).toBeGreaterThan(0);
		for (const query of client.queries) {
			expect(query).not.toMatch(/\b(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i);
		}
	});

	it("binds descriptor bytes to their compiled digest", () => {
		expect(Bun.SHA256.hash(RESTRICTED_SCHEMA_DESCRIPTOR_BYTES, "hex")).toBe(RESTRICTED_SCHEMA_DESCRIPTOR_DIGEST);
	});
});
