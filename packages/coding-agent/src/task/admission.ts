export type TaskAdmissionMode = "open" | "defer" | "deny";

export interface TaskAdmissionPolicy {
	mode: TaskAdmissionMode;
	reason?: string;
	maxNewAgents?: number;
	ttlMs?: number;
}

export interface TaskAdmissionSnapshot {
	mode: TaskAdmissionMode;
	reason: string | undefined;
	waiting: number;
	admittedInEpoch: number;
	maxNewAgents: number | undefined;
	expiresAt: number | undefined;
}

export interface TaskAdmissionOptions {
	waitMs?: number;
}

export class TaskAdmissionDeniedError extends Error {
	constructor(reason?: string) {
		super(`Task admission denied${reason ? `: ${reason}` : ""}`);
		this.name = "TaskAdmissionDeniedError";
	}
}

export class TaskAdmissionTimeoutError extends Error {
	constructor(reason?: string) {
		super(`Task admission timed out${reason ? `: ${reason}` : ""}`);
		this.name = "TaskAdmissionTimeoutError";
	}
}

const DEFAULT_WAIT_MS = 60_000;

/** Process-global policy gate for fresh subagent admission. */
export class TaskAdmission {
	static #global: TaskAdmission | undefined;

	static global(): TaskAdmission {
		TaskAdmission.#global ??= new TaskAdmission();
		return TaskAdmission.#global;
	}

	static resetGlobalForTests(): void {
		const current = TaskAdmission.#global;
		if (current) current.#reset();
		TaskAdmission.#global = undefined;
	}

	#mode: TaskAdmissionMode = "open";
	#reason: string | undefined;
	#maxNewAgents: number | undefined;
	#admittedInEpoch = 0;
	#expiresAt: number | undefined;
	#expiryTimer: ReturnType<typeof setTimeout> | undefined;
	#epoch = 0;
	readonly #waiters = new Set<() => void>();

	setPolicy(policy: TaskAdmissionPolicy): void {
		this.#validatePolicy(policy);
		clearTimeout(this.#expiryTimer);
		this.#expiryTimer = undefined;
		this.#mode = policy.mode;
		this.#reason = policy.reason?.trim() || undefined;
		this.#maxNewAgents = policy.maxNewAgents;
		this.#admittedInEpoch = 0;
		this.#expiresAt = policy.ttlMs === undefined ? undefined : Date.now() + policy.ttlMs;
		this.#epoch++;
		if (this.#expiresAt !== undefined) {
			const epoch = this.#epoch;
			this.#expiryTimer = setTimeout(() => {
				if (this.#epoch !== epoch) return;
				this.#failOpen();
			}, policy.ttlMs);
			this.#expiryTimer.unref?.();
		}
		this.#wakeWaiters();
	}

	async admit(signal: AbortSignal, options?: TaskAdmissionOptions): Promise<void> {
		const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
		if (!Number.isFinite(waitMs) || waitMs < 0) {
			throw new TypeError("Task admission waitMs must be a finite non-negative number");
		}
		const deadline = Date.now() + waitMs;
		while (true) {
			this.#expireIfNeeded();
			this.#throwIfAborted(signal);
			if (this.#mode === "deny") throw new TaskAdmissionDeniedError(this.#reason);
			if (this.#mode === "open" && this.#hasEpochCapacity()) {
				this.#admittedInEpoch++;
				return;
			}
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw new TaskAdmissionTimeoutError(this.#reason);
			await this.#waitForNextEpoch(signal, remainingMs);
		}
	}

	snapshot(): TaskAdmissionSnapshot {
		this.#expireIfNeeded();
		return {
			mode: this.#mode,
			reason: this.#reason,
			waiting: this.#waiters.size,
			admittedInEpoch: this.#admittedInEpoch,
			maxNewAgents: this.#maxNewAgents,
			expiresAt: this.#expiresAt,
		};
	}

	#hasEpochCapacity(): boolean {
		return this.#maxNewAgents === undefined || this.#admittedInEpoch < this.#maxNewAgents;
	}

	#waitForNextEpoch(signal: AbortSignal, waitMs: number): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			this.#waiters.delete(onEpoch);
			if (error === undefined) resolve();
			else reject(error);
		};
		const onEpoch = () => finish();
		const onAbort = () => finish(this.#abortReason(signal));
		const timer = setTimeout(() => finish(new TaskAdmissionTimeoutError(this.#reason)), waitMs);
		timer.unref?.();
		this.#waiters.add(onEpoch);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		return promise;
	}

	#expireIfNeeded(): void {
		if (this.#expiresAt !== undefined && Date.now() >= this.#expiresAt) this.#failOpen();
	}

	#failOpen(): void {
		clearTimeout(this.#expiryTimer);
		this.#expiryTimer = undefined;
		this.#mode = "open";
		this.#reason = undefined;
		this.#maxNewAgents = undefined;
		this.#admittedInEpoch = 0;
		this.#expiresAt = undefined;
		this.#epoch++;
		this.#wakeWaiters();
	}

	#wakeWaiters(): void {
		for (const wake of [...this.#waiters]) wake();
	}

	#throwIfAborted(signal: AbortSignal): void {
		if (signal.aborted) throw this.#abortReason(signal);
	}

	#abortReason(signal: AbortSignal): Error {
		const reason = signal.reason;
		const detail = reason instanceof Error ? reason.message : reason === undefined ? "" : String(reason);
		const error = new Error(`Task admission aborted${detail && !/aborted/i.test(detail) ? `: ${detail}` : ""}`);
		error.name = "AbortError";
		return error;
	}

	#validatePolicy(policy: TaskAdmissionPolicy): void {
		if (policy.mode !== "open" && policy.mode !== "defer" && policy.mode !== "deny") {
			throw new TypeError(`Invalid task admission mode: ${String(policy.mode)}`);
		}
		if (policy.maxNewAgents !== undefined && (!Number.isInteger(policy.maxNewAgents) || policy.maxNewAgents < 0)) {
			throw new TypeError("Task admission maxNewAgents must be a non-negative integer");
		}
		if (policy.ttlMs !== undefined && (!Number.isFinite(policy.ttlMs) || policy.ttlMs <= 0)) {
			throw new TypeError("Task admission ttlMs must be a finite positive number");
		}
	}

	#reset(): void {
		clearTimeout(this.#expiryTimer);
		this.#expiryTimer = undefined;
		this.#mode = "open";
		this.#reason = undefined;
		this.#maxNewAgents = undefined;
		this.#admittedInEpoch = 0;
		this.#expiresAt = undefined;
		this.#epoch++;
		this.#wakeWaiters();
	}
}
