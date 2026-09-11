/**
 * Lifetime contract of a tab worker generation (`wrapBunWorker`).
 *
 * A handle has two independent states: whether it may still post, and whether
 * it still owns a live Worker that must be torn down. Collapsing them means a
 * failed `postMessage` disarms `terminate()`, and `postMessage` fails for
 * reasons that leave the worker ALIVE (a `DataCloneError` on an unserializable
 * payload), so the thread and its listeners would survive every teardown path
 * the supervisor has.
 */

import { describe, expect, it } from "bun:test";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { wrapBunWorker } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker-host";

/** Bun `Worker` surface used by the handle, with the platform's throw semantics. */
class FakeBunWorker extends EventTarget {
	readonly received: WorkerInbound[] = [];
	terminated = false;
	rejectPosts: Error | undefined;

	postMessage(msg: WorkerInbound): void {
		if (this.terminated) throw new DOMException("Worker has been terminated", "InvalidStateError");
		if (this.rejectPosts) throw this.rejectPosts;
		this.received.push(msg);
	}

	terminate(): void {
		this.terminated = true;
	}

	emit(msg: WorkerOutbound): void {
		this.dispatchEvent(new MessageEvent("message", { data: msg }));
	}
}

const CLOSE: WorkerInbound = { type: "close" };

describe("tab worker handle lifetime", () => {
	it("still tears down the worker after an undeliverable message", async () => {
		const worker = new FakeBunWorker();
		const handle = wrapBunWorker(worker as unknown as Worker);
		const seen: WorkerOutbound[] = [];
		handle.onMessage(msg => seen.push(msg));

		// A live worker refusing an unserializable payload: the send fails, the
		// thread does not.
		worker.rejectPosts = new DOMException("could not be cloned", "DataCloneError");
		expect(handle.send(CLOSE)).toBe(false);
		expect(handle.alive).toBe(false);

		await handle.terminate();

		// Ownership survived the failed send: the worker is really gone and its
		// listeners are detached, so a late message cannot reach the supervisor.
		expect(worker.terminated).toBe(true);
		worker.emit({ type: "closed" });
		expect(seen).toEqual([]);
	});

	it("reports undelivered sends and stays idempotent once terminated", async () => {
		const worker = new FakeBunWorker();
		const handle = wrapBunWorker(worker as unknown as Worker);

		expect(handle.send(CLOSE)).toBe(true);
		await handle.terminate();
		await handle.terminate();

		// Post-terminate sends are refused rather than thrown: this call runs
		// inside abort listeners, where a throw is an uncaught exception.
		expect(handle.send(CLOSE)).toBe(false);
		expect(worker.received).toEqual([CLOSE]);
	});

	it("retains native worker diagnostics without copying source frames or stack URLs", async () => {
		const worker = new FakeBunWorker();
		const handle = wrapBunWorker(worker as unknown as Worker);
		const errors: Error[] = [];
		handle.onError(error => errors.push(error));
		try {
			worker.dispatchEvent(
				new ErrorEvent("error", {
					message:
						'1 | const apiKey = "PRIVATE_TOKEN"; throw new Error("worker failed");\n' +
						"                                           ^\n" +
						"error: worker failed\n" +
						"      at <anonymous> (data:text/javascript,PRIVATE_TOKEN:1:30)\n",
				}),
			);
			expect(errors[0]?.message).toContain("worker failed");
			expect(errors[0]?.message).not.toContain("PRIVATE_TOKEN");
			expect(errors[0]?.message).not.toContain("data:text");
		} finally {
			await handle.terminate();
		}
	});
});
