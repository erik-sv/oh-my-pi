import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { TaskAdmission } from "@oh-my-pi/pi-coding-agent/task/admission";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("TaskAdmission", () => {
	beforeEach(() => {
		TaskAdmission.resetGlobalForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
		TaskAdmission.resetGlobalForTests();
	});

	it("admits open work, wakes deferred work on a new policy epoch, and denies with the host reason", async () => {
		const admission = TaskAdmission.global();

		admission.setPolicy({ mode: "open", maxNewAgents: 2 });
		await admission.admit(new AbortController().signal);
		expect(admission.snapshot().admittedInEpoch).toBe(1);

		admission.setPolicy({ mode: "defer", reason: "host MemAvailable is at the 2560 MiB floor" });
		const deferred = admission.admit(new AbortController().signal, { waitMs: 10_000 });
		await flushMicrotasks();
		expect(admission.snapshot().waiting).toBe(1);

		admission.setPolicy({ mode: "open", maxNewAgents: 2 });
		await deferred;
		expect(admission.snapshot()).toMatchObject({ mode: "open", waiting: 0, admittedInEpoch: 1 });

		admission.setPolicy({ mode: "deny", reason: "host memory hard cap" });
		await expect(admission.admit(new AbortController().signal)).rejects.toThrow(
			/denied.*host memory hard cap|host memory hard cap.*denied/i,
		);
	});

	it("shares maxNewAgents across callers and resets the monotonic count only on a new policy epoch", async () => {
		const parentAdmission = TaskAdmission.global();
		const nestedAdmission = TaskAdmission.global();
		parentAdmission.setPolicy({ mode: "open", reason: "one recovery slot", maxNewAgents: 1 });

		await parentAdmission.admit(new AbortController().signal);
		const nested = nestedAdmission.admit(new AbortController().signal, { waitMs: 10_000 });
		await flushMicrotasks();
		expect(parentAdmission.snapshot()).toMatchObject({ admittedInEpoch: 1, maxNewAgents: 1, waiting: 1 });

		parentAdmission.setPolicy({ mode: "open", maxNewAgents: 1 });
		await nested;
		expect(nestedAdmission.snapshot()).toMatchObject({ admittedInEpoch: 1, waiting: 0 });
	});

	it("removes an aborted deferred waiter without admitting it", async () => {
		const admission = TaskAdmission.global();
		const controller = new AbortController();
		admission.setPolicy({ mode: "defer", reason: "memory pressure" });

		const pending = admission.admit(controller.signal, { waitMs: 10_000 });
		await flushMicrotasks();
		expect(admission.snapshot().waiting).toBe(1);

		const rejection = pending.catch(error => error);
		controller.abort();
		expect(String(await rejection)).toMatch(/aborted/i);
		expect(admission.snapshot()).toMatchObject({ waiting: 0, admittedInEpoch: 0 });
	});

	it("fails a bounded defer with the policy reason instead of waiting forever", async () => {
		vi.useFakeTimers();
		const admission = TaskAdmission.global();
		admission.setPolicy({ mode: "defer", reason: "remote capacity unavailable" });

		const pending = admission.admit(new AbortController().signal, { waitMs: 50 });
		const rejection = pending.catch(error => error);
		vi.advanceTimersByTime(50);
		expect(String(await rejection)).toMatch(
			/timed out.*remote capacity unavailable|remote capacity unavailable.*timed out/i,
		);
		expect(admission.snapshot().waiting).toBe(0);
	});

	it("fails open on TTL expiry and starts a fresh maxNewAgents epoch", async () => {
		vi.useFakeTimers();
		const admission = TaskAdmission.global();
		admission.setPolicy({ mode: "open", maxNewAgents: 1, ttlMs: 100 });

		await admission.admit(new AbortController().signal);
		const exhausted = admission.admit(new AbortController().signal, { waitMs: 10_000 });
		await flushMicrotasks();
		expect(admission.snapshot()).toMatchObject({ mode: "open", admittedInEpoch: 1, waiting: 1 });

		vi.advanceTimersByTime(100);
		await exhausted;
		expect(admission.snapshot()).toMatchObject({ mode: "open", admittedInEpoch: 1, waiting: 0 });
	});
});
