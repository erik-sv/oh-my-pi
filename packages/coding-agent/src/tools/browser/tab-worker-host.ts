import { logger, workerHostEntry } from "@oh-my-pi/pi-utils";
import { ToolError } from "../tool-errors";
import type { Transferable, Transport, WorkerInbound, WorkerOutbound } from "./tab-protocol";

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
	readonly mode: "worker" | "inline";
	/** Process-unique generation id. Identity for failure logs; never reused. */
	readonly id: number;
	/** False once {@link terminate} ran or the runtime dropped the worker. */
	readonly alive: boolean;
	/**
	 * Deliver a message to this generation; `false` means the generation is
	 * gone and nothing was delivered.
	 *
	 * NEVER throws. Bun's `Worker.postMessage` raises
	 * `InvalidStateError: Worker has been terminated` after `terminate()`, and
	 * `send` is reachable from abort listeners that run inside bare timer
	 * callbacks (the eval cell's idle watchdog). A throw there is an uncaught
	 * exception rather than a rejected promise, so it takes the whole CLI down.
	 */
	send(msg: WorkerInbound, transferList?: Transferable[]): boolean;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	/**
	 * Idempotent. Detaches every listener registered through this handle first,
	 * so a late message from a dying generation can never be mistaken for the
	 * replacement's reply.
	 */
	terminate(): Promise<void>;
}

class BunWorkerHandle implements WorkerHandle {
	readonly mode = "worker" as const;
	readonly id = ++nextWorkerId;
	#worker: Worker;
	/** Whether this handle may still post. Independent of ownership below. */
	#usable = true;
	/** Whether the underlying Worker has been torn down by this handle. */
	#terminated = false;
	#detachers = new Set<() => void>();

	constructor(worker: Worker) {
		this.#worker = worker;
	}

	get alive(): boolean {
		return this.#usable;
	}

	send(msg: WorkerInbound, transferList?: Transferable[]): boolean {
		if (!this.#usable) return false;
		try {
			this.#worker.postMessage(msg, { transfer: transferList ?? [] });
			return true;
		} catch (err) {
			// Either the runtime dropped the worker (terminated, crashed) or the
			// payload is not structured-cloneable. The second case leaves a LIVE
			// worker, so this only stops further sends. It must never be read as
			// "already torn down", or `terminate()` would skip the real cleanup
			// and leak an unkillable thread.
			this.#usable = false;
			logger.debug("Tab worker postMessage failed", {
				worker: this.id,
				message: msg.type,
				errorName: err instanceof Error ? err.name : "UnknownError",
			});
			return false;
		}
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
		this.#worker.addEventListener("message", wrap);
		return this.#track(() => this.#worker.removeEventListener("message", wrap));
	}

	onError(handler: (error: Error) => void): () => void {
		const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
		// `event.data` is the undeserializable payload itself: page content,
		// tool results, evaluated values. Report the failure, never the data.
		const onMessageError = (): void => handler(new ToolError("Tab worker sent an undeserializable message"));
		this.#worker.addEventListener("error", onError);
		this.#worker.addEventListener("messageerror", onMessageError);
		return this.#track(() => {
			this.#worker.removeEventListener("error", onError);
			this.#worker.removeEventListener("messageerror", onMessageError);
		});
	}

	async terminate(): Promise<void> {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#usable = false;
		this.#detachAll();
		this.#worker.terminate();
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

/**
 * Inline fallback for environments where Bun cannot compile or spawn the worker
 * entry. This preserves normal browser behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
class InlineWorkerHandle implements WorkerHandle {
	readonly mode = "inline" as const;
	readonly id = ++nextWorkerId;
	#alive = true;
	#hostListeners = new Set<(msg: WorkerOutbound) => void>();
	#workerListeners = new Set<(msg: WorkerInbound) => void>();

	get alive(): boolean {
		return this.#alive;
	}

	/** Transport handed to the in-process {@link WorkerCore}. */
	readonly transport: Transport = {
		send: msg =>
			queueMicrotask(() => {
				if (!this.#alive) return;
				for (const listener of this.#hostListeners) listener(msg as WorkerOutbound);
			}),
		onMessage: handler => {
			const typed = handler as (msg: WorkerInbound) => void;
			this.#workerListeners.add(typed);
			return () => this.#workerListeners.delete(typed);
		},
		close: () => undefined,
	};

	send(msg: WorkerInbound): boolean {
		if (!this.#alive) return false;
		queueMicrotask(() => {
			if (!this.#alive) return;
			for (const listener of this.#workerListeners) listener(msg);
		});
		return true;
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#hostListeners.add(handler);
		return () => this.#hostListeners.delete(handler);
	}

	onError(): () => void {
		// An inline worker shares this thread: failures surface as rejections of
		// the run itself, never as a worker `error` event.
		return () => undefined;
	}

	async terminate(): Promise<void> {
		this.#alive = false;
		this.#hostListeners.clear();
		this.#workerListeners.clear();
	}
}

export function wrapBunWorker(worker: Worker): WorkerHandle {
	return new BunWorkerHandle(worker);
}

export async function spawnTabWorker(): Promise<WorkerHandle> {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_tab"] })
			: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
		return new BunWorkerHandle(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline tab worker (no sync-loop guard)", {
			error: err instanceof Error ? err.message : String(err),
		});
		return await spawnInlineWorker();
	}
}

export async function spawnInlineWorker(): Promise<WorkerHandle> {
	const handle = new InlineWorkerHandle();
	// Deliberately lazy: `tab-worker` drags puppeteer's page/runtime machinery
	// into the host thread, and this fallback only runs when Bun cannot spawn a
	// real Worker. A static import would load it on every tab open.
	const { WorkerCore } = await import("./tab-worker");
	new WorkerCore(handle.transport, false);
	return handle;
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	// Bun can leave `error` null and put a source frame plus stack in `message`.
	// Keep the diagnostic line, not evaluated source or data-URL stack frames.
	const message = Bun.stripANSI(event.message ?? "");
	const diagnostic = message.match(/^[A-Za-z_$][\w$]*:[^\r\n]*/m)?.[0];
	return new Error(diagnostic ?? (message && !/[\r\n]/.test(message) ? message : "Unknown tab worker error"));
}
