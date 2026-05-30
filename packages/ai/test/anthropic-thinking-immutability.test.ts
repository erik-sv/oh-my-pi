import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai/types";

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

describe("Anthropic thinking replay immutability", () => {
	it("preserves signed-thinking blocks while normalizing non-thinking content", () => {
		const malformed = String.fromCharCode(0xd800);
		const user: UserMessage = {
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `analysis ${malformed}`, thinkingSignature: "sig_thinking" },
				{ type: "redactedThinking", data: "" },
				{ type: "text", text: `text ${malformed}` },
				{
					type: "toolCall",
					id: "toolu_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const params = convertAnthropicMessages([user, assistant], model, false);
		const assistantParam = params.find(message => message.role === "assistant");
		expect(assistantParam).toBeDefined();
		expect(assistantParam?.content).toEqual([
			{ type: "thinking", thinking: `analysis ${malformed}`, signature: "sig_thinking" },
			{ type: "text", text: `text ${malformed.toWellFormed()}` },
			{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
		]);
	});
});

describe("Anthropic historical thinking is dropped (only latest assistant keeps it)", () => {
	const mkAssistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	});

	it("drops thinking/redacted_thinking from earlier assistant turns but keeps the latest verbatim", () => {
		const user1: UserMessage = { role: "user", content: "do a thing", timestamp: 1 };
		const historical = mkAssistant(
			[
				{ type: "thinking", thinking: "old reasoning", thinkingSignature: "sig_old" },
				{ type: "redactedThinking", data: "enc_old" },
				{ type: "text", text: "calling read" },
				{ type: "toolCall", id: "toolu_old", name: "read", arguments: { path: "a" } },
			],
			"toolUse",
		);
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "toolu_old",
			toolName: "read",
			content: [{ type: "text" as const, text: "file body" }],
			timestamp: 3,
		};
		const latest = mkAssistant(
			[
				{ type: "thinking", thinking: "fresh reasoning", thinkingSignature: "sig_fresh" },
				{ type: "text", text: "the answer" },
			],
			"stop",
		);

		const params = convertAnthropicMessages([user1, historical, toolResult, latest], model, false);
		const assistants = params.filter(p => p.role === "assistant");
		expect(assistants).toHaveLength(2);

		// Historical assistant: thinking + redacted dropped, text + tool_use preserved.
		expect(assistants[0].content).toEqual([
			{ type: "text", text: "calling read" },
			{ type: "tool_use", id: "toolu_old", name: "read", input: { path: "a" } },
		]);

		// Latest assistant: thinking preserved byte-for-byte (signature intact).
		expect(assistants[1].content).toEqual([
			{ type: "thinking", thinking: "fresh reasoning", signature: "sig_fresh" },
			{ type: "text", text: "the answer" },
		]);
	});

	it("does not re-serialize an unsigned 'Thinking…' placeholder in a historical turn (it is dropped, not turned into text)", () => {
		// Reproduces the poisoned-resume shape: a historical turn carries an unsigned
		// placeholder thinking block alongside a signed one. The old code converted the
		// unsigned block to text (modifying the turn → Anthropic 400). It must be dropped.
		const user1: UserMessage = { role: "user", content: "go", timestamp: 1 };
		const historical = mkAssistant(
			[
				{ type: "thinking", thinking: "Thinking...", thinkingSignature: "" },
				{ type: "thinking", thinking: "real", thinkingSignature: "sig_real" },
				{ type: "text", text: "doing it" },
				{ type: "toolCall", id: "toolu_x", name: "bash", arguments: { command: "ls" } },
			],
			"toolUse",
		);
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "toolu_x",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			timestamp: 3,
		};
		const latest = mkAssistant([{ type: "text", text: "done" }], "stop");

		const params = convertAnthropicMessages([user1, historical, toolResult, latest], model, false);
		const historicalParam = params.find(p => p.role === "assistant");
		// No thinking blocks AND no stray text derived from the placeholder.
		expect(historicalParam?.content).toEqual([
			{ type: "text", text: "doing it" },
			{ type: "tool_use", id: "toolu_x", name: "bash", input: { command: "ls" } },
		]);
	});
});