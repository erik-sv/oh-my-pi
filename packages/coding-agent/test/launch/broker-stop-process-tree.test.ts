// Integration test — real timers are required (ts-no-test-timers exception): these drive the real
// broker over its unix socket against real child processes, and the bugs live in the interaction
// between OS process exit, inherited pipe write ends, and the supervised stop path. Fake timers
// cannot control either.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonSnapshot,
} from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Start an in-process broker for `projectDir`, scoping its environment to the call. */
function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

/**
 * Open a reference while the process is known to be alive.
 *
 * Every liveness check and every cleanup kill in this file goes through the
 * reference taken here. Reopening a bare pid later is the exact mistake these
 * tests exist to defend against: the number can name a stranger by then.
 */
function pin(pid: number, label: string): Process {
	const reference = Process.fromPid(pid);
	if (!reference) throw new Error(`${label} process ${pid} is unavailable`);
	return reference;
}

async function snapshotOf(client: DaemonBrokerClient, name: string): Promise<DaemonSnapshot> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
	const daemon = listed.daemons.find(entry => entry.name === name);
	if (!daemon) throw new Error(`daemon ${name} not listed`);
	return daemon;
}

async function waitForTerminalState(
	client: DaemonBrokerClient,
	name: string,
	deadlineMs: number,
): Promise<DaemonSnapshot> {
	const deadline = Date.now() + deadlineMs;
	let last: DaemonSnapshot | undefined;
	while (Date.now() < deadline) {
		last = await snapshotOf(client, name);
		if (last.state === "exited" || last.state === "failed") return last;
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} never reached a terminal state (last state: ${last?.state})`);
}

/** Pin the grandchild the supervised child announced on its stdout, while it is still alive. */
async function pinGrandchild(client: DaemonBrokerClient, name: string, deadlineMs: number): Promise<Process> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const logs = await client.request({ op: "logs", name, lines: 20, head: true, follow: false, timeoutMs: 500 });
		if (logs.op !== "logs") throw new Error(`unexpected result: ${logs.op}`);
		const match = /grandchild (\d+)/.exec(logs.text);
		if (match) return pin(Number(match[1]), "grandchild");
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} never reported a grandchild pid`);
}

async function processGone(reference: Process, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (reference.status() !== "running") return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(25);
	}
}

function killLeftover(reference: Process | undefined): void {
	if (reference?.status() === "running") reference.killTree();
}

/**
 * Write the two scripts these tests use: a keep-alive grandchild, and a
 * supervised child that hands the grandchild its own stdout — the shape every
 * real daemon with a worker pool or a browser subprocess has.
 */
async function writeScripts(projectDir: string, exitAfterSpawn: boolean): Promise<string> {
	const keepAlivePath = path.join(projectDir, "keep-alive.ts");
	await Bun.write(keepAlivePath, "setInterval(() => {}, 1_000);\n");
	const childPath = path.join(projectDir, "child.ts");
	await Bun.write(
		childPath,
		`const grandchild = Bun.spawn([process.execPath, "run", ${JSON.stringify(keepAlivePath)}], {
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
});
grandchild.unref();
await Bun.write(Bun.stdout, \`grandchild \${grandchild.pid}\\n\`);
${exitAfterSpawn ? "process.exit(0);" : "setInterval(() => {}, 1_000);"}
`,
	);
	return childPath;
}

describe("daemon broker supervised stop", () => {
	it("reaches a terminal state when the child exits while a descendant holds its stdout", async () => {
		using tempDir = TempDir.createSync("@omp-launch-held-pipe-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir, { recursive: true });
		const childPath = await writeScripts(projectDir, true);

		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const name = "held-pipe";
		let orphan: Process | undefined;
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name,
					application: process.execPath,
					args: ["run", childPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(started.op).toBe("start");
			orphan = await pinGrandchild(client, name, 10_000);

			// The child is gone, but the grandchild still holds the stdout write end, so
			// end-of-output never arrives. Settlement must follow the child's exit anyway:
			// gating it on the drains left the record non-terminal forever, which is what
			// made a later `stop` park in `stopping` with the tree still running.
			const settled = await waitForTerminalState(client, name, 15_000);
			expect(settled.state).toBe("exited");
			expect(settled.exitCode).toBe(0);
			expect(settled.pid).toBeUndefined();

			// A descendant that outlived a *self-exited* daemon is not a stop target. It
			// must still be alive: settling on exit may not become a licence to sweep
			// processes nobody asked the broker to stop.
			expect(orphan.status()).toBe(ProcessStatus.Running);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			killLeftover(orphan);
			process.title = previousTitle;
		}
	}, 30_000);

	it("terminates the supervised descendant tree and settles on stop", async () => {
		using tempDir = TempDir.createSync("@omp-launch-stop-tree-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir, { recursive: true });
		const childPath = await writeScripts(projectDir, false);

		const previousTitle = process.title;
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const name = "stop-tree";
		let child: Process | undefined;
		let descendant: Process | undefined;
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name,
					application: process.execPath,
					args: ["run", childPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
			if (started.daemon.pid === undefined) throw new Error("supervised child has no pid");
			child = pin(started.daemon.pid, "supervised child");
			descendant = await pinGrandchild(client, name, 10_000);

			const stopped = await client.request({ op: "stop", name, timeoutMs: 5_000 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			// A stop that cannot signal the tree used to return `stopping` and leave the
			// whole subtree resident; the response state is the only thing a caller has.
			expect(stopped.daemon.state).toBe("exited");
			expect(await processGone(child, 5_000)).toBe(true);
			expect(await processGone(descendant, 5_000)).toBe(true);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			killLeftover(descendant);
			killLeftover(child);
			process.title = previousTitle;
		}
	}, 30_000);

	/**
	 * A pid persisted by a previous broker is only that daemon again if the
	 * process behind it still reports the identity pinned at spawn. These cases
	 * are the whole contract: a tampered or legacy record must never be
	 * signalled, and a revalidated one must still be stoppable.
	 */
	for (const scenario of [
		{ label: "tampered", identity: "linux:0:0:0:0" as string | undefined },
		{ label: "legacy", identity: undefined },
		{ label: "revalidated", identity: "keep" as string | undefined },
	]) {
		it(`${scenario.label} recovered identity decides whether a stop may signal`, async () => {
			using tempDir = TempDir.createSync(`@omp-launch-recover-${scenario.label}-`);
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir, { recursive: true });
			const servicePath = path.join(projectDir, "service.ts");
			await Bun.write(servicePath, "setInterval(() => {}, 1_000);\n");

			const previousTitle = process.title;
			const name = "recovered";
			let daemon: Process | undefined;

			const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const firstBroker = startBroker(projectDir, runtimeDir);
			try {
				const started = await first.request({
					op: "start",
					spec: {
						name,
						application: process.execPath,
						args: ["run", servicePath],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: true,
						detached: true,
					},
				});
				if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
				if (started.daemon.pid === undefined) throw new Error("detached daemon has no pid");
				daemon = pin(started.daemon.pid, "detached daemon");
			} finally {
				await first.request({ op: "shutdown" }).catch(() => undefined);
				first.close();
				await firstBroker;
			}
			if (!daemon) throw new Error("detached daemon reference was not retained");

			// Everything past the spawn runs under one cleanup: this daemon is
			// `persist: true` and survives its broker, so a failed assertion in the
			// middle must not leak it.
			try {
				// Rewrite the persisted identity the way a reboot, a pid recycle, or an
				// older omp release would leave it.
				const metaPath = path.join(runtimeDir, "daemons", name, "meta.json");
				const meta = (await Bun.file(metaPath).json()) as { identity?: string };
				expect(typeof meta.identity).toBe("string");
				if (scenario.identity === undefined) delete meta.identity;
				else if (scenario.identity !== "keep") meta.identity = scenario.identity;
				await Bun.write(metaPath, JSON.stringify(meta));

				const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
				const secondBroker = startBroker(projectDir, runtimeDir);
				try {
					const recovered = await snapshotOf(second, name);
					if (scenario.identity === "keep") {
						expect(recovered.state).toBe("running");
						const stopped = await second.request({ op: "stop", name, timeoutMs: 5_000 });
						if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
						expect(stopped.daemon.state).toBe("exited");
						expect(await processGone(daemon, 5_000)).toBe(true);
					} else {
						// Unverifiable: reaped in the record, reported, and left alone.
						expect(recovered.state).toBe("exited");
						expect(recovered.exitReason).toContain("identity could not be verified");
						await second.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
						expect(daemon.status()).toBe(ProcessStatus.Running);
					}
				} finally {
					await second.request({ op: "shutdown" }).catch(() => undefined);
					second.close();
					await secondBroker;
				}
			} finally {
				killLeftover(daemon);
				process.title = previousTitle;
			}
		}, 30_000);
	}
});
