/**
 * Peer Coms
 *
 * Flat peer-to-peer collaboration between running OMP agents on the same
 * machine. Each agent registers itself in ~/.omp/agent/peer-coms and listens
 * on a local socket. Any peer can send a prompt to any other peer; replies are
 * captured from the receiving agent's normal assistant response.
 *
 * Inspired by disler/pi-vs-claude-code's coms extension, updated for the
 * current @oh-my-pi extension runtime.
 *
 * Usage:
 *   omp -e examples/extensions/peer-coms.ts --peer-name planner --model gpt-5
 *   omp -e examples/extensions/peer-coms.ts --peer-name reviewer --model claude-sonnet-4-5
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, prompt } from "@oh-my-pi/pi-utils";
import peerComsSpawnPrompt from "./peer-coms-spawn.md" with { type: "text" };

const PEER_COMS_DIR = process.env.OMP_PEER_COMS_DIR ?? path.join(os.homedir(), ".omp", "agent", "peer-coms");
const MAX_HOPS = Number(process.env.OMP_PEER_COMS_MAX_HOPS ?? 5);
const REPLY_TIMEOUT_MS = Number(process.env.OMP_PEER_COMS_REPLY_TIMEOUT_MS ?? 30 * 60 * 1000);
const REPLY_RESULT_TTL_MS = Number(process.env.OMP_PEER_COMS_REPLY_RESULT_TTL_MS ?? 60_000);
const HEARTBEAT_MS = Number(process.env.OMP_PEER_COMS_HEARTBEAT_MS ?? 10_000);
const PEER_STALE_MS = Number(process.env.OMP_PEER_COMS_STALE_MS ?? 45_000);
const FRAME_TIMEOUT_MS = Number(process.env.OMP_PEER_COMS_FRAME_TIMEOUT_MS ?? 15_000);
const LINE_CAP_BYTES = 128 * 1024;
const DEFAULT_SPAWNED_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SPAWNED_IDLE_TIMEOUT_MS = Number(
	process.env.OMP_PEER_COMS_SPAWNED_IDLE_TIMEOUT_MS ?? DEFAULT_SPAWNED_IDLE_TIMEOUT_MS,
);
const PARENT_CHECK_MS = Number(process.env.OMP_PEER_COMS_PARENT_CHECK_MS ?? HEARTBEAT_MS);
const PEER_SHUTDOWN_ACK_DELAY_MS = 50;
const PEER_SHUTDOWN_EXIT_GRACE_MS = 500;
const PEER_EXTENSION_PATH = fileURLToPath(import.meta.url);
const AUTH_BROKER_ENV_KEYS = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const;
const PROFILE_ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;
const PROVIDER_AUTH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_AI_GATEWAY_TOKEN",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"PERPLEXITY_API_KEY",
	"TAVILY_API_KEY",
] as const;
const PEER_RUNTIME_ENV_KEYS = [
	"OMP_PEER_COMS_DIR",
	"OMP_PEER_COMS_MAX_HOPS",
	"OMP_PEER_COMS_REPLY_TIMEOUT_MS",
	"OMP_PEER_COMS_REPLY_RESULT_TTL_MS",
	"OMP_PEER_COMS_HEARTBEAT_MS",
	"OMP_PEER_COMS_STALE_MS",
	"OMP_PEER_COMS_FRAME_TIMEOUT_MS",
	"OMP_PEER_COMS_SPAWNED_IDLE_TIMEOUT_MS",
	"OMP_PEER_COMS_PARENT_CHECK_MS",
	"OMP_PEER_COMS_PARENT_PID",
] as const;

type Envelope = PromptEnvelope | ResponseEnvelope | PingEnvelope | ShutdownEnvelope;

interface PromptEnvelope {
	type: "prompt";
	msg_id: string;
	sender_id: string;
	sender_name: string;
	sender_endpoint: string;
	sender_cwd: string;
	prompt: string;
	response_schema?: unknown;
	hops: number;
	timestamp: string;
}

interface ResponseEnvelope {
	type: "response";
	msg_id: string;
	sender_id: string;
	sender_endpoint: string;
	response: unknown;
	error?: string | null;
	hops: number;
	timestamp: string;
}

interface PingEnvelope {
	type: "ping";
	msg_id: string;
	sender_id: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string;
}

interface ShutdownEnvelope {
	type: "shutdown";
	msg_id: string;
	sender_id: string;
	sender_name: string;
	sender_endpoint: string;
	reason: string;
	hops: number;
	timestamp: string;
}

interface PongEnvelope {
	type: "pong";
	msg_id: string;
	agent_card: AgentCard;
	timestamp: string;
}

export interface RegistryEntry {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	pid: number;
	endpoint: string;
	cwd: string;
	project: string;
	explicit: boolean;
	started_at: string;
	heartbeat_at: string;
	context_used_pct: number | null;
	queue_depth: number;
}

interface AgentCard {
	name: string;
	purpose: string;
	model: string;
	context_used_pct: number | null;
	queue_depth: number;
}

export interface PeerAgentDefinition {
	name: string;
	description: string;
	body: string;
	file: string;
}

interface PendingReply {
	promise: Promise<{ response?: unknown; error?: string | null }>;
	resolve: (value: { response?: unknown; error?: string | null }) => void;
	result?: { response?: unknown; error?: string | null };
	target: string;
	timer: NodeJS.Timeout | null;
	cleanupTimer: NodeJS.Timeout | null;
}

export interface InboundPrompt {
	msg_id: string;
	sender_endpoint: string;
	response_schema?: unknown;
	fulfilled: boolean;
	hops: number;
	startedEntryCount: number;
}

interface SpawnedPeer {
	pid: number | null;
	name: string;
	project: string;
	model?: string;
	purpose: string;
	launch_mode: "terminal" | "detached";
	started_at: string;
	command: string;
	args: string[];
	system_prompt_path?: string;
	agent?: string;
	agent_file?: string;
	session_dir?: string;
}

export interface PeerAuthBroker {
	handle: AuthBrokerServerHandle;
	token: string;
}

interface LaunchBaseCommand {
	command: string;
	args: string[];
	source: "override" | "installed" | "current-entrypoint" | "fallback";
}

interface PeerTimer {
	unref?: () => void;
}

interface PeerShutdownOptions {
	shutdown: () => Promise<void> | void;
	shutdownContext?: () => void;
	exit: (code: 0) => void;
	setTimer?: (callback: () => void, ms: number) => PeerTimer;
	initialDelayMs?: number;
	exitGraceMs?: number;
	onError?: (err: unknown) => void;
}

interface SpawnedPeerIdleShutdownHandle {
	schedule: () => void;
	cancel: () => void;
}

interface SpawnedPeerIdleShutdownOptions extends PeerShutdownOptions {
	idleTimeoutMs: number;
	isIdle: () => boolean;
	clearTimer?: (timer: PeerTimer) => void;
	onIdleTimeout?: () => void;
}

function nowIso(): string {
	return new Date().toISOString();
}

export function isOwnRegistryEntry(
	entry: RegistryEntry,
	identity: RegistryEntry | undefined,
	ownPid = process.pid,
): boolean {
	return entry.session_id === identity?.session_id || entry.pid === ownPid;
}

export function isSpawnCandidate(
	entry: RegistryEntry,
	requestedName: string,
	startedAfter: number,
	existingSessionIds?: ReadonlySet<string>,
): boolean {
	if (existingSessionIds?.has(entry.session_id)) return false;
	const startedAt = Date.parse(entry.started_at);
	const sameRequestedName = entry.name === requestedName || entry.name.startsWith(`${requestedName}-`);

	return sameRequestedName && startedAt >= startedAfter;
}

export function buildPeerInboundContent(senderName: string, senderCwd: string, prompt: string): string {
	return (
		`[peer-coms message from ${senderName} @ ${senderCwd}]\n` +
		`[Reply to this peer-coms message now. Do not treat the sender name as the task. ` +
		`Do not explore the repository unless the peer explicitly asks you to. ` +
		`The peer-coms extension will return your final assistant response automatically.]\n\n` +
		prompt
	);
}
export function hasActiveInboundPrompt(inboundPrompts: Iterable<InboundPrompt>): boolean {
	for (const inbound of inboundPrompts) {
		if (!inbound.fulfilled) return true;
	}
	return false;
}

export function isParentProcessAlive(
	parentPid: number,
	probe: (pid: number, signal: 0) => void = process.kill,
): boolean {
	try {
		probe(parentPid, 0);
		return true;
	} catch (err) {
		const code =
			typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
		return code !== "ESRCH";
	}
}

export function schedulePeerProcessShutdown(options: PeerShutdownOptions): void {
	const setTimer = options.setTimer ?? setTimeout;
	const firstTimer = setTimer(() => {
		Promise.resolve()
			.then(options.shutdown)
			.catch(err => {
				options.onError?.(err);
			})
			.then(() => {
				try {
					options.shutdownContext?.();
				} catch (err) {
					options.onError?.(err);
				}
				const exitTimer = setTimer(() => {
					options.exit(0);
				}, options.exitGraceMs ?? PEER_SHUTDOWN_EXIT_GRACE_MS);
				exitTimer.unref?.();
			});
	}, options.initialDelayMs ?? PEER_SHUTDOWN_ACK_DELAY_MS);
	firstTimer.unref?.();
}

export function createSpawnedPeerIdleShutdown(
	options: SpawnedPeerIdleShutdownOptions,
): SpawnedPeerIdleShutdownHandle | undefined {
	if (options.idleTimeoutMs <= 0) return undefined;

	const setTimer = options.setTimer ?? setTimeout;
	const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as NodeJS.Timeout));
	let timer: PeerTimer | undefined;

	const cancel = () => {
		if (!timer) return;
		clearTimer(timer);
		timer = undefined;
	};

	const schedule = () => {
		cancel();
		timer = setTimer(() => {
			timer = undefined;
			if (!options.isIdle()) return;
			options.onIdleTimeout?.();
			schedulePeerProcessShutdown({ ...options, initialDelayMs: 0 });
		}, options.idleTimeoutMs);
		timer.unref?.();
	};

	schedule();
	return { schedule, cancel };
}

export function buildSpawnSystemPrompt(
	name: string,
	purpose: string,
	initialPrompt?: string,
	agentPrompt?: string,
): string {
	return prompt.render(peerComsSpawnPrompt, {
		name,
		purpose: purpose || undefined,
		initial_prompt: initialPrompt?.trim() || undefined,
		agent_prompt: agentPrompt?.trim() || undefined,
	});
}

function randomId(): string {
	return crypto.randomBytes(10).toString("hex");
}

function safeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "peer";
}

function peerSessionDir(project: string, name: string): string {
	return path.join(projectDir(project), "sessions", safeName(name));
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	if (!raw.startsWith("---\n")) return { fields: {}, body: raw.trim() };
	const end = raw.indexOf("\n---\n", 4);
	if (end < 0) return { fields: {}, body: raw.trim() };

	const fields: Record<string, string> = {};
	for (const line of raw.slice(4, end).split("\n")) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}

	return { fields, body: raw.slice(end + 5).trim() };
}

export function parsePeerAgentDefinition(filePath: string, raw: string): PeerAgentDefinition | null {
	const parsed = parseFrontmatter(raw);
	const fallbackName = path.basename(filePath, ".md");
	const name = (parsed.fields.name || fallbackName).trim();
	if (!name) return null;
	return {
		name,
		description: (parsed.fields.description || "").trim(),
		body: parsed.body,
		file: filePath,
	};
}

function agentDefinitionDirs(cwd: string): string[] {
	return [
		path.join(cwd, ".omp", "agents"),
		path.join(cwd, ".pi", "agents"),
		path.join(cwd, "agents"),
		path.join(cwd, ".claude", "agents"),
	];
}

function readAgentDefinition(filePath: string): PeerAgentDefinition | null {
	if (!filePath.endsWith(".md") || !fs.existsSync(filePath)) return null;
	try {
		return parsePeerAgentDefinition(filePath, fs.readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function resolvePeerAgentDefinition(cwd: string, spec: string | undefined): PeerAgentDefinition | undefined {
	const trimmed = spec?.trim();
	if (!trimmed) return undefined;

	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.endsWith(".md")) {
		const filePath = path.resolve(cwd, trimmed);
		return readAgentDefinition(filePath) ?? undefined;
	}

	for (const dir of agentDefinitionDirs(cwd)) {
		const direct = readAgentDefinition(path.join(dir, `${trimmed}.md`));
		if (direct) return direct;

		try {
			for (const file of fs.readdirSync(dir)) {
				const definition = readAgentDefinition(path.join(dir, file));
				if (definition?.name.toLowerCase() === trimmed.toLowerCase()) return definition;
			}
		} catch {
			// Ignore missing agent directories.
		}
	}

	return undefined;
}

function renderAgentPrompt(definition: PeerAgentDefinition | undefined): string | undefined {
	return definition?.body;
}

function projectDir(project: string): string {
	return path.join(PEER_COMS_DIR, "projects", safeName(project));
}

function registryDir(project: string): string {
	return path.join(projectDir(project), "agents");
}

function registryPath(project: string, sessionId: string): string {
	return path.join(registryDir(project), `${sessionId}.json`);
}

function endpointPath(sessionId: string): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\omp-peer-coms-${sessionId}`;
	return path.join(PEER_COMS_DIR, "sockets", `${sessionId}.sock`);
}

function writeRegistry(entry: RegistryEntry): void {
	const dir = registryDir(entry.project);
	fs.mkdirSync(dir, { recursive: true });
	const finalPath = registryPath(entry.project, entry.session_id);
	const tmpPath = `${finalPath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2));
	fs.renameSync(tmpPath, finalPath);
}

function removeRegistry(project: string, sessionId: string): void {
	try {
		fs.unlinkSync(registryPath(project, sessionId));
	} catch {
		// Best effort during shutdown and stale pruning.
	}
}

function listProjects(): string[] {
	const root = path.join(PEER_COMS_DIR, "projects");
	try {
		return fs.readdirSync(root).filter(name => fs.statSync(path.join(root, name)).isDirectory());
	} catch {
		return [];
	}
}

function readRegistryEntries(project: string): RegistryEntry[] {
	const dir = registryDir(project);
	try {
		return fs
			.readdirSync(dir)
			.filter(file => file.endsWith(".json"))
			.flatMap(file => {
				try {
					const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as RegistryEntry;
					return parsed?.session_id ? [parsed] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return Boolean((err as NodeJS.ErrnoException).code === "EPERM");
	}
}

function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
	return new Promise(resolve => {
		const socket = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: "in_use" | "stale") => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {
				// Ignore cleanup failures.
			}
			resolve(verdict);
		};
		const timer = setTimeout(() => finish("stale"), 250);
		timer.unref?.();
		socket.once("connect", () => {
			clearTimeout(timer);
			finish("in_use");
		});
		socket.once("error", () => {
			clearTimeout(timer);
			finish("stale");
		});
	});
}

function pruneRegistry(project: string): RegistryEntry[] {
	const cutoff = Date.now() - PEER_STALE_MS;
	const live: RegistryEntry[] = [];
	for (const entry of readRegistryEntries(project)) {
		const fresh = Date.parse(entry.heartbeat_at) >= cutoff;
		if (fresh && processIsLive(entry.pid)) {
			live.push(entry);
		} else {
			removeRegistry(project, entry.session_id);
		}
	}
	return live;
}

function uniquePeerName(project: string, desiredName: string): string {
	const liveNames = new Set(pruneRegistry(project).map(entry => entry.name));
	if (!liveNames.has(desiredName)) return desiredName;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${desiredName}-${i}`;
		if (!liveNames.has(candidate)) return candidate;
	}
	return `${desiredName}-${randomId().slice(0, 4)}`;
}

function resolveExecutableOnPath(command: string, pathValue = process.env.PATH): string | undefined {
	if (!pathValue) return undefined;
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		for (const extension of extensions) {
			const candidate = path.join(dir, `${command}${extension}`);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// Try the next candidate.
			}
		}
	}
	return undefined;
}

export function launchBaseCommand(
	options: {
		env?: NodeJS.ProcessEnv;
		entrypoint?: string;
		execPath?: string;
		resolveExecutable?: (command: string, pathValue?: string) => string | undefined;
		fileExists?: (candidate: string) => boolean;
	} = {},
): LaunchBaseCommand {
	const env = options.env ?? process.env;
	const override = env.OMP_PEER_COMS_SPAWN_CMD;
	if (override) return { command: override, args: [], source: "override" };

	const resolveExecutable = options.resolveExecutable ?? resolveExecutableOnPath;
	const installed = resolveExecutable("omp", env.PATH);
	if (installed) return { command: installed, args: [], source: "installed" };

	const entrypoint = options.entrypoint ?? process.argv[1];
	const execPath = options.execPath ?? process.execPath;
	const fileExists = options.fileExists ?? fs.existsSync;
	if (entrypoint && /\.(ts|js|mjs|cjs)$/.test(entrypoint)) {
		return { command: execPath, args: [entrypoint], source: "current-entrypoint" };
	}
	if (entrypoint && fileExists(entrypoint) && path.basename(entrypoint).includes("omp")) {
		return { command: entrypoint, args: [], source: "current-entrypoint" };
	}
	return { command: "omp", args: [], source: "fallback" };
}

function copyEnvKeys(target: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv, keys: readonly string[]): void {
	for (const key of keys) {
		const value = source[key];
		if (value !== undefined) target[key] = value;
	}
}

export function buildPeerSpawnEnv(
	input: { baseEnv?: NodeJS.ProcessEnv; agentDir?: string; broker?: PeerAuthBroker; parentPid?: number } = {},
): NodeJS.ProcessEnv {
	const source = input.baseEnv ?? process.env;
	const env: NodeJS.ProcessEnv = { ...source };
	copyEnvKeys(env, source, PROFILE_ENV_KEYS);
	copyEnvKeys(env, source, PROVIDER_AUTH_ENV_KEYS);
	copyEnvKeys(env, source, PEER_RUNTIME_ENV_KEYS);
	env.PI_CODING_AGENT_DIR = input.agentDir ?? source.PI_CODING_AGENT_DIR ?? getAgentDir();
	env.OMP_PEER_COMS_PARENT_PID = String(input.parentPid ?? process.pid);
	if (env.OMP_PEER_COMS_SPAWNED_IDLE_TIMEOUT_MS === undefined) {
		env.OMP_PEER_COMS_SPAWNED_IDLE_TIMEOUT_MS = String(DEFAULT_SPAWNED_IDLE_TIMEOUT_MS);
	}

	if (input.broker) {
		env.OMP_AUTH_BROKER_URL = input.broker.handle.url;
		env.OMP_AUTH_BROKER_TOKEN = input.broker.token;
	} else {
		copyEnvKeys(env, source, AUTH_BROKER_ENV_KEYS);
	}

	return env;
}

function buildPeerSpawnShellEnvPrefix(env: NodeJS.ProcessEnv): string {
	const keys = [...AUTH_BROKER_ENV_KEYS, ...PROFILE_ENV_KEYS, ...PEER_RUNTIME_ENV_KEYS];
	const assignments = keys.flatMap(key => {
		const value = env[key];
		return value === undefined ? [] : [`${key}=${shellQuote(value)}`];
	});
	return assignments.length > 0 ? `env ${assignments.join(" ")} ` : "";
}

export function buildPeerSpawnArgs(input: {
	baseArgs: string[];
	extensionPath: string;
	name: string;
	project: string;
	purpose: string;
	model?: string;
	systemPromptPath: string;
	sessionDir?: string;
}): string[] {
	const args = [
		...input.baseArgs,
		"-e",
		input.extensionPath,
		"--append-system-prompt",
		input.systemPromptPath,
		"--peer-name",
		input.name,
		"--peer-project",
		input.project,
		"--peer-purpose",
		input.purpose,
	];
	if (input.model) args.push("--model", input.model);
	if (input.sessionDir) args.push("--session-dir", input.sessionDir);
	return args;
}

function writeSpawnSystemPrompt(name: string, purpose: string, initialPrompt?: string, agentPrompt?: string): string {
	const dir = path.join(PEER_COMS_DIR, "prompts");
	fs.mkdirSync(dir, { recursive: true });
	const promptPath = path.join(dir, `${safeName(name)}-${randomId()}.md`);
	fs.writeFileSync(promptPath, buildSpawnSystemPrompt(name, purpose, initialPrompt, agentPrompt));
	return promptPath;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandLine(command: string, args: string[]): string {
	return [command, ...args].map(shellQuote).join(" ");
}

function sleep(ms: number): Promise<void> {
	return Bun.sleep(ms);
}
function waitForChildProcessStart(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			child.removeListener("spawn", onSpawn);
			child.removeListener("error", onError);
			if (err) reject(err);
			else resolve();
		};
		const onSpawn = () => finish();
		const onError = (err: Error) => finish(err);
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

function readLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			socket.removeListener("data", onData);
			reject(err);
		};

		const onData = (chunk: Buffer) => {
			buf += chunk.toString("utf8");
			if (buf.length > LINE_CAP_BYTES) {
				fail(new Error("peer-coms frame too large"));
				return;
			}
			const newline = buf.indexOf("\n");
			if (newline < 0) return;
			if (settled) return;
			settled = true;
			socket.removeListener("data", onData);
			resolve(buf.slice(0, newline));
		};

		socket.on("data", onData);
		socket.once("error", fail);
		socket.once("close", () => fail(new Error("socket closed before response")));
	});
}

function sendFrame(endpoint: string, envelope: Envelope): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ path: endpoint });
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try {
				socket.destroy();
			} catch {
				// Ignore cleanup failures.
			}
			reject(err);
		};

		timer = setTimeout(() => fail(new Error("peer-coms frame timed out")), FRAME_TIMEOUT_MS);
		timer.unref?.();

		socket.once("error", fail);
		socket.once("connect", async () => {
			try {
				socket.write(`${JSON.stringify(envelope)}\n`);
				const line = await readLine(socket);
				const parsed = JSON.parse(line);
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				socket.end();
				if (parsed?.type === "nack") {
					reject(new Error(parsed.reason || "peer rejected message"));
				} else {
					resolve(parsed);
				}
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

async function bindEndpoint(endpoint: string, handler: (socket: net.Socket) => void): Promise<net.Server> {
	if (process.platform !== "win32" && fs.existsSync(endpoint)) {
		const verdict = await probeStaleSocket(endpoint);
		if (verdict === "in_use") {
			throw new Error(`peer-coms endpoint already in use (${endpoint})`);
		}
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// If unlink fails, listen() will report the real error.
		}
	}

	return new Promise((resolve, reject) => {
		const server = net.createServer(handler);
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

function ack(socket: net.Socket, msgId: string): void {
	socket.end(`${JSON.stringify({ type: "ack", msg_id: msgId })}\n`);
}

function nack(socket: net.Socket, msgId: string, reason: string): void {
	socket.end(`${JSON.stringify({ type: "nack", msg_id: msgId, reason })}\n`);
}

export function assistantTextFromEntries(entries: Iterable<unknown>, startIndex = 0): { text: string; found: boolean } {
	let text = "";
	let found = false;
	let index = 0;
	for (const entry of entries) {
		if (index++ < startIndex) continue;
		const candidate = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
		if (candidate.type !== "message" || candidate.message?.role !== "assistant") continue;
		found = true;
		const content = candidate.message.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter((part): part is { type: "text"; text: string } => {
					return Boolean(
						part &&
							typeof part === "object" &&
							(part as { type?: unknown }).type === "text" &&
							typeof (part as { text?: unknown }).text === "string",
					);
				})
				.map(part => part.text)
				.join("\n");
		}
	}
	return { text, found };
}

function lastAssistantText(ctx: ExtensionContext, startIndex = 0): { text: string; found: boolean } {
	return assistantTextFromEntries(ctx.sessionManager.getBranch(), startIndex);
}

export default function peerComs(pi: ExtensionAPI) {
	const z = pi.zod;

	pi.registerFlag("peer-name", {
		description: "Name for this peer-coms agent",
		type: "string",
		default: "",
	});
	pi.registerFlag("peer-purpose", {
		description: "Short purpose shown to peers",
		type: "string",
		default: "",
	});
	pi.registerFlag("peer-project", {
		description: "Peer-coms project namespace",
		type: "string",
		default: "default",
	});
	pi.registerFlag("peer-explicit", {
		description: "Hide this peer unless include_explicit is requested",
		type: "boolean",
		default: false,
	});

	let identity: RegistryEntry | undefined;
	let server: net.Server | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let parentWatch: NodeJS.Timeout | undefined;
	let idleShutdown: SpawnedPeerIdleShutdownHandle | undefined;
	let currentCtx: ExtensionContext | undefined;
	let currentInbound: InboundPrompt | undefined;
	let showExplicit = false;
	let displayProject = "default";
	let shuttingDown = false;
	let processExitScheduled = false;
	let peerAuthBroker: PeerAuthBroker | undefined;

	const pendingReplies = new Map<string, PendingReply>();
	const inboundPrompts = new Map<string, InboundPrompt>();
	const spawnedPeers = new Map<string, SpawnedPeer>();

	function ensurePeerAuthBroker(ctx: ExtensionContext): PeerAuthBroker | undefined {
		if (process.env.OMP_AUTH_BROKER_URL) return undefined;
		if (peerAuthBroker) return peerAuthBroker;

		const token = randomId();
		const handle = startAuthBroker({
			storage: ctx.modelRegistry.authStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			version: "peer-coms",
		});
		peerAuthBroker = { handle, token };
		pi.appendEntry("peer-coms-log", { event: "auth_broker_start", url: handle.url, ts: nowIso() });
		return peerAuthBroker;
	}

	function currentRegistryEntry(): RegistryEntry | undefined {
		if (!identity) return undefined;
		const usage = currentCtx?.getContextUsage();
		return {
			...identity,
			model: currentCtx?.model?.id ?? identity.model,
			heartbeat_at: nowIso(),
			context_used_pct: typeof usage?.percent === "number" ? Math.round(usage.percent) : null,
			queue_depth: inboundPrompts.size,
		};
	}

	function peers(project: string, includeExplicit: boolean): RegistryEntry[] {
		const projects = project === "*" ? listProjects() : [project];
		return projects
			.flatMap(pruneRegistry)
			.filter(entry => !isOwnRegistryEntry(entry, identity))
			.filter(entry => includeExplicit || !entry.explicit);
	}

	function targetCandidates(project: string): RegistryEntry[] {
		return pruneRegistry(project).filter(entry => !isOwnRegistryEntry(entry, identity));
	}

	function resolveTarget(target: string): RegistryEntry | undefined {
		const sameProject = identity ? targetCandidates(identity.project) : [];
		const localByName = sameProject.find(entry => entry.name === target);
		if (localByName) return localByName;

		const allPeers = listProjects().flatMap(targetCandidates);
		return allPeers.find(entry => entry.session_id === target) ?? allPeers.find(entry => entry.name === target);
	}

	function isPong(value: unknown): value is PongEnvelope {
		return Boolean(
			value &&
				typeof value === "object" &&
				(value as { type?: unknown }).type === "pong" &&
				typeof (value as { msg_id?: unknown }).msg_id === "string" &&
				(value as { agent_card?: unknown }).agent_card !== null &&
				typeof (value as { agent_card?: unknown }).agent_card === "object",
		);
	}

	async function pingPeer(entry: RegistryEntry): Promise<AgentCard | null> {
		if (!identity) return null;
		try {
			const response = await sendFrame(entry.endpoint, {
				type: "ping",
				msg_id: randomId(),
				sender_id: identity.session_id,
				sender_endpoint: identity.endpoint,
				hops: 0,
				timestamp: nowIso(),
			});
			return isPong(response) ? response.agent_card : null;
		} catch {
			return null;
		}
	}

	async function waitForSpawnedPeer(
		project: string,
		name: string,
		startedAfter: number,
		waitMs: number,
		existingSessionIds: ReadonlySet<string>,
	) {
		const deadline = Date.now() + waitMs;
		while (Date.now() <= deadline) {
			const match = targetCandidates(project).find(entry =>
				isSpawnCandidate(entry, name, startedAfter, existingSessionIds),
			);
			if (match && (await pingPeer(match))) return match;
			await sleep(250);
		}
		return undefined;
	}

	function installWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"peer-coms",
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const visiblePeers = peers(displayProject, showExplicit).slice(0, 6);
					const title = identity ? `peer-coms ${identity.name}@${displayProject}` : `peer-coms ${displayProject}`;
					if (visiblePeers.length === 0) return [theme.fg("dim", ` ${title}: no peers`)];
					const names = visiblePeers.map(peer => {
						const pct = typeof peer.context_used_pct === "number" ? `${peer.context_used_pct}%` : "?%";
						return `${peer.name} ${theme.fg("dim", peer.model)} ${theme.fg("warning", pct)}`;
					});
					const line = ` ${title}: ${names.join(" | ")}`;
					return [line.length > width ? `${line.slice(0, Math.max(0, width - 3))}...` : line];
				},
			}),
			{ placement: "belowEditor" },
		);
	}

	function refreshPresence(): void {
		const entry = currentRegistryEntry();
		if (!entry) return;
		identity = entry;
		try {
			writeRegistry(entry);
			if (currentCtx) installWidget(currentCtx);
		} catch (err) {
			pi.logger.warn("peer-coms heartbeat failed", { err });
		}
	}

	function schedulePeerProcessExit(reason: string): void {
		if (processExitScheduled) return;
		processExitScheduled = true;
		pi.appendEntry("peer-coms-log", { event: "process_exit_scheduled", reason, ts: nowIso() });
		schedulePeerProcessShutdown({
			shutdown,
			shutdownContext: () => currentCtx?.shutdown(),
			exit: code => {
				process.exit(code);
			},
			onError: err => {
				pi.logger.warn("peer-coms shutdown failed", { err });
			},
		});
	}

	function installSpawnedLifecycle(): void {
		const parentPid = Number(process.env.OMP_PEER_COMS_PARENT_PID ?? 0);
		if (Number.isInteger(parentPid) && parentPid > 0 && parentPid !== process.pid && PARENT_CHECK_MS > 0) {
			parentWatch = setInterval(() => {
				if (isParentProcessAlive(parentPid)) return;
				if (parentWatch) clearInterval(parentWatch);
				parentWatch = undefined;
				schedulePeerProcessExit("parent process exited");
			}, PARENT_CHECK_MS);
			parentWatch.unref?.();
		}

		if (process.env.OMP_PEER_COMS_PARENT_PID === undefined) return;
		idleShutdown = createSpawnedPeerIdleShutdown({
			idleTimeoutMs: SPAWNED_IDLE_TIMEOUT_MS,
			isIdle: () => !hasActiveInboundPrompt(inboundPrompts.values()),
			shutdown,
			shutdownContext: () => currentCtx?.shutdown(),
			exit: code => {
				process.exit(code);
			},
			onIdleTimeout: () => {
				pi.appendEntry("peer-coms-log", {
					event: "spawned_idle_timeout",
					idle_timeout_ms: SPAWNED_IDLE_TIMEOUT_MS,
					ts: nowIso(),
				});
			},
			onError: err => {
				pi.logger.warn("peer-coms idle shutdown failed", { err });
			},
		});
	}

	function schedulePendingReplyCleanup(msgId: string, pending: PendingReply): void {
		if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer);
		pending.cleanupTimer = setTimeout(() => {
			pendingReplies.delete(msgId);
		}, REPLY_RESULT_TTL_MS);
		pending.cleanupTimer.unref?.();
	}

	function forgetPendingReply(msgId: string, pending: PendingReply): void {
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer);
		pendingReplies.delete(msgId);
	}

	function completePendingReply(
		msgId: string,
		pending: PendingReply,
		result: { response?: unknown; error?: string | null },
	): void {
		if (pending.timer) clearTimeout(pending.timer);
		pending.timer = null;
		pending.result = result;
		pending.resolve(result);
		schedulePendingReplyCleanup(msgId, pending);
	}

	function handlePrompt(socket: net.Socket, envelope: PromptEnvelope): void {
		if (envelope.hops >= MAX_HOPS) {
			nack(socket, envelope.msg_id, `hop limit reached (${MAX_HOPS})`);
			return;
		}

		if (hasActiveInboundPrompt(inboundPrompts.values())) {
			nack(socket, envelope.msg_id, "peer-coms receiver is already processing an inbound prompt");
			return;
		}

		const inbound: InboundPrompt = {
			msg_id: envelope.msg_id,
			sender_endpoint: envelope.sender_endpoint,
			response_schema: envelope.response_schema,
			fulfilled: false,
			hops: envelope.hops,
			startedEntryCount: currentCtx?.sessionManager.getBranch().length ?? 0,
		};
		inboundPrompts.set(envelope.msg_id, inbound);
		currentInbound = inbound;
		idleShutdown?.cancel();

		try {
			pi.sendMessage(
				{
					customType: "peer-coms-inbound",
					content: buildPeerInboundContent(envelope.sender_name, envelope.sender_cwd, envelope.prompt),
					display: true,
					details: {
						msg_id: envelope.msg_id,
						sender_id: envelope.sender_id,
						hops: envelope.hops,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (err) {
			inboundPrompts.delete(envelope.msg_id);
			if (currentInbound?.msg_id === envelope.msg_id) currentInbound = undefined;
			if (!hasActiveInboundPrompt(inboundPrompts.values())) idleShutdown?.schedule();
			nack(socket, envelope.msg_id, err instanceof Error ? err.message : "failed to queue peer-coms prompt");
			return;
		}

		pi.appendEntry("peer-coms-log", {
			event: "prompt_in",
			msg_id: envelope.msg_id,
			sender: envelope.sender_name,
			ts: nowIso(),
		});
		ack(socket, envelope.msg_id);
	}

	function handleResponse(socket: net.Socket, envelope: ResponseEnvelope): void {
		const pending = pendingReplies.get(envelope.msg_id);
		if (pending) {
			completePendingReply(envelope.msg_id, pending, {
				response: envelope.response,
				error: envelope.error ?? null,
			});
			pi.appendEntry("peer-coms-log", {
				event: "response_in",
				msg_id: envelope.msg_id,
				error: envelope.error ?? null,
				ts: nowIso(),
			});
		}
		ack(socket, envelope.msg_id);
	}

	function handlePing(socket: net.Socket, envelope: PingEnvelope): void {
		const usage = currentCtx?.getContextUsage();
		const card: AgentCard = {
			name: identity?.name ?? "unknown",
			purpose: identity?.purpose ?? "",
			model: currentCtx?.model?.id ?? identity?.model ?? "unknown",
			context_used_pct: typeof usage?.percent === "number" ? Math.round(usage.percent) : null,
			queue_depth: inboundPrompts.size,
		};
		socket.end(
			`${JSON.stringify({
				type: "pong",
				msg_id: envelope.msg_id,
				agent_card: card,
				timestamp: nowIso(),
			} satisfies PongEnvelope)}\n`,
		);
	}

	function handleShutdown(socket: net.Socket, envelope: ShutdownEnvelope): void {
		pi.appendEntry("peer-coms-log", {
			event: "shutdown_requested",
			msg_id: envelope.msg_id,
			sender: envelope.sender_name,
			reason: envelope.reason,
			ts: nowIso(),
		});
		ack(socket, envelope.msg_id);
		schedulePeerProcessExit(`shutdown requested by ${envelope.sender_name}: ${envelope.reason}`);
	}

	function handleConnection(socket: net.Socket): void {
		readLine(socket)
			.then(line => {
				const parsed = JSON.parse(line) as Envelope;
				if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
					nack(socket, "", "malformed envelope");
					return;
				}
				if (parsed.type === "prompt") handlePrompt(socket, parsed);
				else if (parsed.type === "response") handleResponse(socket, parsed);
				else if (parsed.type === "ping") handlePing(socket, parsed);
				else if (parsed.type === "shutdown") handleShutdown(socket, parsed);
				else nack(socket, "", "unknown envelope type");
			})
			.catch(err => {
				pi.logger.debug("peer-coms connection failed", { err });
				try {
					socket.destroy();
				} catch {
					// Ignore cleanup failures.
				}
			});
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		const sessionId = randomId();
		const project = String(pi.getFlag("peer-project") || "default");
		const requestedName = String(pi.getFlag("peer-name") || `peer-${sessionId.slice(-6)}`);
		const name = uniquePeerName(project, requestedName);
		const purpose = String(pi.getFlag("peer-purpose") || "");
		const endpoint = endpointPath(sessionId);

		try {
			fs.mkdirSync(path.dirname(endpoint), { recursive: true });
			fs.mkdirSync(registryDir(project), { recursive: true });
			if (process.platform !== "win32") {
				try {
					fs.chmodSync(PEER_COMS_DIR, 0o700);
				} catch {
					// Best effort. Existing installs may be on filesystems without chmod.
				}
			}
			server = await bindEndpoint(endpoint, handleConnection);
		} catch (err) {
			ctx.ui.notify(`peer-coms failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		const usage = ctx.getContextUsage();
		identity = {
			session_id: sessionId,
			name,
			purpose,
			model: ctx.model?.id ?? "unknown",
			pid: process.pid,
			endpoint,
			cwd: ctx.cwd,
			project,
			explicit: pi.getFlag("peer-explicit") === true,
			started_at: nowIso(),
			heartbeat_at: nowIso(),
			context_used_pct: typeof usage?.percent === "number" ? Math.round(usage.percent) : null,
			queue_depth: 0,
		};
		displayProject = project;
		writeRegistry(identity);

		ctx.ui.setStatus("peer-coms", `${name}@${project}`);
		installWidget(ctx);
		heartbeat = setInterval(refreshPresence, HEARTBEAT_MS);
		heartbeat.unref?.();
		installSpawnedLifecycle();

		pi.appendEntry("peer-coms-log", { event: "boot", session_id: sessionId, name, project, ts: nowIso() });
	});

	pi.registerTool({
		name: "peer_list",
		label: "Peer List",
		description:
			"List flat peer-coms agents. These are independent OMP sessions, often running different models. " +
			"Any peer can send prompts to any other peer; there is no orchestrator role.",
		parameters: z.object({
			project: z
				.string()
				.optional()
				.describe('Project namespace, or "*" for all projects. Defaults to this peer project.'),
			include_explicit: z.boolean().optional().describe("Include peers launched with --peer-explicit."),
		}),
		async execute(_toolCallId, params) {
			const project = params.project ?? identity?.project ?? "default";
			const entries = peers(project, params.include_explicit === true);
			const pings = await Promise.allSettled(entries.map(entry => pingPeer(entry)));
			const livePeers = entries.map((entry, index) => {
				const ping = pings[index];
				const card = ping.status === "fulfilled" ? ping.value : null;
				return { entry, card, alive: card !== null };
			});
			const text = livePeers.length
				? livePeers
						.map(({ entry, card, alive }) => {
							const pctSource = card?.context_used_pct ?? entry.context_used_pct;
							const pct = typeof pctSource === "number" ? `${pctSource}%` : "?%";
							const purpose = entry.purpose ? ` - ${entry.purpose}` : "";
							return `${alive ? "●" : "✗"} ${entry.name} (${entry.model}, ctx ${pct}, project ${entry.project})${purpose}`;
						})
						.join("\n")
				: "No peer-coms agents found.";
			return {
				content: [{ type: "text" as const, text }],
				details: { peers: entries, live_peers: livePeers, project },
			};
		},
	});

	pi.registerTool({
		name: "peer_spawn",
		label: "Peer Spawn",
		description:
			"Spawn a new peer-coms Pi agent as an independent peer session. " +
			"Use this when peer mode is valuable and no suitable live peer exists. " +
			"The spawned peer can run a different model and can then be contacted with peer_send.",
		parameters: z.object({
			name: z.string().describe("Requested peer name, for example reviewer or planner."),
			purpose: z.string().optional().describe("Short purpose shown to other peers."),
			project: z.string().optional().describe("Peer project namespace. Defaults to this peer's project."),
			model: z.string().optional().describe("Optional OMP --model value for the new peer."),
			agent: z
				.string()
				.optional()
				.describe(
					"Optional local peer agent definition name or markdown path from .omp/agents, .pi/agents, agents, or .claude/agents.",
				),
			launch_mode: z
				.enum(["terminal", "detached"])
				.optional()
				.describe("terminal opens a visible peer session where supported; detached starts a background process."),
			initial_prompt: z
				.string()
				.optional()
				.describe("Optional startup instructions appended to the spawned peer's system prompt."),
			wait_ms: z.number().min(0).max(30_000).optional().describe("How long to wait for peer registration."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const project = params.project ?? identity?.project ?? "default";
			const purpose = params.purpose ?? "";
			const launchMode = params.launch_mode ?? (process.platform === "darwin" ? "terminal" : "detached");
			const waitMs = params.wait_ms ?? 5_000;
			const existingSessionIds = new Set(targetCandidates(project).map(entry => entry.session_id));
			const startedAfter = Date.now() - 1000;
			const authBroker = ensurePeerAuthBroker(ctx);
			const spawnEnv = buildPeerSpawnEnv({ baseEnv: process.env, agentDir: getAgentDir(), broker: authBroker });
			const base = launchBaseCommand({ env: spawnEnv });
			const agentDefinition = resolvePeerAgentDefinition(ctx.cwd, params.agent);
			if (params.agent && !agentDefinition) {
				throw new Error(`Peer agent definition "${params.agent}" not found`);
			}
			const agentPrompt = renderAgentPrompt(agentDefinition);
			const sessionDir = peerSessionDir(project, params.name);
			const systemPromptPath = writeSpawnSystemPrompt(params.name, purpose, params.initial_prompt, agentPrompt);
			const args = buildPeerSpawnArgs({
				baseArgs: base.args,
				extensionPath: PEER_EXTENSION_PATH,
				name: params.name,
				project,
				purpose,
				model: params.model,
				systemPromptPath,
				sessionDir,
			});

			let childPid: number | null = null;
			if (launchMode === "terminal" && process.platform === "darwin") {
				const line = `cd ${shellQuote(ctx.cwd)} && ${buildPeerSpawnShellEnvPrefix(spawnEnv)}${commandLine(base.command, args)}`;
				const child = spawn(
					"osascript",
					["-e", `tell application "Terminal" to do script ${JSON.stringify(line)}`],
					{
						detached: true,
						stdio: "ignore",
					},
				);
				await waitForChildProcessStart(child);
				child.unref();
				childPid = child.pid ?? null;
			} else {
				const child = spawn(base.command, args, {
					cwd: ctx.cwd,
					env: spawnEnv,
					detached: true,
					stdio: "ignore",
				});
				await waitForChildProcessStart(child);
				child.unref();
				childPid = child.pid ?? null;
			}

			const spawned: SpawnedPeer = {
				pid: childPid,
				name: params.name,
				project,
				model: params.model,
				purpose,
				launch_mode: launchMode,
				started_at: nowIso(),
				command: base.command,
				args,
				system_prompt_path: systemPromptPath,
				agent: agentDefinition?.name,
				agent_file: agentDefinition?.file,
				session_dir: sessionDir,
			};
			spawnedPeers.set(params.name, spawned);
			pi.appendEntry("peer-coms-log", { event: "peer_spawn", ...spawned });

			const registered =
				waitMs > 0
					? await waitForSpawnedPeer(project, params.name, startedAfter, waitMs, existingSessionIds)
					: undefined;
			const text = registered
				? `Spawned peer ${registered.name} (${registered.model}) in project ${project}`
				: `Spawn requested for peer ${params.name} in project ${project}. Live registration not observed within ${waitMs}ms.`;

			return {
				content: [{ type: "text" as const, text }],
				details: {
					spawned,
					registered: registered ?? null,
					launch_mode: launchMode,
					note:
						launchMode === "detached"
							? "Detached peers require the OMP runtime to stay alive without an interactive TTY."
							: undefined,
				},
			};
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer Send",
		description:
			"Start a new flat peer-to-peer exchange with another peer-coms agent. " +
			"Do not use this to reply to an inbound peer-coms message; reply normally and peer-coms will return your final assistant text automatically.",
		parameters: z.object({
			target: z.string().describe("Peer name or session_id."),
			prompt: z.string().describe("Prompt to send to the peer."),
			response_schema: z
				.unknown()
				.optional()
				.describe("Optional JSON schema. If provided, the peer response must be JSON."),
		}),
		async execute(_toolCallId, params) {
			if (!identity) throw new Error("peer-coms is not initialized");
			const target = resolveTarget(params.target);
			if (!target) throw new Error(`No live peer-coms agent found for ${params.target}`);

			const hops = currentInbound ? currentInbound.hops + 1 : 0;
			if (hops >= MAX_HOPS) throw new Error(`peer-coms hop limit reached (${hops} >= ${MAX_HOPS})`);

			const msgId = randomId();
			const { promise, resolve: resolveReply } = Promise.withResolvers<{
				response?: unknown;
				error?: string | null;
			}>();
			const pending: PendingReply = {
				promise,
				resolve: resolveReply,
				target: target.name,
				timer: null,
				cleanupTimer: null,
			};
			pending.timer = setTimeout(() => {
				completePendingReply(msgId, pending, { error: "timeout" });
			}, REPLY_TIMEOUT_MS);
			pending.timer?.unref?.();
			pendingReplies.set(msgId, pending);

			try {
				await sendFrame(target.endpoint, {
					type: "prompt",
					msg_id: msgId,
					sender_id: identity.session_id,
					sender_name: identity.name,
					sender_endpoint: identity.endpoint,
					sender_cwd: identity.cwd,
					prompt: params.prompt,
					response_schema: params.response_schema,
					hops,
					timestamp: nowIso(),
				});
			} catch (err) {
				forgetPendingReply(msgId, pending);
				throw err;
			}

			pi.appendEntry("peer-coms-log", {
				event: "prompt_out",
				msg_id: msgId,
				target: target.name,
				hops,
				ts: nowIso(),
			});

			return {
				content: [{ type: "text" as const, text: `peer_send queued for ${target.name}\nmsg_id ${msgId}` }],
				details: { msg_id: msgId, target: target.name, target_session: target.session_id, hops },
			};
		},
	});

	pi.registerTool({
		name: "peer_get",
		label: "Peer Get",
		description: "Non-blocking poll for the reply to a msg_id returned by peer_send.",
		parameters: z.object({
			msg_id: z.string().describe("msg_id returned by peer_send."),
		}),
		async execute(_toolCallId, params) {
			const pending = pendingReplies.get(params.msg_id);
			if (!pending) {
				return {
					content: [{ type: "text" as const, text: `Unknown msg_id ${params.msg_id}` }],
					details: { status: "error", target: "", error: "unknown msg_id", response: null },
				};
			}
			if (!pending.result) {
				return {
					content: [{ type: "text" as const, text: "pending" }],
					details: { status: "pending", target: pending.target, error: null, response: null },
				};
			}
			const text = pending.result.error
				? `error: ${pending.result.error}`
				: typeof pending.result.response === "string"
					? pending.result.response
					: JSON.stringify(pending.result.response, null, 2);
			const result = {
				content: [{ type: "text" as const, text }],
				details: {
					status: pending.result.error ? "error" : "complete",
					target: pending.target,
					error: pending.result.error ?? null,
					response: pending.result.response ?? null,
				},
			};
			forgetPendingReply(params.msg_id, pending);
			return result;
		},
	});

	pi.registerTool({
		name: "peer_await",
		label: "Peer Await",
		description: "Wait for the reply to a msg_id returned by peer_send.",
		parameters: z.object({
			msg_id: z.string().describe("msg_id returned by peer_send."),
			timeout_ms: z.number().positive().optional().describe("Maximum wait in milliseconds."),
		}),
		async execute(_toolCallId, params) {
			const pending = pendingReplies.get(params.msg_id);
			if (!pending) {
				return {
					content: [{ type: "text" as const, text: `Unknown msg_id ${params.msg_id}` }],
					details: { status: "error", target: "", error: "unknown msg_id", response: null },
				};
			}
			const timeoutMs = params.timeout_ms ?? REPLY_TIMEOUT_MS;
			const timeout = new Promise<{ error: string }>(resolve => {
				const timer = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
				timer.unref?.();
			});
			const result = pending.result ?? (await Promise.race([pending.promise, timeout]));
			const response = "response" in result ? result.response : undefined;
			const text = result.error
				? `error: ${result.error}`
				: typeof response === "string"
					? response
					: JSON.stringify(response, null, 2);
			const payload = {
				content: [{ type: "text" as const, text }],
				details: {
					status: result.error ? "error" : "complete",
					target: pending.target,
					error: result.error ?? null,
					response,
				},
			};
			if (pending.result) forgetPendingReply(params.msg_id, pending);
			return payload;
		},
	});

	pi.registerTool({
		name: "peer_shutdown",
		label: "Peer Shutdown",
		description:
			"Gracefully shut down a peer-coms agent when peer-mode work is complete. " +
			"Use this for peers that were spawned for the current task and are no longer needed.",
		parameters: z.object({
			target: z.string().describe("Peer name or session_id to shut down."),
			reason: z.string().optional().describe("Short reason recorded in the peer-coms audit log."),
		}),
		async execute(_toolCallId, params) {
			if (!identity) throw new Error("peer-coms is not initialized");
			const target = resolveTarget(params.target);
			if (!target) throw new Error(`No live peer-coms agent found for ${params.target}`);
			const msgId = randomId();
			await sendFrame(target.endpoint, {
				type: "shutdown",
				msg_id: msgId,
				sender_id: identity.session_id,
				sender_name: identity.name,
				sender_endpoint: identity.endpoint,
				reason: params.reason ?? "peer-mode work complete",
				hops: 0,
				timestamp: nowIso(),
			});
			pi.appendEntry("peer-coms-log", {
				event: "shutdown_out",
				msg_id: msgId,
				target: target.name,
				reason: params.reason ?? "peer-mode work complete",
				ts: nowIso(),
			});
			return {
				content: [{ type: "text" as const, text: `Shutdown requested for peer ${target.name}` }],
				details: { target: target.name, target_session: target.session_id, msg_id: msgId },
			};
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!identity) return;
		const inbound = currentInbound && !currentInbound.fulfilled ? currentInbound : undefined;
		if (!inbound) return;

		const extracted = lastAssistantText(ctx, inbound.startedEntryCount);
		let response: unknown = extracted.text;
		let error: string | null = extracted.found ? null : "peer produced no assistant response";
		if (inbound.response_schema) {
			try {
				response = JSON.parse(String(response));
			} catch {
				response = null;
				error = "response was not valid JSON";
			}
		}

		try {
			await sendFrame(inbound.sender_endpoint, {
				type: "response",
				msg_id: inbound.msg_id,
				sender_id: identity.session_id,
				sender_endpoint: identity.endpoint,
				response,
				error,
				hops: inbound.hops,
				timestamp: nowIso(),
			});
			pi.appendEntry("peer-coms-log", { event: "response_out", msg_id: inbound.msg_id, error, ts: nowIso() });
		} catch (err) {
			pi.appendEntry("peer-coms-log", {
				event: "response_out_failed",
				msg_id: inbound.msg_id,
				reason: err instanceof Error ? err.message : String(err),
				ts: nowIso(),
			});
		}

		inbound.fulfilled = true;
		inboundPrompts.delete(inbound.msg_id);
		if (currentInbound?.msg_id === inbound.msg_id) currentInbound = undefined;
		refreshPresence();
		idleShutdown?.schedule();
	});

	pi.registerCommand("peer-coms", {
		description: "Refresh peer-coms presence; supports --all and --project <name>",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text.includes("--all")) showExplicit = !showExplicit;
			const projectMatch = text.match(/--project\s+(\S+)/);
			if (projectMatch) displayProject = projectMatch[1];
			refreshPresence();
			installWidget(ctx);
			ctx.ui.notify(
				`peer-coms refreshed: ${displayProject}${showExplicit ? " including explicit peers" : ""}`,
				"info",
			);
		},
	});

	async function shutdownSpawnedPeers(reason: string): Promise<void> {
		if (!identity || spawnedPeers.size === 0) return;
		const requests: Array<Promise<unknown>> = [];
		for (const spawned of spawnedPeers.values()) {
			const startedAfter = Date.parse(spawned.started_at) - 1000;
			const target = targetCandidates(spawned.project).find(entry =>
				isSpawnCandidate(entry, spawned.name, startedAfter),
			);
			if (!target) continue;
			const msgId = randomId();
			requests.push(
				sendFrame(target.endpoint, {
					type: "shutdown",
					msg_id: msgId,
					sender_id: identity.session_id,
					sender_name: identity.name,
					sender_endpoint: identity.endpoint,
					reason,
					hops: 0,
					timestamp: nowIso(),
				})
					.then(() => {
						pi.appendEntry("peer-coms-log", {
							event: "spawned_shutdown_out",
							msg_id: msgId,
							target: target.name,
							reason,
							ts: nowIso(),
						});
					})
					.catch(err => {
						pi.appendEntry("peer-coms-log", {
							event: "spawned_shutdown_failed",
							msg_id: msgId,
							target: target.name,
							reason: err instanceof Error ? err.message : String(err),
							ts: nowIso(),
						});
					}),
			);
		}
		spawnedPeers.clear();
		await Promise.all(requests);
	}

	async function shutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (parentWatch) clearInterval(parentWatch);
		parentWatch = undefined;
		idleShutdown?.cancel();
		idleShutdown = undefined;
		await shutdownSpawnedPeers("parent peer-coms session shutting down");
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		if (server) server.close();
		server = undefined;
		if (identity) {
			removeRegistry(identity.project, identity.session_id);
			if (process.platform !== "win32") {
				try {
					fs.unlinkSync(identity.endpoint);
				} catch {
					// Best effort.
				}
			}
			pi.appendEntry("peer-coms-log", { event: "shutdown", session_id: identity.session_id, ts: nowIso() });
		}
		if (currentCtx?.hasUI) {
			currentCtx.ui.setWidget("peer-coms", undefined);
			currentCtx.ui.setStatus("peer-coms", undefined);
		}
		for (const [msgId, pending] of pendingReplies) {
			forgetPendingReply(msgId, pending);
		}
		if (peerAuthBroker) {
			const broker = peerAuthBroker;
			peerAuthBroker = undefined;
			try {
				await broker.handle.close();
			} catch (err) {
				pi.logger.warn("peer-coms auth broker close failed", { err });
			}
		}
	}

	pi.on("session_shutdown", async () => {
		await shutdown();
	});
	process.once("SIGINT", () => {
		void shutdown();
	});
	process.once("SIGTERM", () => {
		void shutdown();
	});
}
