import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { z } from "zod/v4";
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

const peerExtensionPath = path.resolve(import.meta.dir, "../examples/extensions/peer-coms.ts");
const registryIdentitySchema = z
	.object({
		session_id: z.string(),
		name: z.string(),
		pid: z.number().int().positive(),
		endpoint: z.string(),
		kind: z.enum(["process", "session"]).optional(),
		proc_start_ticks: z.number().int().positive().optional(),
	})
	.passthrough();

let peerAuthDir: TempDir;
let peerAuthStorage: AuthStorage;
let peerModelRegistry: ModelRegistry;

interface PeerRegistrationHarness {
	root: TempDir;
	runner: ExtensionRunner;
	project: string;
}

function initializePeerRunner(runner: ExtensionRunner): void {
	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		},
		{
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		},
	);
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function startPeerRegistration(taskDepth: number, registerSubagents: boolean): Promise<PeerRegistrationHarness> {
	const root = TempDir.createSync("@omp-peer-identity-");
	const project = "identity";
	const previousDir = process.env.OMP_PEER_COMS_DIR;
	const previousBrokerUrl = process.env.OMP_AUTH_BROKER_URL;
	process.env.OMP_PEER_COMS_DIR = root.path();
	process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:1";

	try {
		const loaded = await loadExtensions([peerExtensionPath], root.path());
		if (loaded.errors.length > 0 || loaded.extensions.length !== 1) {
			throw new Error(`peer-coms fixture failed to load: ${JSON.stringify(loaded.errors)}`);
		}
		loaded.runtime.flagValues.set("peer-name", `peer-${taskDepth}`);
		loaded.runtime.flagValues.set("peer-project", project);
		loaded.runtime.flagValues.set("peer-purpose", "identity test");
		loaded.runtime.flagValues.set("peer-register-subagents", registerSubagents);

		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			root.path(),
			SessionManager.inMemory(),
			peerModelRegistry,
			undefined,
			undefined,
			taskDepth,
		);
		initializePeerRunner(runner);
		const handlerErrors: string[] = [];
		runner.onError(error => handlerErrors.push(`${error.event}: ${error.error}`));
		await runner.emit({ type: "session_start" });
		if (handlerErrors.length > 0) {
			await runner.emit({ type: "session_shutdown" });
			throw new Error(`peer-coms fixture failed to start: ${handlerErrors.join("; ")}`);
		}
		return { root, runner, project };
	} catch (error) {
		root.removeSync();
		throw error;
	} finally {
		restoreEnv("OMP_PEER_COMS_DIR", previousDir);
		restoreEnv("OMP_AUTH_BROKER_URL", previousBrokerUrl);
	}
}

function peerFiles(harness: PeerRegistrationHarness, ...segments: string[]): string[] {
	const dir = path.join(harness.root.path(), ...segments);
	return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function peerRegistryRows(harness: PeerRegistrationHarness) {
	return peerFiles(harness, "projects", harness.project, "agents").map(file => {
		const raw = JSON.parse(
			fs.readFileSync(path.join(harness.root.path(), "projects", harness.project, "agents", file), "utf8"),
		);
		return registryIdentitySchema.parse(raw);
	});
}

function currentProcessStartTicks(): number {
	const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd < 0) throw new Error("current process stat has no command terminator");
	const fieldsAfterCommand = stat
		.slice(commandEnd + 1)
		.trim()
		.split(/\s+/);
	const ticks = Number(fieldsAfterCommand[19]);
	if (!Number.isSafeInteger(ticks) || ticks <= 0) throw new Error("current process stat has invalid start ticks");
	return ticks;
}

async function stopPeerRegistration(harness: PeerRegistrationHarness): Promise<void> {
	await harness.runner.emit({ type: "session_shutdown" });
	harness.root.removeSync();
}

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
	const base = {
		session_id: "session-a",
		name: "worker",
		purpose: "testing",
		model: "test-model",
		pid: 100,
		kind: "process" as const,
		proc_start_ticks: 1,
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
	return base;
}

beforeAll(async () => {
	peerAuthDir = TempDir.createSync("@omp-peer-auth-");
	peerAuthStorage = await AuthStorage.create(path.join(peerAuthDir.path(), "auth.db"));
	peerModelRegistry = new ModelRegistry(peerAuthStorage);
});

afterAll(() => {
	peerAuthStorage.close();
	peerAuthDir.removeSync();
});

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

	it("does not create a peer endpoint or registry row for an in-process task without the opt-in", async () => {
		const harness = await startPeerRegistration(1, false);
		try {
			expect(peerFiles(harness, "sockets")).toEqual([]);
			expect(peerRegistryRows(harness)).toEqual([]);
		} finally {
			await stopPeerRegistration(harness);
		}
	});

	it("registers a top-level peer as the current OS process identity", async () => {
		const harness = await startPeerRegistration(0, false);
		try {
			const rows = peerRegistryRows(harness);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (!row) throw new Error("top-level peer registry row was not written");
			expect(row.kind).toBe("process");
			expect(row.proc_start_ticks).toBe(currentProcessStartTicks());
		} finally {
			await stopPeerRegistration(harness);
		}
	});

	it("registers an opted-in task peer as a logical session rather than another OS process", async () => {
		const harness = await startPeerRegistration(1, true);
		try {
			const rows = peerRegistryRows(harness);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (!row) throw new Error("opted-in task peer registry row was not written");
			expect(row.kind).toBe("session");
		} finally {
			await stopPeerRegistration(harness);
		}
	});
});
