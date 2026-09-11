import { logger } from "@oh-my-pi/pi-utils";
import type { WorkerHandle as SubprocessHandle } from "../../subprocess/worker-client";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import { shouldDetachKernel } from "../../eval/py/spawn-options";
import { isThenable } from "../../utils/ipc";
import type { WorkerInbound, WorkerOutbound } from "./tab-protocol";

// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/npm builds only need one JavaScript entry.

let nextWorkerId = 0;

/**
 * One tab-worker generation. A tab outlives its workers: a timed-out worker is
 * terminated and replaced by {@link spawnTabWorker}, so every message must be
 * addressed to the generation that owns the work, never to "whatever worker the
 * tab currently has".
 */
export interface WorkerHandle {
	readonly mode: "process";
	/** Process-unique generation id. Identity for failure logs; never reused. */
	readonly id: number;
	/** False once {@link terminate} ran or the runtime dropped the worker. */
	readonly alive: boolean;
	/**
	 * Deliver a message to this generation; `false` means the generation is
	 * gone and nothing was delivered.
	 *
	 * NEVER throws. Process IPC can fail after the subprocess exits or reject a
	 * payload that advanced serialization cannot clone. Payload buffers are
	 * cloned because IPC cannot transfer ownership.
	 */
	send(msg: WorkerInbound): boolean;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	/**
	 * Idempotent. Detaches every listener registered through this handle before
	 * killing the isolated process.
	 */
	terminate(): Promise<void>;
	/**
	 * Ask the worker to clean up its page and acknowledge closure, then kill the
	 * isolated process. Returns false when the handshake cannot complete.
	 */
	close(): Promise<boolean>;
}

const TAB_PROCESS_WORKER_ARG = "__omp_worker_tab_process";
const WORKER_CLOSE_TIMEOUT_MS = 750;

class ProcessWorkerHandle implements WorkerHandle {
	readonly mode = "process" as const;
	readonly id = ++nextWorkerId;
	#base: SubprocessHandle<WorkerInbound, WorkerOutbound>;
	#usable = true;
	#terminated = false;
	#detachers = new Set<() => void>();

	constructor() {
		const spawned = createWorkerSubprocess<WorkerOutbound>({
			spawnCommand: resolveWorkerSpawnCmd(TAB_PROCESS_WORKER_ARG),
			env: workerEnvFromParent(),
			exitLabel: "Browser tab worker",
			detached: shouldDetachKernel(process.platform),
			reportCleanExit: true,
			unref: false,
		});
		this.#base = createWorkerHandle(spawned, message => {
			const result = spawned.proc.send(message);
			if (isThenable(result)) result.then(undefined, () => {});
		});
		this.#track(
			this.#base.onError(() => {
				this.#usable = false;
			}),
		);
	}

	get alive(): boolean {
		return this.#usable;
	}

	send(msg: WorkerInbound): boolean {
		if (!this.#usable) return false;
		try {
			this.#base.send(msg);
			return true;
		} catch (error) {
			this.#usable = false;
			logger.debug("Tab worker IPC send failed", {
				worker: this.id,
				message: msg.type,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			return false;
		}
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		return this.#track(this.#base.onMessage(handler));
	}

	onError(handler: (error: Error) => void): () => void {
		return this.#track(this.#base.onError(handler));
	}

	async close(): Promise<boolean> {
		if (!this.#usable || this.#terminated) return false;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let settled = false;
		const finish = (closed: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			unsubscribeMessage();
			unsubscribeError();
			resolve(closed);
		};
		const unsubscribeMessage = this.onMessage(message => {
			if (message.type !== "closed") return;
			void this.terminate().finally(() => finish(true));
		});
		const unsubscribeError = this.onError(() => finish(false));
		const timeout = setTimeout(() => finish(false), WORKER_CLOSE_TIMEOUT_MS);
		if (!this.send({ type: "close" })) finish(false);
		return await promise;
	}

	async terminate(): Promise<void> {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#usable = false;
		this.#detachAll();
		await this.#base.terminate();
	}

	#track(detach: () => void): () => void {
		this.#detachers.add(detach);
		return () => {
			if (this.#detachers.delete(detach)) detach();
		};
	}

	#detachAll(): void {
		for (const detach of this.#detachers) detach();
		this.#detachers.clear();
	}
}

/** Distribution smoke: prove the packaged subprocess selector boots and acknowledges cleanup. */
export async function smokeTestTabWorker(): Promise<void> {
	const worker = await spawnTabWorker();
	try {
		if (!(await worker.close())) throw new Error("Browser tab worker did not acknowledge closure");
	} finally {
		await worker.terminate();
	}
}

export async function spawnTabWorker(): Promise<WorkerHandle> {
	return new ProcessWorkerHandle();
}
