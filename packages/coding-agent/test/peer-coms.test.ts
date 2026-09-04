import { describe, expect, it } from "bun:test";
import {
	assistantTextFromEntries,
	buildPeerInboundContent,
	buildPeerSpawnArgs,
	buildPeerSpawnEnv,
	buildSpawnSystemPrompt,
	createSpawnedPeerIdleShutdown,
	hasActiveInboundPrompt,
	type InboundPrompt,
	isOwnRegistryEntry,
	isParentProcessAlive,
	isSpawnCandidate,
	launchBaseCommand,
	parsePeerAgentDefinition,
	type RegistryEntry,
	schedulePeerProcessShutdown,
} from "../examples/extensions/peer-coms";
import { parseArgs } from "../src/cli/args";

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		session_id: "session-a",
		name: "worker",
		purpose: "testing",
		model: "test-model",
		pid: 100,
		endpoint: "/tmp/worker.sock",
		cwd: "/repo",
		project: "default",
		explicit: false,
		started_at: "2026-05-22T00:00:10.000Z",
		heartbeat_at: "2026-05-22T00:00:11.000Z",
		context_used_pct: 7,
		queue_depth: 0,
		...overrides,
	};
}

describe("peer-coms hardening helpers", () => {
	it("filters every registry entry owned by the current process", () => {
		const identity = entry({ session_id: "self-session", pid: 1234 });

		expect(isOwnRegistryEntry(entry({ session_id: "self-session", pid: 9999 }), identity, 1234)).toBe(true);
		expect(isOwnRegistryEntry(entry({ session_id: "other-session", pid: 1234 }), identity, 1234)).toBe(true);
		expect(isOwnRegistryEntry(entry({ session_id: "other-session", pid: 9999 }), identity, 1234)).toBe(false);
	});

	it("matches spawned peers only after the spawn request and with collision suffixes", () => {
		const startedAfter = Date.parse("2026-05-22T00:00:00.000Z");

		expect(isSpawnCandidate(entry({ name: "reviewer" }), "reviewer", startedAfter)).toBe(true);
		expect(isSpawnCandidate(entry({ name: "reviewer-2" }), "reviewer", startedAfter)).toBe(true);
		expect(isSpawnCandidate(entry({ name: "review" }), "reviewer", startedAfter)).toBe(false);
		expect(
			isSpawnCandidate(
				entry({ name: "reviewer", started_at: "2026-05-21T23:59:59.000Z" }),
				"reviewer",
				startedAfter,
			),
		).toBe(false);
	});
	it("does not match a preexisting peer during spawn readiness", () => {
		const startedAfter = Date.parse("2026-05-22T00:00:00.000Z");
		const existingSessionIds = new Set(["session-a"]);

		expect(isSpawnCandidate(entry({ name: "reviewer" }), "reviewer", startedAfter, existingSessionIds)).toBe(false);
		expect(
			isSpawnCandidate(
				entry({ session_id: "session-b", name: "reviewer-2" }),
				"reviewer",
				startedAfter,
				existingSessionIds,
			),
		).toBe(true);
	});

	it("builds inbound prompts that prevent sender names from becoming tasks", () => {
		const content = buildPeerInboundContent("peer-flow-terminal", "/repo", "Reply exactly: pong");

		expect(content).toContain("Reply to this peer-coms message now");
		expect(content).toContain("Do not treat the sender name as the task");
		expect(content).toContain("Do not explore the repository unless the peer explicitly asks");
		expect(content.endsWith("Reply exactly: pong")).toBe(true);
	});
	it("reports an active inbound prompt until it is fulfilled", () => {
		const prompts: InboundPrompt[] = [
			{
				msg_id: "msg-a",
				sender_endpoint: "/tmp/a.sock",
				fulfilled: true,
				hops: 0,
				startedEntryCount: 0,
			},
			{
				msg_id: "msg-b",
				sender_endpoint: "/tmp/b.sock",
				fulfilled: false,
				hops: 0,
				startedEntryCount: 0,
			},
		];

		expect(hasActiveInboundPrompt(prompts)).toBe(true);
		prompts[1]!.fulfilled = true;
		expect(hasActiveInboundPrompt(prompts)).toBe(false);
	});

	it("extracts assistant response only after the inbound prompt was queued", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", content: "old response" } },
			{ type: "message", message: { role: "user", content: "peer request" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "new response" }] } },
		];

		expect(assistantTextFromEntries(entries, 2)).toEqual({ text: "new response", found: true });
		expect(assistantTextFromEntries(entries, 3)).toEqual({ text: "", found: false });
	});

	it("prefers the installed omp launcher over a source entrypoint", () => {
		const base = launchBaseCommand({
			env: { PATH: "/bin" },
			entrypoint: "/repo/packages/coding-agent/src/cli.ts",
			execPath: "/usr/local/bin/bun",
			resolveExecutable: command => (command === "omp" ? "/usr/local/bin/omp" : undefined),
		});

		expect(base).toEqual({ command: "/usr/local/bin/omp", args: [], source: "installed" });
	});

	it("passes profile and broker auth to spawned peers", () => {
		const env = buildPeerSpawnEnv({
			baseEnv: {
				PATH: "/bin",
				PI_CODING_AGENT_DIR: "/agent/profile",
				OPENAI_API_KEY: "env-openai",
			},
			broker: {
				handle: {
					url: "http://127.0.0.1:4444",
					port: 4444,
					hostname: "127.0.0.1",
					close: async () => {},
				},
				token: "broker-token",
			},
		});

		expect(env.PI_CODING_AGENT_DIR).toBe("/agent/profile");
		expect(env.OPENAI_API_KEY).toBe("env-openai");
		expect(env.OMP_AUTH_BROKER_URL).toBe("http://127.0.0.1:4444");
		expect(env.OMP_AUTH_BROKER_TOKEN).toBe("broker-token");
	});
	it("marks spawned peers with parent lifecycle settings", () => {
		const env = buildPeerSpawnEnv({
			baseEnv: {
				PATH: "/bin",
				OMP_PEER_COMS_SPAWNED_IDLE_TIMEOUT_MS: "120000",
			},
			parentPid: 4242,
		});

		expect(env.OMP_PEER_COMS_PARENT_PID).toBe("4242");
		expect(env.OMP_PEER_COMS_SPAWNED_IDLE_TIMEOUT_MS).toBe("120000");
	});

	it("treats missing parent processes as dead", () => {
		expect(isParentProcessAlive(100, () => undefined)).toBe(true);
		expect(
			isParentProcessAlive(100, () => {
				const err = new Error("not found") as NodeJS.ErrnoException;
				err.code = "ESRCH";
				throw err;
			}),
		).toBe(false);
		expect(
			isParentProcessAlive(100, () => {
				const err = new Error("permission denied") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}),
		).toBe(true);
	});

	it("turns initial_prompt into startup instructions instead of a positional task", () => {
		const args = buildPeerSpawnArgs({
			baseArgs: ["src/cli.ts"],
			extensionPath: "/repo/examples/extensions/peer-coms.ts",
			name: "responder",
			project: "default",
			purpose: "answer peer checks",
			model: "test/model",
			systemPromptPath: "/tmp/peer-system.md",
			sessionDir: "/tmp/peer-sessions/responder",
		});

		expect(args).toEqual([
			"src/cli.ts",
			"-e",
			"/repo/examples/extensions/peer-coms.ts",
			"--append-system-prompt",
			"/tmp/peer-system.md",
			"--peer-name",
			"responder",
			"--peer-project",
			"default",
			"--peer-purpose",
			"answer peer checks",
			"--model",
			"test/model",
			"--session-dir",
			"/tmp/peer-sessions/responder",
		]);

		const prompt = buildSpawnSystemPrompt("responder", "answer peer checks", "Stay brief.");
		expect(prompt).toContain("Do not treat your peer name, terminal title, or startup context as the user's task.");
		expect(prompt).toContain("fully featured peer work agent");
		expect(prompt).toContain("Caller startup instructions:\nStay brief.");
	});

	it("can add a local agent definition to a spawned work peer prompt", () => {
		const agent = parsePeerAgentDefinition(
			"/repo/.omp/agents/work-peer.md",
			[
				"---",
				"name: work-peer",
				"description: Fully featured work peer",
				"---",
				"Use tools and complete delegated work.",
			].join("\n"),
		);

		expect(agent).toEqual({
			name: "work-peer",
			description: "Fully featured work peer",
			body: "Use tools and complete delegated work.",
			file: "/repo/.omp/agents/work-peer.md",
		});

		const prompt = buildSpawnSystemPrompt("worker", "work on delegated tasks", undefined, agent?.body);
		expect(prompt).toContain("Peer agent definition:");
		expect(prompt).toContain("Use tools and complete delegated work.");
	});

	it("keeps peer CLI flag values out of the initial user message", () => {
		const flags = new Map<string, { type: "boolean" | "string" }>([
			["peer-name", { type: "string" }],
			["peer-project", { type: "string" }],
			["peer-purpose", { type: "string" }],
			["peer-explicit", { type: "boolean" }],
		]);

		const parsed = parseArgs(
			[
				"-e",
				"/repo/examples/extensions/peer-coms.ts",
				"--peer-name",
				"harden-terminal",
				"--peer-project",
				"default",
				"--peer-purpose",
				"answer checks",
				"--peer-explicit",
			],
			flags,
		);

		expect(parsed.messages).toEqual([]);
		expect(parsed.unknownFlags).toEqual(
			new Map<string, boolean | string>([
				["peer-name", "harden-terminal"],
				["peer-project", "default"],
				["peer-purpose", "answer checks"],
				["peer-explicit", true],
			]),
		);
	});

	it("exits the peer process after accepting a shutdown request", async () => {
		const timers: Array<{ callback: () => void; ms: number; unrefCalled: boolean }> = [];
		const events: string[] = [];

		schedulePeerProcessShutdown({
			shutdown: () => {
				events.push("shutdown");
			},
			shutdownContext: () => {
				events.push("context-shutdown");
			},
			exit: code => {
				events.push(`exit:${code}`);
			},
			setTimer: (callback, ms) => {
				const timer = {
					callback,
					ms,
					unrefCalled: false,
					unref() {
						timer.unrefCalled = true;
					},
				};
				timers.push(timer);
				return timer;
			},
			initialDelayMs: 7,
			exitGraceMs: 11,
		});

		expect(timers).toHaveLength(1);
		expect(timers[0]!.ms).toBe(7);
		expect(timers[0]!.unrefCalled).toBe(true);

		timers[0]!.callback();
		await Bun.sleep(0);

		expect(events).toEqual(["shutdown", "context-shutdown"]);
		expect(timers).toHaveLength(2);
		expect(timers[1]!.ms).toBe(11);
		expect(timers[1]!.unrefCalled).toBe(true);

		timers[1]!.callback();
		expect(events).toEqual(["shutdown", "context-shutdown", "exit:0"]);
	});

	it("shuts down spawned peers after an idle timeout", async () => {
		const timers: Array<{ callback: () => void; ms: number; unrefCalled: boolean }> = [];
		const events: string[] = [];
		const handle = createSpawnedPeerIdleShutdown({
			idleTimeoutMs: 50,
			isIdle: () => true,
			shutdown: () => {
				events.push("shutdown");
			},
			shutdownContext: () => {
				events.push("context-shutdown");
			},
			exit: code => {
				events.push(`exit:${code}`);
			},
			setTimer: (callback, ms) => {
				const timer = {
					callback,
					ms,
					unrefCalled: false,
					unref() {
						timer.unrefCalled = true;
					},
				};
				timers.push(timer);
				return timer;
			},
		});

		expect(handle).toBeDefined();
		expect(timers).toHaveLength(1);
		expect(timers[0]!.ms).toBe(50);
		expect(timers[0]!.unrefCalled).toBe(true);

		timers[0]!.callback();
		expect(events).toEqual([]);
		expect(timers).toHaveLength(2);
		expect(timers[1]!.ms).toBe(0);

		timers[1]!.callback();
		await Bun.sleep(0);
		expect(events).toEqual(["shutdown", "context-shutdown"]);

		timers[2]!.callback();
		expect(events).toEqual(["shutdown", "context-shutdown", "exit:0"]);
	});

	it("does not shut down a spawned peer while it is busy", () => {
		const timers: Array<{ callback: () => void; ms: number; unrefCalled: boolean }> = [];
		const events: string[] = [];
		const handle = createSpawnedPeerIdleShutdown({
			idleTimeoutMs: 50,
			isIdle: () => false,
			shutdown: () => {
				events.push("shutdown");
			},
			exit: code => {
				events.push(`exit:${code}`);
			},
			setTimer: (callback, ms) => {
				const timer = {
					callback,
					ms,
					unrefCalled: false,
					unref() {
						timer.unrefCalled = true;
					},
				};
				timers.push(timer);
				return timer;
			},
		});

		expect(handle).toBeDefined();
		timers[0]!.callback();
		expect(events).toEqual([]);
		expect(timers).toHaveLength(1);
	});

	it("still exits the peer process when graceful shutdown fails", async () => {
		const timers: Array<{ callback: () => void; ms: number; unrefCalled: boolean }> = [];
		const errors: unknown[] = [];
		const events: string[] = [];

		schedulePeerProcessShutdown({
			shutdown: () => {
				throw new Error("cleanup failed");
			},
			shutdownContext: () => {
				events.push("context-shutdown");
			},
			exit: code => {
				events.push(`exit:${code}`);
			},
			setTimer: (callback, ms) => {
				const timer = {
					callback,
					ms,
					unrefCalled: false,
					unref() {
						timer.unrefCalled = true;
					},
				};
				timers.push(timer);
				return timer;
			},
			initialDelayMs: 1,
			exitGraceMs: 2,
			onError: err => errors.push(err),
		});

		timers[0]!.callback();
		await Bun.sleep(0);

		expect(errors).toHaveLength(1);
		expect(events).toEqual(["context-shutdown"]);

		timers[1]!.callback();
		expect(events).toEqual(["context-shutdown", "exit:0"]);
	});
});
