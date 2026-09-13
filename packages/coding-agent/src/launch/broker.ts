import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ReadableStream, ReadableStreamDefaultReader } from "node:stream/web";
import { Process, type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { isEexist, isEnoent, logger, postmortem, procmgr, sanitizeText, setProcessName } from "@oh-my-pi/pi-utils";
import { TerminalQueryResponder } from "@oh-my-pi/pi-utils/vterm";
import { hostHasInheritableConsole } from "../eval/py/spawn-options";
import { truncateHead, truncateHeadBytes, truncateTail, truncateTailBytes } from "../session/streaming-output";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { daemonBrokerEndpoint, writeDaemonScopeMeta } from "./paths";
import { hasLiveDaemonProjectPresence, pruneDeadDaemonRuntimeDirs } from "./presence";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_PTY_COLUMNS,
	DAEMON_PTY_ROWS,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
	type DaemonOperation,
	type DaemonReadySpec,
	type DaemonRpcResult,
	type DaemonSignal,
	type DaemonSnapshot,
	type DaemonSpec,
	type DaemonWireRequest,
	parseDaemonSnapshot,
	parseDaemonSpec,
	parseDaemonWireMessage,
	parseDaemonWireRequest,
} from "./protocol";
import { resolveDaemonSpawnOptions } from "./spawn-options";
import { renderTerminalOutput } from "./terminal-output";

const DEFAULT_IDLE_GRACE_MS = 3_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 25 * 1024 * 1024;
const LOG_READ_BYTES = 2 * 1024 * 1024;
const READINESS_BUFFER_CHARS = 64 * 1024;
const RESTART_MAX_DELAY_MS = 30_000;
const RESTART_BACKOFF_BASE_MS = 1_000;
/**
 * Window granted to stdout/stderr after a pipe daemon exits, for flushing
 * output that is already buffered. Output can outlive the child indefinitely
 * when a descendant inherited the write end, so this is a bound, not a wait
 * for end-of-stream.
 */
const PIPE_FLUSH_GRACE_MS = 2_000;
/**
 * Cap on terminal (exited/failed) daemons surfaced by `list`. Active daemons
 * are always shown in full; older history is truncated so the response stays
 * bounded over a long-lived project (issue #6517).
 */
const MAX_TERMINAL_DAEMONS_LISTED = 10;
const TOKEN_FILE = "broker.token";
const PID_FILE = "broker.pid";
const META_FILE = "meta.json";
const LOG_FILE = "output.log";
const PREVIOUS_LOG_FILE = "output.previous.log";
const DAEMON_SPAWN_OPTIONS = resolveDaemonSpawnOptions({
	platform: process.platform,
	hostHasInheritableConsole: hostHasInheritableConsole(),
});

const SIGNAL_NUMBER: Record<DaemonSignal, number> = {
	SIGINT: os.constants.signals.SIGINT,
	SIGTERM: os.constants.signals.SIGTERM,
	SIGHUP: os.constants.signals.SIGHUP,
	SIGQUIT: os.constants.signals.SIGQUIT,
	SIGKILL: os.constants.signals.SIGKILL,
};

interface ManagedProcess {
	pid: number;
	exited: Promise<number>;
	kill(signal?: number): void;
	unref(): void;
}

interface ManagedDaemon {
	spec: DaemonSpec;
	snapshot: DaemonSnapshot;
	dir: string;
	log?: DaemonLog;
	process?: ManagedProcess;
	/** Signal-authorized reference; see {@link DaemonBroker.pin}. */
	processRef?: Process;
	/** Opaque native identity of {@link ManagedDaemon.processRef}, persisted so a later broker can revalidate the pid. */
	identity?: string;
	input?: Bun.FileSink;
	pty?: PtySession;
	generation: number;
	stopRequested: boolean;
	logReady: boolean;
	portReady: boolean;
	readinessBuffer: string;
	outputOffset: number;
	readyPattern?: RegExp;
	restartTimer?: NodeJS.Timeout;
	/**
	 * What the last stop or exit could not finish — descendants the kill waves
	 * did not reach, or output still held after the child was gone. Carried on
	 * the record because the settlement that publishes it can land afterwards,
	 * and cleared on relaunch so one generation's warning never describes the
	 * next.
	 */
	residue?: string;
	consecutiveFailures: number;
	completionCapable: boolean;
	pendingCompletions: DaemonCompletionNotification[];
	completionSubscriptionId?: string;
	persistQueue: Promise<void>;
}

interface BrokerLease {
	path: string;
	instanceId: string;
}

interface DaemonLogRead {
	text: string;
	terminalOutput: string;
	cursor: number;
}

function quoteShellArg(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function terminalState(state: DaemonSnapshot["state"]): boolean {
	return state === "exited" || state === "failed";
}

function settledState(state: DaemonSnapshot["state"]): boolean {
	return terminalState(state) || state === "restarting";
}

function publishesCompletionOwners(request: DaemonWireRequest): boolean {
	return request.completionEvents === true && (request.completionAcks?.length ?? 0) === 0;
}

/**
 * Order daemons for the `list` response: non-terminal (active) daemons first,
 * oldest to newest, so the process the user is acting on is immediately visible
 * instead of buried behind exited history; then the most recently exited/failed
 * ones, capped at {@link MAX_TERMINAL_DAEMONS_LISTED} to keep the response from
 * growing without bound. Truncated terminal records stay addressable by name
 * via `describe`/`logs`/`restart`.
 */
function orderDaemonsForListing(snapshots: DaemonSnapshot[]): DaemonSnapshot[] {
	const active: DaemonSnapshot[] = [];
	const terminal: DaemonSnapshot[] = [];
	for (const snapshot of snapshots) {
		(terminalState(snapshot.state) ? terminal : active).push(snapshot);
	}
	active.sort((left, right) => left.createdAt - right.createdAt);
	terminal.sort((left, right) => (right.exitedAt ?? right.createdAt) - (left.exitedAt ?? left.createdAt));
	return [...active, ...terminal.slice(0, MAX_TERMINAL_DAEMONS_LISTED)];
}

/**
 * Reap a recovered non-detached daemon snapshot in place. Already-terminal
 * records are left untouched so `list` keeps their real {@link DaemonSnapshot.exitedAt}
 * for recency ranking; records that were still alive when the previous broker
 * exited are marked `exited` at `now`, since their process died with that broker
 * (issue #6517). Returns whether the record was reaped.
 */
function reapRecoveredSnapshot(snapshot: DaemonSnapshot, now: number): boolean {
	if (terminalState(snapshot.state)) return false;
	snapshot.pid = undefined;
	snapshot.state = "exited";
	snapshot.exitedAt = now;
	snapshot.exitReason = "previous broker exited";
	return true;
}

/** Mirror per-condition readiness progress into the snapshot so clients can see which condition is unmet. */
function syncReadyPending(record: ManagedDaemon): void {
	if (record.snapshot.state !== "starting") {
		record.snapshot.readyPending = undefined;
		return;
	}
	const pending: ("log" | "port")[] = [];
	if (!record.logReady) pending.push("log");
	if (!record.portReady) pending.push("port");
	record.snapshot.readyPending = pending.length > 0 ? pending : undefined;
}

async function fileTextSlice(filePath: string, head: boolean): Promise<string> {
	try {
		const stat = await fs.stat(filePath);
		const file = Bun.file(filePath);
		if (stat.size <= LOG_READ_BYTES) return await file.text();
		return head
			? await file.slice(0, LOG_READ_BYTES).text()
			: await file.slice(Math.max(0, stat.size - LOG_READ_BYTES)).text();
	} catch (error) {
		if (isEnoent(error)) return "";
		throw error;
	}
}

class DaemonLog {
	readonly #path: string;
	readonly #previousPath: string;
	readonly #file: Bun.BunFile;
	#writer: Bun.FileSink;
	#currentBytes = 0;
	#queue: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(logPath: string, previousPath: string, file: Bun.BunFile, writer: Bun.FileSink) {
		this.#path = logPath;
		this.#previousPath = previousPath;
		this.#file = file;
		this.#writer = writer;
	}

	static async open(dir: string): Promise<DaemonLog> {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const logPath = path.join(dir, LOG_FILE);
		const previousPath = path.join(dir, PREVIOUS_LOG_FILE);
		await fs.rm(previousPath, { force: true });
		try {
			await fs.rename(logPath, previousPath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const file = Bun.file(logPath);
		return new DaemonLog(logPath, previousPath, file, file.writer());
	}

	append(text: string): string {
		if (text.length === 0 || this.#closed) return text;
		const bytes = Buffer.byteLength(text, "utf8");
		this.#queue = this.#queue.then(async () => {
			if (this.#currentBytes > 0 && this.#currentBytes + bytes > MAX_LOG_BYTES) await this.#rotate();
			this.#writer.write(text);
			this.#currentBytes += bytes;
			await this.#writer.flush();
		});
		return text;
	}

	read(head: boolean, lines: number, cursor: number, grep?: string): Promise<DaemonLogRead> {
		const snapshot = this.#queue.then(async () => {
			await this.#writer.flush();
			return DaemonLog.readFiles(this.#path, this.#previousPath, head, lines, cursor, grep);
		});
		// Appends that arrive after this call queue behind the file snapshot, so its
		// cursor can never include bytes that its terminal replay did not read. A read
		// failure still rejects the caller but must not poison the append queue.
		this.#queue = snapshot.then(
			() => undefined,
			() => undefined,
		);
		return snapshot;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#queue;
		await this.#writer.end();
	}

	static async readFiles(
		logPath: string,
		previousPath: string,
		head: boolean,
		lines: number,
		cursor: number,
		grep?: string,
	): Promise<DaemonLogRead> {
		const [previous, current] = await Promise.all([fileTextSlice(previousPath, head), fileTextSlice(logPath, head)]);
		const combined = `${previous}${previous && current && !previous.endsWith("\n") ? "\n" : ""}${current}`;
		const terminalOutput = head
			? truncateHeadBytes(combined, LOG_READ_BYTES).text
			: truncateTailBytes(combined, LOG_READ_BYTES).text;
		let text = sanitizeText(terminalOutput);
		if (grep) {
			let pattern: RegExp;
			try {
				pattern = new RegExp(grep, "u");
			} catch (error) {
				throw new Error(`Invalid log regex: ${error instanceof Error ? error.message : String(error)}`);
			}
			text = text
				.split("\n")
				.filter(line => pattern.test(line))
				.join("\n");
		}
		const options = { maxLines: lines, maxBytes: 256 * 1024 };
		return {
			text: head ? truncateHead(text, options).content : truncateTail(text, options).content,
			terminalOutput,
			cursor,
		};
	}

	async #rotate(): Promise<void> {
		await this.#writer.end();
		await fs.rm(this.#previousPath, { force: true });
		await fs.rename(this.#path, this.#previousPath);
		this.#writer = this.#file.writer();
		this.#currentBytes = 0;
	}
}

async function acquireBrokerLease(runtimeDir: string): Promise<BrokerLease | null> {
	const pidPath = path.join(runtimeDir, PID_FILE);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(pidPath, "wx", 0o600);
			const instanceId = crypto.randomUUID();
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, instanceId }), "utf8");
			} finally {
				await handle.close();
			}
			return { path: pidPath, instanceId };
		} catch (error) {
			if (!isEexist(error)) throw error;
			try {
				const raw: unknown = await Bun.file(pidPath).json();
				if (typeof raw === "object" && raw !== null && "pid" in raw && typeof raw.pid === "number") {
					try {
						process.kill(raw.pid, 0);
						return null;
					} catch {
						// Stale PID file; the next loop iteration claims it.
					}
				}
			} catch {
				// Malformed or partially-written PID files are stale.
			}
			await fs.rm(pidPath, { force: true });
		}
	}
	return null;
}

async function releaseBrokerLease(lease: BrokerLease): Promise<void> {
	try {
		const raw: unknown = await Bun.file(lease.path).json();
		if (typeof raw === "object" && raw !== null && "instanceId" in raw && raw.instanceId === lease.instanceId) {
			await fs.rm(lease.path, { force: true });
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function connectPort(host: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ host, port });
	let settled = false;
	const finish = (connected: boolean): void => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(connected);
	};
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	socket.setTimeout(250, () => finish(false));
	return promise;
}

class DaemonBroker {
	readonly #projectDir: string;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	readonly #token: string;
	readonly #idleGraceMs: number;
	readonly #restartBackoffBaseMs: number;
	readonly #records = new Map<string, ManagedDaemon>();
	/**
	 * Names reserved by an in-flight `start` before its record lands in
	 * `#records`. Requests dispatch concurrently, and `#start` awaits (cwd stat,
	 * log open) between the duplicate check and the record insert; without a
	 * synchronous reservation two clients can both pass the check and spawn
	 * duplicate processes — one exits on a held resource (e.g. a Chromium
	 * profile lock) or keeps running untracked.
	 */
	readonly #startingNames = new Set<string>();
	readonly #clients = new Set<net.Socket>();
	readonly #ownerSockets = new Map<string, { socket: net.Socket; subscriptionId: string | undefined }>();
	readonly #completionSubscriptions = new Map<string, string | undefined>();
	readonly #pendingCompletions = new Map<string, Map<string, DaemonCompletionNotification>>();
	readonly #finished = Promise.withResolvers<void>();
	readonly #sockets = new Set<net.Socket>();
	#server: net.Server | undefined;
	#idleTimer: NodeJS.Timeout | undefined;
	#shuttingDown = false;

	constructor(
		projectDir: string,
		runtimeDir: string,
		token: string,
		idleGraceMs: number,
		restartBackoffBaseMs: number,
	) {
		this.#projectDir = projectDir;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		this.#token = token;
		this.#idleGraceMs = idleGraceMs;
		this.#restartBackoffBaseMs = restartBackoffBaseMs;
	}

	async run(): Promise<void> {
		await this.#recoverRecords();
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(this.#endpoint);
		await listening;
		if (process.platform !== "win32") await fs.chmod(this.#endpoint, 0o600);
		this.#scheduleIdleShutdown();
		await this.#finished.promise;
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return this.#finished.promise;
		this.#shuttingDown = true;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		for (const record of this.#records.values()) {
			const detached = record.spec.detached && !record.stopRequested && record.snapshot.pid !== undefined;
			if (!detached && !terminalState(record.snapshot.state)) await this.#stopRecord(record, 2_000);
			clearTimeout(record.restartTimer);
			await record.log?.close();
			await record.persistQueue;
		}
		this.#ownerSockets.clear();
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		this.#clients.clear();
		if (this.#server) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#server.close(() => resolve());
			await promise;
		}
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		this.#finished.resolve();
	}

	#accept(socket: net.Socket): void {
		this.#sockets.add(socket);
		let authenticated = false;
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
				socket.destroy(new Error("Daemon broker request exceeds size limit"));
				return;
			}
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				void this.#handleLine(socket, line, () => {
					if (authenticated) return;
					authenticated = true;
					this.#clients.add(socket);
					clearTimeout(this.#idleTimer);
					this.#idleTimer = undefined;
				});
			}
		});
		socket.on("error", () => {
			// Socket closure performs client accounting.
		});
		socket.on("close", () => {
			this.#sockets.delete(socket);
			if (!authenticated) return;
			this.#clients.delete(socket);
			this.#scheduleIdleShutdown();
			for (const [owner, registration] of this.#ownerSockets) {
				if (registration.socket === socket) this.#ownerSockets.delete(owner);
			}
		});
	}

	async #handleLine(socket: net.Socket, line: string, onAuthenticated: () => void): Promise<void> {
		let id = "unknown";
		try {
			const decoded: unknown = JSON.parse(line);
			const request = parseDaemonWireRequest(decoded);
			id = request.id;
			if (request.token !== this.#token) throw new Error("Daemon broker authentication failed");
			onAuthenticated();
			for (const owner of request.completionUnsubscribes ?? []) {
				const subscriptionId = this.#completionSubscriptions.get(owner);
				if (
					!this.#completionSubscriptions.has(owner) ||
					(subscriptionId !== undefined && subscriptionId !== request.completionSubscriptionId)
				) {
					continue;
				}
				this.#ownerSockets.delete(owner);
				this.#completionSubscriptions.delete(owner);
				await this.#setRecordCompletionCapability(owner, false);
				this.#pendingCompletions.delete(owner);
			}
			for (const completionId of request.completionAcks ?? []) {
				for (const [owner, pending] of this.#pendingCompletions) {
					const registration = this.#ownerSockets.get(owner);
					if (
						!registration ||
						registration.socket !== socket ||
						registration.subscriptionId !== request.completionSubscriptionId
					) {
						continue;
					}
					const completion = pending.get(completionId);
					if (!completion) continue;
					pending.delete(completionId);
					if (pending.size === 0) this.#pendingCompletions.delete(owner);
					const record = this.#records.get(completion.daemon.name);
					const index = record?.pendingCompletions.findIndex(item => item.completionId === completionId) ?? -1;
					if (record && index >= 0) {
						record.pendingCompletions.splice(index, 1);
						this.#persist(record);
						await record.persistQueue;
					}
				}
			}
			if (publishesCompletionOwners(request)) {
				const replayOwners = new Set(request.completionReplays ?? []);
				const activeOwners = new Set(request.owners ?? []);
				const detachedOwners = new Set(request.detachedOwners ?? []);
				const advertisedOwners = new Set([...activeOwners, ...detachedOwners]);
				for (const [owner, subscriptionId] of this.#completionSubscriptions) {
					if (subscriptionId !== request.completionSubscriptionId || advertisedOwners.has(owner)) continue;
					this.#ownerSockets.delete(owner);
					this.#completionSubscriptions.delete(owner);
					await this.#setRecordCompletionCapability(owner, false);
					this.#pendingCompletions.delete(owner);
				}
				for (const owner of activeOwners) {
					this.#completionSubscriptions.set(owner, request.completionSubscriptionId);
					await this.#setRecordCompletionCapability(owner, true);
					const previous = this.#ownerSockets.get(owner);
					this.#ownerSockets.set(owner, {
						socket,
						subscriptionId: request.completionSubscriptionId,
					});
					if (previous?.socket === socket && !replayOwners.has(owner)) continue;
					for (const completion of this.#pendingCompletions.get(owner)?.values() ?? []) {
						socket.write(`${JSON.stringify(completion)}\n`);
					}
				}
				for (const owner of detachedOwners) {
					const subscriptionId = this.#completionSubscriptions.get(owner);
					if (this.#completionSubscriptions.has(owner) && subscriptionId !== request.completionSubscriptionId) {
						continue;
					}
					this.#completionSubscriptions.set(owner, request.completionSubscriptionId);
					await this.#setRecordCompletionCapability(owner, true);
					const registration = this.#ownerSockets.get(owner);
					if (registration?.subscriptionId === request.completionSubscriptionId) this.#ownerSockets.delete(owner);
				}
			}
			const result = await this.#dispatch(request.operation);
			socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
			if (request.operation.op === "shutdown") setTimeout(() => void this.shutdown(), 10);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			socket.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
		}
	}

	async #dispatch(operation: DaemonOperation): Promise<DaemonRpcResult> {
		switch (operation.op) {
			case "ping":
				return { op: "ping", projectDir: this.#projectDir };
			case "start":
				return this.#start(operation.spec, operation.owner);
			case "list": {
				await Promise.all([...this.#records.values()].map(record => this.#refreshDetached(record)));
				return {
					op: "list",
					daemons: orderDaemonsForListing([...this.#records.values()].map(record => record.snapshot)),
				};
			}
			case "logs":
				return this.#logs(operation);
			case "wait":
				return this.#wait(operation);
			case "send":
				return this.#send(operation);
			case "stop": {
				const record = this.#record(operation.name);
				await this.#stopRecord(record, operation.timeoutMs);
				return { op: "stop", daemon: record.snapshot };
			}
			case "restart":
				return this.#restart(operation.name);
			case "describe": {
				const record = this.#record(operation.name);
				await this.#refreshDetached(record);
				return { op: "describe", daemon: record.snapshot, spec: record.spec };
			}
			case "shutdown":
				return { op: "shutdown" };
		}
	}

	async #start(spec: DaemonSpec, owner?: string): Promise<DaemonRpcResult> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(spec.name)) {
			throw new Error("Daemon name must be 1-48 letters, numbers, dots, underscores, or hyphens");
		}
		if (spec.detached && spec.pty) {
			throw new Error("A detached daemon cannot allocate a PTY");
		}
		if (
			spec.pty &&
			process.platform === "win32" &&
			[".bat", ".cmd"].includes(path.extname(spec.application).toLowerCase())
		) {
			throw new Error('Windows batch files require application "cmd.exe" with the batch path after "/c"');
		}
		if (this.#startingNames.has(spec.name)) {
			throw new Error(`Daemon ${spec.name} is already starting`);
		}
		this.#startingNames.add(spec.name);
		let record: ManagedDaemon;
		try {
			const existing = this.#records.get(spec.name);
			if (existing) await this.#refreshDetached(existing);
			if (existing && !terminalState(existing.snapshot.state)) {
				throw new Error(`Daemon ${spec.name} is already ${existing.snapshot.state}`);
			}
			if (existing && existing.pendingCompletions.length > 0) {
				throw new Error(`Daemon ${spec.name} has unacknowledged completion notifications`);
			}
			if (spec.ready?.log) {
				try {
					new RegExp(spec.ready.log, "u");
				} catch (error) {
					throw new Error(`Invalid readiness regex: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const stat = await fs.stat(spec.cwd);
			if (!stat.isDirectory()) throw new Error(`Daemon cwd is not a directory: ${spec.cwd}`);
			const dir = path.join(this.#runtimeDir, "daemons", spec.name);
			const now = Date.now();
			record = {
				spec,
				snapshot: {
					name: spec.name,
					id: crypto.randomUUID(),
					state: "starting",
					createdAt: now,
					startedAt: now,
					restartCount: 0,
					outputBytes: 0,
					owner,
					persist: spec.persist,
					detached: spec.detached,
				},
				dir,
				log: await DaemonLog.open(dir),
				generation: 0,
				stopRequested: false,
				logReady: !spec.ready?.log,
				portReady: spec.ready?.port === undefined,
				readinessBuffer: "",
				outputOffset: 0,
				readyPattern: spec.ready?.log ? new RegExp(spec.ready.log, "u") : undefined,
				consecutiveFailures: 0,
				persistQueue: Promise.resolve(),
				completionCapable: owner !== undefined && this.#completionSubscriptions.has(owner),
				completionSubscriptionId: owner === undefined ? undefined : this.#completionSubscriptions.get(owner),
				pendingCompletions: [],
			};
			syncReadyPending(record);
			this.#records.set(spec.name, record);
		} finally {
			this.#startingNames.delete(spec.name);
		}
		await this.#launch(record);
		let readyTimedOut = false;
		if (spec.ready && !terminalState(record.snapshot.state)) {
			// Wake on the sticky readyAt marker or any terminal state, not the live
			// state: a fast process flips starting→ready→exited within one poll
			// interval, so sampling `state === "ready"` never observes readiness even
			// though #markReady durably recorded readyAt. A pre-ready exit must also
			// wake the wait rather than block for the full timeout.
			const ready = await this.#waitUntil(
				record,
				() => record.snapshot.readyAt !== undefined || terminalState(record.snapshot.state),
				spec.ready.timeoutMs,
			);
			readyTimedOut = !ready;
		}
		await record.persistQueue;
		return { op: "start", daemon: record.snapshot, readyTimedOut };
	}

	async #launch(record: ManagedDaemon): Promise<void> {
		record.generation++;
		const generation = record.generation;
		record.stopRequested = false;
		record.processRef = undefined;
		record.identity = undefined;
		record.residue = undefined;
		record.snapshot.state = record.spec.ready ? "starting" : "running";
		record.snapshot.startedAt = Date.now();
		record.snapshot.readyAt = undefined;
		record.snapshot.exitedAt = undefined;
		record.snapshot.exitCode = undefined;
		record.snapshot.exitReason = undefined;
		record.snapshot.pid = undefined;
		record.snapshot.readyMatch = undefined;
		record.logReady = !record.spec.ready?.log;
		record.portReady = record.spec.ready?.port === undefined;
		syncReadyPending(record);
		record.readinessBuffer = "";
		record.outputOffset = 0;
		this.#persist(record);
		try {
			if (record.spec.detached) await this.#launchDetached(record, generation);
			else if (record.spec.pty) await this.#launchPty(record, generation);
			else this.#launchPipe(record, generation);
			if (record.spec.ready?.port !== undefined) void this.#pollPort(record, generation, record.spec.ready);
			this.#markReady(record);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			record.log?.append(`Daemon launch failed: ${message}\n`);
			await this.#settle(record, generation, undefined, message);
		}
	}

	async #launchPty(record: ManagedDaemon, generation: number): Promise<void> {
		const session = new PtySession();
		record.pty = session;
		const options = {
			cwd: record.spec.cwd,
			env: workerEnvFromParent({ TERM: "xterm-256color", ...record.spec.env }),
			cols: DAEMON_PTY_COLUMNS,
			rows: DAEMON_PTY_ROWS,
		};
		// Nothing plays terminal for a supervised PTY, so a program probing for
		// cursor position or device attributes would block on the reply. Answer
		// the queries from the output stream and write the replies to its stdin.
		const responder = new TerminalQueryResponder();
		const onChunk = (error: Error | null, chunk: string): void => {
			if (generation !== record.generation) return;
			if (error) record.log?.append(`PTY output error: ${error.message}\n`);
			if (!chunk) return;
			const reply = responder.feed(chunk);
			if (reply) {
				try {
					session.write(reply);
				} catch {
					// The PTY may exit between emitting its final output and receiving the reply.
				}
			}
			this.#onOutput(record, generation, chunk);
		};
		const started = Promise.withResolvers<number | undefined>();
		const onStart = (error: Error | null, pid: number): void => {
			if (error) {
				record.log?.append(`PTY startup callback failed: ${error.message}\n`);
				started.resolve(undefined);
				return;
			}
			const startedPid = Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
			// Pin from inside the session's own run: it does not reap the child until
			// that run resolves, so the number still denotes this child here.
			if (startedPid !== undefined && generation === record.generation) {
				this.#pin(record, startedPid);
			}
			started.resolve(startedPid);
		};
		let run: Promise<PtyRunResult>;
		if (process.platform === "win32") {
			run = session.startArgv(
				{
					application: record.spec.application,
					args: record.spec.args,
					...options,
				},
				onChunk,
				onStart,
			);
		} else {
			const argv = [record.spec.application, ...record.spec.args];
			const command = `exec ${argv.map(quoteShellArg).join(" ")}`;
			const shell = procmgr.getShellConfig().shell;
			run = session.start({ command, shell, ...options }, onChunk, onStart);
		}
		void run.then(
			async result => {
				await this.#onPtyExit(record, generation, result);
				started.resolve(undefined);
			},
			async error => {
				await this.#settle(record, generation, undefined, error instanceof Error ? error.message : String(error));
				started.resolve(undefined);
			},
		);

		const pid = await started.promise;
		if (pid !== undefined && generation === record.generation) this.#persist(record);
	}

	#launchPipe(record: ManagedDaemon, generation: number): void {
		const child = Bun.spawn([record.spec.application, ...record.spec.args], {
			cwd: record.spec.cwd,
			env: workerEnvFromParent(record.spec.env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			...DAEMON_SPAWN_OPTIONS,
		});
		record.process = child;
		record.input = child.stdin;
		this.#pin(record, child.pid);
		this.#persist(record);
		const readers = [child.stdout, child.stderr].map(stream => (stream as ReadableStream<Uint8Array>).getReader());
		// Fold the drains into a value the moment they are created. Their result is
		// not consumed until the child exits, and an unhandled reader rejection in
		// that window would escape as a process-level unhandled rejection.
		const drained = Promise.all(readers.map(reader => this.#drain(record, generation, reader))).then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		void this.#settlePipe(record, generation, child, readers, drained).catch(error =>
			this.#settle(record, generation, undefined, error instanceof Error ? error.message : String(error)),
		);
	}

	/**
	 * Settle a pipe daemon on the child's own exit rather than on end-of-output:
	 * stdout stays open while *any* process holds the write end, so a grandchild
	 * that inherited it keeps the drains pending indefinitely and the record
	 * never reaches a terminal state. The drains get a bounded window afterwards
	 * to flush what is already buffered, then are released.
	 */
	async #settlePipe(
		record: ManagedDaemon,
		generation: number,
		child: ManagedProcess,
		readers: ReadableStreamDefaultReader<Uint8Array>[],
		drained: Promise<Error | undefined>,
	): Promise<void> {
		const exitCode = await child.exited;
		// An explicit timer, not `Bun.sleep`: the loser of this race must not keep a
		// two-second timer alive in the broker after every exit.
		const expired = Promise.withResolvers<null>();
		const timer = setTimeout(() => expired.resolve(null), PIPE_FLUSH_GRACE_MS);
		let outcome: { error: Error | undefined } | null;
		try {
			outcome = await Promise.race([drained.then(error => ({ error })), expired.promise]);
		} finally {
			clearTimeout(timer);
		}
		// The waits above can outlive this generation; only the current one may
		// describe the record.
		if (generation === record.generation) {
			if (outcome?.error) {
				// The exit code stays authoritative — a broken read end is our defect,
				// not the daemon's outcome — but the loss of output is reported.
				record.residue = `output capture failed: ${outcome.error.message}`;
				logger.warn("Daemon output capture failed", {
					name: record.snapshot.name,
					error: outcome.error.message,
				});
			} else if (outcome === null) {
				// Held output means those descendants are still running.
				record.residue = "exited, but descendants still hold its output and are still running";
				record.log?.append("\n[daemon exited; output still held by surviving descendants]\n");
				logger.warn("Daemon exited with output still held by surviving descendants", {
					name: record.snapshot.name,
				});
			}
		}
		// Only a clean finish proves every read end was released: `Promise.all`
		// rejects on the first failure, leaving the sibling drain still holding its
		// reader. Cancelling an already-released reader rejects harmlessly.
		if (outcome?.error !== undefined || outcome === null) {
			await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
		}
		await this.#settle(record, generation, exitCode);
	}

	async #launchDetached(record: ManagedDaemon, generation: number): Promise<void> {
		const logPath = path.join(record.dir, LOG_FILE);
		const output = await fs.open(logPath, "a", 0o600);
		try {
			const process = Bun.spawn([record.spec.application, ...record.spec.args], {
				cwd: record.spec.cwd,
				env: workerEnvFromParent(record.spec.env),
				stdio: ["ignore", output.fd, output.fd],
				...DAEMON_SPAWN_OPTIONS,
			});
			record.process = process;
			this.#pin(record, process.pid);
			this.#persist(record);
			process.unref();
			void process.exited
				.then(exitCode => this.#settle(record, generation, exitCode))
				.catch(error =>
					this.#settle(record, generation, undefined, error instanceof Error ? error.message : String(error)),
				);
		} finally {
			await output.close();
		}
	}

	async #drain(
		record: ManagedDaemon,
		generation: number,
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (generation === record.generation)
					this.#onOutput(record, generation, decoder.decode(value, { stream: true }));
			}
			const tail = decoder.decode();
			if (tail && generation === record.generation) this.#onOutput(record, generation, tail);
		} finally {
			reader.releaseLock();
		}
	}

	#onOutput(record: ManagedDaemon, generation: number, raw: string): void {
		if (generation !== record.generation) return;
		const output = raw.toWellFormed();
		const text = record.log?.append(output) ?? output;
		record.snapshot.outputBytes += Buffer.byteLength(text, "utf8");
		this.#trackOutput(record, generation, sanitizeText(text));
	}

	async #readDetachedOutput(record: ManagedDaemon, generation: number): Promise<void> {
		if (!record.spec.detached || generation !== record.generation) return;
		const logPath = path.join(record.dir, LOG_FILE);
		let size: number;
		try {
			size = (await fs.stat(logPath)).size;
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		if (size < record.outputOffset) record.outputOffset = 0;
		if (size === record.outputOffset) return;
		const file = Bun.file(logPath);
		const raw = await file.slice(record.outputOffset, size).text();
		if (generation !== record.generation) return;
		record.outputOffset = size;
		record.snapshot.outputBytes = size;
		this.#trackOutput(record, generation, sanitizeText(raw));
	}

	#trackOutput(record: ManagedDaemon, generation: number, text: string): void {
		if (generation !== record.generation) return;
		record.readinessBuffer = (record.readinessBuffer + text).slice(-READINESS_BUFFER_CHARS);
		if (!record.logReady && record.readyPattern) {
			const match = record.readyPattern.exec(record.readinessBuffer);
			if (match) {
				record.logReady = true;
				record.snapshot.readyMatch = match[0].slice(0, 500);
				syncReadyPending(record);
			}
		}
		this.#markReady(record);
	}

	async #refreshDetached(record: ManagedDaemon): Promise<void> {
		if (!record.spec.detached || settledState(record.snapshot.state)) return;
		const generation = record.generation;
		await this.#readDetachedOutput(record, generation);
		if (generation !== record.generation || record.process) return;
		// A detached record that survives recovery is pinned; an unverified one was
		// already reaped. So the pinned reference is the whole liveness question.
		if (this.#processRef(record)?.status() === "running") return;
		await this.#settle(record, generation);
	}

	async #monitorRecoveredDetached(record: ManagedDaemon, generation: number): Promise<void> {
		while (!this.#shuttingDown && generation === record.generation && !settledState(record.snapshot.state)) {
			await Bun.sleep(100);
			if (this.#shuttingDown || generation !== record.generation) return;
			await this.#refreshDetached(record);
		}
	}

	async #pollPort(record: ManagedDaemon, generation: number, ready: DaemonReadySpec): Promise<void> {
		const host = ready.host ?? "127.0.0.1";
		const port = ready.port;
		if (port === undefined) return;
		while (generation === record.generation && !terminalState(record.snapshot.state)) {
			if (await connectPort(host, port)) {
				record.portReady = true;
				syncReadyPending(record);
				this.#markReady(record);
				return;
			}
			await Bun.sleep(100);
		}
	}

	#markReady(record: ManagedDaemon): void {
		if (!record.spec.ready || record.snapshot.state !== "starting") return;
		if (!record.logReady || !record.portReady) return;
		record.snapshot.state = "ready";
		record.snapshot.readyAt = Date.now();
		this.#persist(record);
	}

	async #onPtyExit(record: ManagedDaemon, generation: number, result: PtyRunResult): Promise<void> {
		return this.#settle(record, generation, result.exitCode, result.timedOut ? "timed out" : undefined);
	}

	#notifyCompletion(completion: DaemonCompletionNotification): void {
		const pending = this.#pendingCompletions.get(completion.owner) ?? new Map<string, DaemonCompletionNotification>();
		pending.set(completion.completionId, completion);
		this.#pendingCompletions.set(completion.owner, pending);
		const registration = this.#ownerSockets.get(completion.owner);
		if (!registration || registration.socket.destroyed) return;
		registration.socket.write(`${JSON.stringify(completion)}\n`);
	}

	async #settle(record: ManagedDaemon, generation: number, exitCode?: number, error?: string): Promise<void> {
		// `restarting` is a settled state (child exited, relaunch timer armed). Any op that
		// runs #refreshDetached on such a record must not re-settle it: re-entry double-counts
		// restartCount and overwrites record.restartTimer, orphaning the armed timer so it fires
		// after stop() and resurrects the daemon (issue #6852).
		if (generation !== record.generation || settledState(record.snapshot.state)) return;
		await this.#readDetachedOutput(record, generation);
		// The output read yields, so a concurrent refresh may settle this generation first.
		if (generation !== record.generation || settledState(record.snapshot.state)) return;
		record.process = undefined;
		record.processRef = undefined;
		record.identity = undefined;
		record.input = undefined;
		record.pty = undefined;
		record.snapshot.pid = undefined;
		record.snapshot.exitedAt = Date.now();
		record.snapshot.exitCode = exitCode;
		// A launch error outranks the note, but a stop that left survivors behind
		// must still reach the caller when settlement lands after the stop returned.
		record.snapshot.exitReason = error ?? record.residue;
		record.snapshot.readyPending = undefined;
		const failed = error !== undefined || (exitCode !== undefined && exitCode !== 0);
		const shouldRestart =
			!record.stopRequested &&
			(record.spec.restart === "always" || (record.spec.restart === "on-failure" && failed));
		if (shouldRestart && !this.#shuttingDown) {
			const uptime = Date.now() - record.snapshot.startedAt;
			record.consecutiveFailures = uptime >= 30_000 ? 0 : record.consecutiveFailures + 1;
			record.snapshot.restartCount++;
			// Readiness belongs to the exited generation; clear it before the backoff
			// so start / for:"ready" waits don't treat a dead service as ready during
			// the restart window (readyAt is re-set by #launch once the child is up).
			record.snapshot.readyAt = undefined;
			record.snapshot.readyMatch = undefined;
			record.snapshot.state = "restarting";
			const delay = Math.min(
				this.#restartBackoffBaseMs * 2 ** Math.min(record.consecutiveFailures, 5),
				RESTART_MAX_DELAY_MS,
			);
			record.log?.append(
				`\n[daemon exited${exitCode === undefined ? "" : ` with code ${exitCode}`}; restarting in ${delay}ms]\n`,
			);
			this.#persist(record);
			record.restartTimer = setTimeout(() => {
				record.restartTimer = undefined;
				void this.#launch(record);
			}, delay);
			return;
		}
		record.snapshot.state = failed && !record.stopRequested ? "failed" : "exited";
		const completion =
			record.snapshot.owner !== undefined &&
			!record.stopRequested &&
			this.#completionSubscriptions.has(record.snapshot.owner)
				? ({
						event: "daemon-completed",
						completionId: crypto.randomUUID(),
						owner: record.snapshot.owner,
						daemon: { ...record.snapshot },
					} satisfies DaemonCompletionNotification)
				: undefined;
		if (completion) record.pendingCompletions.push(completion);
		this.#persist(record);
		await record.log?.close();
		record.log = undefined;
		await record.persistQueue;
		if (
			completion &&
			this.#completionSubscriptions.has(completion.owner) &&
			record.pendingCompletions.some(pending => pending.completionId === completion.completionId)
		) {
			this.#notifyCompletion(completion);
		}
		// Terminal settlement can free the last live persistent daemon. The idle
		// timer that fired while that daemon was alive returned without rearming
		// (see #scheduleIdleShutdown), so rearm here or the broker, its endpoint,
		// timers, and record maps stay alive forever after the daemon exits. The
		// timer re-checks clients, remaining live persistent records, and detached
		// project presence before it shuts anything down.
		this.#scheduleIdleShutdown();
	}

	async #logs(operation: Extract<DaemonOperation, { op: "logs" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		await this.#refreshDetached(record);
		const cursor = operation.cursor ?? record.snapshot.outputBytes;
		let timedOut = false;
		if (operation.follow && record.snapshot.outputBytes <= cursor && !terminalState(record.snapshot.state)) {
			const changed = await this.#waitUntil(
				record,
				() => record.snapshot.outputBytes > cursor || terminalState(record.snapshot.state),
				operation.timeoutMs,
			);
			timedOut = !changed;
		}
		const lines = Math.max(1, Math.min(1_000, Math.floor(operation.lines)));
		const output = record.log
			? await record.log.read(operation.head, lines, record.snapshot.outputBytes, operation.grep)
			: await DaemonLog.readFiles(
					path.join(record.dir, LOG_FILE),
					path.join(record.dir, PREVIOUS_LOG_FILE),
					operation.head,
					lines,
					record.snapshot.outputBytes,
					operation.grep,
				);
		const terminalOutput = record.spec.pty && operation.grep === undefined ? output.terminalOutput : undefined;
		const terminalRows =
			terminalOutput !== undefined && operation.renderTerminalRows === true
				? await renderTerminalOutput(terminalOutput, { head: operation.head, maxRows: lines })
				: undefined;
		return {
			op: "logs",
			name: record.snapshot.name,
			text: output.text,
			terminalRows,
			terminalText:
				terminalOutput !== undefined && (operation.renderTerminalRows !== true || terminalRows === undefined)
					? terminalOutput
					: undefined,
			cursor: output.cursor,
			timedOut,
			state: record.snapshot.state,
		};
	}

	async #wait(operation: Extract<DaemonOperation, { op: "wait" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		// A wait observes exactly one launch generation. Automatic or explicit
		// relaunches reuse the managed record, so polling the record without this
		// binding can hang past an exit or consume the replacement's output.
		const boundGeneration = record.generation;
		await this.#refreshDetached(record);
		let matched: string | undefined;
		let pattern: RegExp | undefined;
		if (operation.pattern) {
			try {
				pattern = new RegExp(operation.pattern, "u");
			} catch (error) {
				throw new Error(`Invalid wait regex: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// Readiness was actually observed: the sticky readyAt survives a fast
		// ready→exit, a live "ready" state, or a "running" daemon with no ready spec.
		const readyObserved = (): boolean =>
			record.snapshot.readyAt !== undefined ||
			record.snapshot.state === "ready" ||
			(record.snapshot.state === "running" && !record.spec.ready);
		const generationEnded = (): boolean =>
			record.generation !== boundGeneration || record.snapshot.state === "restarting";
		const condition = (): boolean => {
			if (generationEnded()) return true;
			if (pattern) {
				const match = pattern.exec(record.readinessBuffer);
				if (!match) return false;
				matched = match[0].slice(0, 500);
				return true;
			}
			if (operation.for === "exit") return terminalState(record.snapshot.state);
			// Wake on observed readiness or any terminal state so the wait never
			// blocks for the full timeout; success is judged by readyObserved below.
			return readyObserved() || terminalState(record.snapshot.state);
		};
		const woke = condition() || (await this.#waitUntil(record, condition, operation.timeoutMs));
		if (generationEnded()) {
			const exit = record.snapshot.exitCode === undefined ? "" : ` with exit code ${record.snapshot.exitCode}`;
			throw new Error(
				`Daemon ${operation.name} generation ${boundGeneration} exited${exit}; ` +
					"the wait was rejected instead of continuing against a replacement generation",
			);
		}
		// A for:"ready" wait that woke on a terminal exit without ever observing
		// readiness is still "not ready" — surface it as timed out so callers and the
		// renderer don't chain work against a dead process.
		const timedOut = operation.for === "ready" && !pattern ? !readyObserved() : !woke;
		return { op: "wait", daemon: record.snapshot, matched, timedOut };
	}

	async #send(operation: Extract<DaemonOperation, { op: "send" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		await this.#refreshDetached(record);
		if (terminalState(record.snapshot.state) || record.snapshot.state === "stopping") {
			throw new Error(`Daemon ${operation.name} is ${record.snapshot.state}`);
		}
		if (operation.data === undefined && operation.signal === undefined) {
			throw new Error("send requires data or signal");
		}
		if (operation.data !== undefined) {
			if (record.pty) record.pty.write(operation.data);
			else if (record.input) {
				record.input.write(operation.data);
				await record.input.flush();
			} else throw new Error(`Daemon ${operation.name} stdin is unavailable`);
		}
		if (operation.signal) {
			if (process.platform === "win32" && record.pty) {
				if (operation.signal === "SIGINT") record.pty.write("\u0003");
				else record.pty.kill();
			} else {
				const processRef = this.#processRef(record);
				if (processRef) processRef.killTree(SIGNAL_NUMBER[operation.signal]);
				else if (record.process) this.#signalHandle(record, SIGNAL_NUMBER[operation.signal]);
				else throw new Error(`Daemon ${operation.name} process is unavailable`);
			}
		}
		return { op: "send", daemon: record.snapshot };
	}

	async #stopRecord(record: ManagedDaemon, timeoutMs: number): Promise<void> {
		await this.#refreshDetached(record);
		if (terminalState(record.snapshot.state)) return;
		record.stopRequested = true;
		if (record.restartTimer) {
			clearTimeout(record.restartTimer);
			record.restartTimer = undefined;
			record.snapshot.state = "exited";
			record.snapshot.exitedAt = Date.now();
			this.#persist(record);
			await record.log?.close();
			record.log = undefined;
			return;
		}
		record.snapshot.state = "stopping";
		this.#persist(record);
		const processRef = this.#processRef(record);
		if (processRef) {
			// Note a shortfall before the wait below: the settlement that publishes
			// it can land during that wait.
			const treeExited = await processRef.terminate({
				group: true,
				gracefulMs: timeoutMs,
				timeoutMs: timeoutMs + 1_000,
			});
			if (!treeExited) {
				record.residue = "descendants were still running after the termination waves";
				logger.warn("Daemon stop left descendants running", { name: record.snapshot.name });
			}
		} else {
			// Unauthorized pid: only handles we own may be signalled, and the
			// narrower stop is recorded rather than presented as a completed one.
			record.pty?.kill();
			this.#signalHandle(record, SIGNAL_NUMBER.SIGTERM);
			record.residue =
				record.process || record.pty
					? "signalled the supervised child directly; its descendants could not be enumerated"
					: "no verified reference to the recorded process; nothing was signalled";
			logger.warn("Daemon stop had no authorized process-tree reference", {
				name: record.snapshot.name,
			});
		}
		const settled = await this.#waitUntil(record, () => terminalState(record.snapshot.state), timeoutMs + 1_000);
		if (!settled) {
			record.pty?.kill();
			this.#signalHandle(record, SIGNAL_NUMBER.SIGKILL);
		}
		// Settlement already publishes the note; a record still in `stopping` has to
		// carry it on the snapshot the stop response returns.
		if (record.residue !== undefined && record.snapshot.exitReason === undefined) {
			record.snapshot.exitReason = record.residue;
			this.#persist(record);
		}
	}

	/**
	 * Record `pid` and pin what may be signalled for it.
	 *
	 * A pid is not identity — reopened later it names whoever holds the number
	 * now — so signal authority comes only from a reference opened while the
	 * process was known to be ours, together with the native identity that lets a
	 * later broker revalidate the same number.
	 */
	#pin(record: ManagedDaemon, pid: number): void {
		record.snapshot.pid = pid;
		record.processRef = Process.fromPid(pid) ?? undefined;
		record.identity = record.processRef?.identity() ?? undefined;
	}

	/** The reference a signal may be aimed at; see {@link DaemonBroker.pin}. */
	#processRef(record: ManagedDaemon): Process | null {
		return record.processRef ?? null;
	}

	/**
	 * Signal the direct child through the retained spawn handle. The handle
	 * stays valid until the child is reaped, so unlike a pid lookup it can never
	 * resolve to a stranger and never silently disappears.
	 */
	#signalHandle(record: ManagedDaemon, signal: number): void {
		try {
			record.process?.kill(signal);
		} catch (error) {
			logger.debug("Daemon handle signal failed", {
				name: record.snapshot.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #restart(name: string): Promise<DaemonRpcResult> {
		const record = this.#record(name);
		await this.#stopRecord(record, 2_000);
		await record.log?.close();
		record.log = await DaemonLog.open(record.dir);
		record.stopRequested = false;
		await this.#launch(record);
		await record.persistQueue;
		return { op: "restart", daemon: record.snapshot };
	}

	async #waitUntil(record: ManagedDaemon, condition: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (Date.now() < deadline) {
			await this.#refreshDetached(record);
			if (condition()) return true;
			if (this.#shuttingDown && terminalState(record.snapshot.state)) return condition();
			await Bun.sleep(50);
		}
		await this.#refreshDetached(record);
		return condition();
	}

	#record(name: string): ManagedDaemon {
		const record = this.#records.get(name);
		if (record) return record;
		const names = [...this.#records.keys()];
		throw new Error(`Unknown daemon ${name}${names.length ? `. Available: ${names.join(", ")}` : ""}`);
	}

	#persist(record: ManagedDaemon): void {
		const metaPath = path.join(record.dir, META_FILE);
		const tempPath = `${metaPath}.${process.pid}.tmp`;
		const metadata = {
			daemon: { ...record.snapshot },
			spec: record.spec,
			identity: record.identity,
			completionEvents: record.completionCapable,
			completionSubscriptionId: record.completionSubscriptionId,
			completionPending: record.pendingCompletions.length > 0,
			pendingCompletion: record.pendingCompletions.at(-1)?.daemon,
			pendingCompletions: record.pendingCompletions.map(completion => ({
				...completion,
				daemon: { ...completion.daemon },
			})),
		};
		record.persistQueue = record.persistQueue
			.then(async () => {
				await Bun.write(tempPath, JSON.stringify(metadata));
				await fs.rename(tempPath, metaPath);
			})
			.catch(error => {
				logger.warn("Failed to persist daemon metadata", {
					name: record.snapshot.name,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	async #setRecordCompletionCapability(owner: string, capable: boolean): Promise<void> {
		const subscriptionId = capable ? this.#completionSubscriptions.get(owner) : undefined;
		const persistence: Promise<void>[] = [];
		for (const record of this.#records.values()) {
			const clearPendingCompletions = !capable && record.pendingCompletions.length > 0;
			if (
				record.snapshot.owner !== owner ||
				(record.completionCapable === capable &&
					record.completionSubscriptionId === subscriptionId &&
					!clearPendingCompletions)
			) {
				continue;
			}
			record.completionCapable = capable;
			record.completionSubscriptionId = subscriptionId;
			if (!capable) record.pendingCompletions = [];
			this.#persist(record);
			persistence.push(record.persistQueue);
		}
		await Promise.all(persistence);
	}

	async #recoverRecords(): Promise<void> {
		const root = path.join(this.#runtimeDir, "daemons");
		const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
			if (isEnoent(error)) return [];
			throw error;
		});
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			try {
				const decoded: unknown = await Bun.file(path.join(dir, META_FILE)).json();
				if (typeof decoded !== "object" || decoded === null || !("daemon" in decoded) || !("spec" in decoded)) {
					continue;
				}
				const snapshot = parseDaemonSnapshot(decoded.daemon);
				const spec = parseDaemonSpec(decoded.spec);
				const identity =
					"identity" in decoded && typeof decoded.identity === "string" ? decoded.identity : undefined;
				const processRef = snapshot.pid === undefined ? null : Process.fromPid(snapshot.pid);
				const alive = processRef?.status() === "running";
				// The recorded pid is only this daemon again if the process behind it
				// still reports the identity we pinned when we spawned it. Records
				// written before identities were persisted have nothing to compare and
				// stay unverified.
				const verified = alive && identity !== undefined && processRef?.identity() === identity;
				const recoverableExit = !terminalState(snapshot.state) && snapshot.state !== "stopping";
				const detached = spec.detached && recoverableExit && verified;
				const recoveredDead = recoverableExit && !detached;
				if (!detached) {
					// Reap only records that were still alive when the previous broker
					// exited; already-terminal records keep their real exit time so
					// `list` ranks exited history by true recency (issue #6517).
					//
					// A verified process is provably the daemon this record spawned, so a
					// non-detached one is torn down with it. An unverified pid is never
					// signalled — whatever holds that number now, this broker cannot show
					// it is the daemon — and is reported instead, where `omp ps` sees it.
					if (!terminalState(snapshot.state) && verified && processRef) {
						await processRef.terminate({ group: true, gracefulMs: 500, timeoutMs: 2_000 });
					}
					const reaped = reapRecoveredSnapshot(snapshot, Date.now());
					if (reaped && alive && !verified) {
						snapshot.exitReason =
							"previous broker exited; a process still holds the recorded pid and was left running because its identity could not be verified";
					}
				} else if (snapshot.state === "restarting") {
					snapshot.state = spec.ready ? "starting" : "running";
				}
				snapshot.persist = spec.persist;
				snapshot.detached = spec.detached;
				const record: ManagedDaemon = {
					spec,
					snapshot,
					dir,
					// Signal authority is restored only for a revalidated process.
					processRef: detached && processRef !== null ? processRef : undefined,
					identity: detached ? identity : undefined,
					generation: 0,
					stopRequested: !detached || snapshot.state === "stopping",
					logReady: detached && (!spec.ready?.log || snapshot.state === "ready"),
					portReady: detached && (spec.ready?.port === undefined || snapshot.state === "ready"),
					readinessBuffer: "",
					outputOffset: detached ? snapshot.outputBytes : 0,
					readyPattern: spec.ready?.log ? new RegExp(spec.ready.log, "u") : undefined,
					consecutiveFailures: 0,
					persistQueue: Promise.resolve(),
					completionCapable: "completionEvents" in decoded && decoded.completionEvents === true,
					completionSubscriptionId:
						"completionSubscriptionId" in decoded && typeof decoded.completionSubscriptionId === "string"
							? decoded.completionSubscriptionId
							: undefined,
					pendingCompletions: (() => {
						if ("pendingCompletions" in decoded && Array.isArray(decoded.pendingCompletions)) {
							return decoded.pendingCompletions.map(value => {
								const message = parseDaemonWireMessage(value);
								if (!("event" in message)) throw new Error("Pending daemon completion is not an event");
								return message;
							});
						}
						const pendingSnapshot =
							"pendingCompletion" in decoded
								? parseDaemonSnapshot(decoded.pendingCompletion)
								: "completionPending" in decoded && decoded.completionPending === true
									? { ...snapshot }
									: undefined;
						return pendingSnapshot
							? [
									{
										event: "daemon-completed",
										completionId: crypto.randomUUID(),
										owner: pendingSnapshot.owner ?? snapshot.owner ?? "",
										daemon: pendingSnapshot,
									},
								]
							: [];
					})(),
				};
				if (recoveredDead && record.completionCapable && snapshot.owner && record.pendingCompletions.length === 0) {
					record.pendingCompletions.push({
						event: "daemon-completed",
						completionId: crypto.randomUUID(),
						owner: snapshot.owner,
						daemon: { ...snapshot },
					});
				}
				syncReadyPending(record);
				this.#records.set(snapshot.name, record);
				if (snapshot.owner && record.completionCapable && (detached || record.pendingCompletions.length > 0)) {
					this.#completionSubscriptions.set(snapshot.owner, record.completionSubscriptionId);
				}
				if (record.completionCapable) {
					for (const completion of record.pendingCompletions) this.#notifyCompletion(completion);
				}
				if (detached && spec.ready?.port !== undefined && snapshot.state !== "ready") {
					void this.#pollPort(record, record.generation, spec.ready);
				}
				if (detached) {
					void this.#monitorRecoveredDetached(record, record.generation).catch(error => {
						logger.warn("Failed to monitor recovered detached daemon", {
							name: record.snapshot.name,
							error: error instanceof Error ? error.message : String(error),
						});
					});
				}
				this.#persist(record);
			} catch (error) {
				logger.warn("Failed to recover daemon record", {
					name: entry.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	#scheduleIdleShutdown(): void {
		if (this.#shuttingDown || this.#clients.size > 0) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			void (async () => {
				const livePersistent = [...this.#records.values()].some(
					record => record.spec.persist && !terminalState(record.snapshot.state),
				);
				if (this.#clients.size > 0 || livePersistent) return;
				if (await hasLiveDaemonProjectPresence(this.#runtimeDir)) {
					this.#scheduleIdleShutdown();
					return;
				}
				if (this.#clients.size === 0) await this.shutdown();
			})();
		}, this.#idleGraceMs);
	}
}

export interface DaemonBrokerStartOptions {
	/** Base of the exponential child-restart backoff. */
	restartBackoffBaseMs?: number;
}

/** Start the detached project or global daemon broker selected by the CLI worker host. */
export async function startDaemonBrokerFromEnvironment(options: DaemonBrokerStartOptions = {}): Promise<void> {
	const projectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const runtimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	if (!projectDir || !runtimeDir) throw new Error("Daemon broker environment is incomplete");
	delete process.env[DAEMON_PROJECT_DIR_ENV];
	delete process.env[DAEMON_RUNTIME_DIR_ENV];
	const rawGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	delete process.env[DAEMON_IDLE_GRACE_ENV];
	const parsedGrace = rawGrace === undefined ? DEFAULT_IDLE_GRACE_MS : Number.parseInt(rawGrace, 10);
	const idleGraceMs = Number.isFinite(parsedGrace) && parsedGrace >= 0 ? parsedGrace : DEFAULT_IDLE_GRACE_MS;
	const requestedRestartBackoffBaseMs = options.restartBackoffBaseMs ?? RESTART_BACKOFF_BASE_MS;
	const restartBackoffBaseMs =
		Number.isFinite(requestedRestartBackoffBaseMs) && requestedRestartBackoffBaseMs >= 0
			? requestedRestartBackoffBaseMs
			: RESTART_BACKOFF_BASE_MS;
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const lease = await acquireBrokerLease(runtimeDir);
	if (!lease) return;
	setProcessName("omp daemon broker");
	// Record the scope's project dir so `omp ps` can map this hash-keyed runtime
	// dir back to its project (and derive the Windows pipe name) offline.
	void writeDaemonScopeMeta(runtimeDir, projectDir).catch(error => {
		logger.warn("Failed to record daemon scope metadata", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
	// Reclaim sibling daemon scopes left behind by dead brokers (issue #8674).
	// Detached and non-throwing so it never delays clients connecting to us.
	void pruneDeadDaemonRuntimeDirs(runtimeDir).catch(error => {
		logger.warn("Daemon runtime prune failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
	const token = (await Bun.file(path.join(runtimeDir, TOKEN_FILE)).text()).trim();
	if (!token) throw new Error("Daemon broker token is empty");
	const broker = new DaemonBroker(projectDir, runtimeDir, token, idleGraceMs, restartBackoffBaseMs);
	const cancelCleanup = postmortem.register("daemon-broker", () => broker.shutdown());
	try {
		await broker.run();
	} finally {
		cancelCleanup();
		await releaseBrokerLease(lease);
	}
}
