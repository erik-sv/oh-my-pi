import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { handleRpcEphemeralTurn, type RpcEphemeralTurnSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { isRecord, ptree, readJsonl, removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function makeSession(overrides: {
	isStreaming?: boolean;
	isCompacting?: boolean;
	replyText?: string;
	onRun?: (args: { promptText: string }) => void;
	fail?: Error;
}): RpcEphemeralTurnSession & { runCalls: number } {
	const session = {
		isStreaming: overrides.isStreaming ?? false,
		isCompacting: overrides.isCompacting ?? false,
		runCalls: 0,
		async runEphemeralTurn(args: {
			promptText: string;
			onTextDelta?: (delta: string) => void;
			signal?: AbortSignal;
			dedupeReply?: boolean;
		}) {
			session.runCalls++;
			overrides.onRun?.(args);
			if (overrides.fail) throw overrides.fail;
			const replyText = overrides.replyText ?? "";
			return { replyText, assistantMessage: makeAssistantMessage(replyText) };
		},
	};
	return session;
}

describe("handleRpcEphemeralTurn", () => {
	test("returns replyText from the ephemeral turn primitive", async () => {
		let promptText: string | undefined;
		const session = makeSession({
			replyText: "Working on the parser; next step is fixing the lexer tests.",
			onRun: args => {
				promptText = args.promptText;
			},
		});

		const result = await handleRpcEphemeralTurn(session, {
			type: "ephemeral_turn",
			prompt: "Summarize your current state in one line.",
		});

		expect(result).toEqual({ replyText: "Working on the parser; next step is fixing the lexer tests." });
		// Only replyText crosses the RPC boundary — the assistant message (and any
		// tool-call content the primitive already discarded) never leaks to the host.
		expect(Object.keys(result)).toEqual(["replyText"]);
		expect(promptText).toBe("Summarize your current state in one line.");
		expect(session.runCalls).toBe(1);
	});

	test("rejects while a response is streaming without invoking the primitive", async () => {
		const session = makeSession({ isStreaming: true });

		await expect(handleRpcEphemeralTurn(session, { type: "ephemeral_turn", prompt: "recap please" })).rejects.toThrow(
			"Cannot run ephemeral turn while a response is in progress",
		);
		expect(session.runCalls).toBe(0);
	});

	test("rejects while compaction is in progress without invoking the primitive", async () => {
		const session = makeSession({ isCompacting: true });

		await expect(handleRpcEphemeralTurn(session, { type: "ephemeral_turn", prompt: "recap please" })).rejects.toThrow(
			"Cannot run ephemeral turn while compaction is in progress",
		);
		expect(session.runCalls).toBe(0);
	});

	test("rejects blank prompts without invoking the primitive", async () => {
		const session = makeSession({});

		await expect(handleRpcEphemeralTurn(session, { type: "ephemeral_turn", prompt: "   " })).rejects.toThrow(
			"Prompt cannot be empty",
		);
		expect(session.runCalls).toBe(0);
	});

	test("rejects non-string prompts without invoking the primitive", async () => {
		const session = makeSession({});
		const command = { type: "ephemeral_turn", prompt: 42 } as unknown as Parameters<typeof handleRpcEphemeralTurn>[1];

		await expect(handleRpcEphemeralTurn(session, command)).rejects.toThrow("Prompt cannot be empty");
		expect(session.runCalls).toBe(0);
	});

	test("propagates primitive failures so the dispatch can emit an error response", async () => {
		const session = makeSession({ fail: new Error("Ephemeral turn ended without a final message") });

		await expect(handleRpcEphemeralTurn(session, { type: "ephemeral_turn", prompt: "recap please" })).rejects.toThrow(
			"Ephemeral turn ended without a final message",
		);
	});
});

/**
 * Protocol-level tests against a real `--mode rpc` process. No model call is
 * ever made: the blank-prompt rejection fires before the primitive, and the
 * unknown command never reaches a model. A dummy API key guarantees no real
 * network auth is possible even by accident.
 */
describe("RPC dispatch: ephemeral_turn wire behavior", () => {
	let proc: ptree.ChildProcess | null = null;
	let sessionDir: string | null = null;

	afterEach(async () => {
		proc?.kill();
		proc = null;
		if (sessionDir) {
			await removeWithRetries(sessionDir).catch(() => {});
			sessionDir = null;
		}
	});

	test("recognizes ephemeral_turn and keeps unknown-command behavior for older clients", async () => {
		sessionDir = path.join(os.tmpdir(), `omp-rpc-ephemeral-${Snowflake.next()}`);
		const packageDir = path.join(import.meta.dir, "..");
		proc = ptree.spawn(["bun", path.join(packageDir, "src", "cli.ts"), "--mode", "rpc"], {
			cwd: packageDir,
			env: {
				...Bun.env,
				ANTHROPIC_API_KEY: "test-dummy-key",
				PI_CODING_AGENT_DIR: sessionDir,
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
		});

		const frames: Record<string, unknown>[] = [];
		const waiters: Array<{
			predicate: (frame: Record<string, unknown>) => boolean;
			resolve: (frame: Record<string, unknown>) => void;
		}> = [];
		const nextFrame = (predicate: (frame: Record<string, unknown>) => boolean) => {
			const existing = frames.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise<Record<string, unknown>>(resolve => {
				waiters.push({ predicate, resolve });
			});
		};
		void (async () => {
			for await (const line of readJsonl(proc!.stdout)) {
				if (!isRecord(line)) continue;
				frames.push(line);
				const index = waiters.findIndex(waiter => waiter.predicate(line));
				if (index !== -1) {
					const [waiter] = waiters.splice(index, 1);
					waiter?.resolve(line);
				}
			}
		})();
		const send = (frame: object) => {
			const stdin = proc?.stdin as FileSink;
			stdin.write(`${JSON.stringify(frame)}\n`);
			void stdin.flush();
		};

		await nextFrame(frame => frame.type === "ready");

		// Older clients probing a command this server does not know still get
		// the unchanged unknown-command error frame (id intentionally absent).
		send({ id: "u1", type: "bogus_command" });
		const unknownResponse = await nextFrame(frame => frame.type === "response" && frame.command === "bogus_command");
		expect(unknownResponse.success).toBe(false);
		expect(unknownResponse.error).toBe("Unknown command: bogus_command");
		expect(unknownResponse.id).toBeUndefined();

		// ephemeral_turn is dispatched (not unknown): the blank-prompt guard
		// answers with a command-scoped error response before any model call.
		send({ id: "e1", type: "ephemeral_turn", prompt: "   " });
		const ephemeralResponse = await nextFrame(
			frame => frame.type === "response" && frame.command === "ephemeral_turn",
		);
		expect(ephemeralResponse.id).toBe("e1");
		expect(ephemeralResponse.success).toBe(false);
		expect(ephemeralResponse.error).toBe("Prompt cannot be empty");
	}, 60_000);
});
