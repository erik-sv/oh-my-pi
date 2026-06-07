#!/usr/bin/env bun
/**
 * Standalone byte-parity check for the append-only chunk-row SQL session
 * storage. Writes a multi-turn transcript through {@link SqlSessionStorage}
 * into a temp SQLite database, reassembles the body via `readText`, and asserts
 * it equals the concatenation of every line written — covering the
 * trailing-newline, embedded-blank-line, and newline-less-remainder edges that
 * a resume must preserve exactly.
 *
 * Run: `bun packages/coding-agent/scripts/sql-session-parity.ts`
 * Exits non-zero on any mismatch.
 */

import { SQL } from "bun";
import { SqlSessionStorage } from "../src/session/sql-session-storage";

function assert(cond: boolean, msg: string): void {
	if (!cond) {
		console.error(`PARITY FAIL: ${msg}`);
		process.exit(1);
	}
}

async function main(): Promise<void> {
	const client = new SQL("sqlite::memory:");
	const storage = await SqlSessionStorage.create({ client });
	const path = "/sessions/parity/session.jsonl";

	// A realistic multi-turn transcript: header + alternating user/assistant +
	// tool entries, including an embedded blank line and (later) a newline-less
	// final remainder.
	const lines: string[] = [];
	const push = (obj: unknown): string => {
		const line = `${JSON.stringify(obj)}\n`;
		lines.push(line);
		return line;
	};

	const writer = storage.openWriter(path);
	writer.writeLineSync(push({ type: "session", id: "parity-1", version: 3, cwd: "/repo" }));
	for (let turn = 0; turn < 50; turn++) {
		writer.writeLineSync(push({ type: "message", id: `u${turn}`, role: "user", content: `prompt ${turn}` }));
		writer.writeLineSync(
			push({
				type: "message",
				id: `a${turn}`,
				role: "assistant",
				content: [{ type: "text", text: `reply ${turn}` }],
			}),
		);
		if (turn % 7 === 0) {
			// Tool call + result pair; exercise a deeper content shape.
			writer.writeLineSync(
				push({
					type: "message",
					id: `t${turn}`,
					role: "tool",
					content: `result block\nwith internal newline kept verbatim`,
				}),
			);
		}
	}
	await writer.close();
	await storage.drain();

	const expected = lines.join("");
	const got = await storage.readText(path);
	assert(got === expected, `readText body mismatch (expected ${expected.length} chars, got ${got.length})`);

	// refresh() must rebuild the same body from the chunk rows.
	await storage.refresh();
	const afterRefresh = await storage.readText(path);
	assert(afterRefresh === expected, "readText after refresh() mismatch");

	// Continue appending after a refresh: seq watermark must be intact so the
	// new line lands at the end, not clobbering an existing chunk.
	const writer2 = storage.openWriter(path);
	const tail = push({ type: "message", id: "final", role: "assistant", content: "done" });
	writer2.writeLineSync(tail);
	await writer2.close();
	await storage.drain();
	assert((await storage.readText(path)) === lines.join(""), "post-refresh append mismatch");

	// writeText path (atomic rewrite / draft sidecar): a body with a trailing
	// newline-less remainder must round-trip byte-for-byte too.
	const partialPath = "/sessions/parity/partial.jsonl";
	const partial = `${JSON.stringify({ type: "session", id: "p2" })}\n\n${JSON.stringify({ type: "message", id: "x" })}\nno-trailing-newline`;
	await storage.writeText(partialPath, partial);
	assert((await storage.readText(partialPath)) === partial, "writeText round-trip mismatch");
	await storage.refresh();
	assert((await storage.readText(partialPath)) === partial, "writeText round-trip after refresh mismatch");

	const chunkCount = (await client.unsafe("SELECT count(*) AS n FROM omp_session_chunks WHERE path = ?", [
		path,
	])) as Array<{ n: number }>;
	console.log(
		`PARITY OK — ${lines.length} lines (${expected.length} chars) reassembled byte-identically; ` +
			`${Number(chunkCount[0].n)} chunk rows for the main session; writeText remainder verified.`,
	);
	await client.end();
}

main().catch(err => {
	console.error("PARITY ERROR:", err);
	process.exit(1);
});
