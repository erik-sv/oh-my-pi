import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, ptree, readJsonl, removeWithRetries } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";

/**
 * AgentDesk fork: AgentDesk terminalizes a turn and records `last_error` from
 * `prompt_error`; it ignores `prompt_result.error`. A prompt that fails before
 * reaching the agent must therefore announce `prompt_error` ahead of its
 * upstream `prompt_result`, behind the command response for the same id.
 */
describe("RPC prompt_error", () => {
	let proc: ptree.ChildProcess | null = null;
	let directory: string | null = null;

	afterEach(async () => {
		proc?.kill();
		proc = null;
		if (directory) {
			await removeWithRetries(directory).catch(() => {});
			directory = null;
		}
	});

	test("precedes the failed prompt_result of a prompt that never reached the agent", async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-prompt-error-"));
		proc = ptree.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "prompt-error-rpc-agent.ts")], {
			cwd: directory,
			env: { ...Bun.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
			stdin: "pipe",
		});
		const frames: Record<string, unknown>[] = [];
		const done = Promise.withResolvers<void>();
		void (async () => {
			for await (const line of readJsonl(proc!.stdout)) {
				if (!isRecord(line)) continue;
				frames.push(line);
				if (line.type === "ready") {
					const stdin = proc?.stdin as FileSink;
					stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "hello" })}\n`);
					void stdin.flush();
				}
				if (line.type === "prompt_result") done.resolve();
			}
		})();
		await done.promise;

		const correlated = frames.filter(frame => frame.id === "p1");
		expect(correlated.map(frame => [frame.type, frame.success])).toEqual([
			["response", true],
			["response", false],
			["prompt_error", undefined],
			["prompt_result", undefined],
		]);
		const [, lateError, promptError, promptResult] = correlated;
		// No usable model/credentials: AgentSession preflight rejects with a /login hint.
		expect(String(lateError.error)).toContain("Use /login");
		expect(promptError).toEqual({ type: "prompt_error", id: "p1", message: lateError.error });
		expect(promptResult).toMatchObject({
			type: "prompt_result",
			agentInvoked: false,
			status: "error",
			error: { message: lateError.error, retryable: false },
		});
		// Exactly one prompt_error per failed prompt, and none for anything else.
		expect(frames.filter(frame => frame.type === "prompt_error")).toHaveLength(1);
	}, 30_000);
});
