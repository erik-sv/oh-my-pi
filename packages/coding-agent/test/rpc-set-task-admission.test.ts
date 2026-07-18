import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, ptree, readJsonl, removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";

describe("RPC set_task_admission", () => {
	let proc: ptree.ChildProcess | null = null;
	let sessionDir: string | null = null;

	afterEach(async () => {
		proc?.kill();
		proc = null;
		if (sessionDir) {
			await removeWithRetries(sessionDir).catch(() => {});
			sessionDir = null;
		}
	});

	test("validates policy payloads and round-trips the applied admission state", async () => {
		sessionDir = path.join(os.tmpdir(), `omp-rpc-task-admission-${Snowflake.next()}`);
		const packageDir = path.join(import.meta.dir, "..");
		proc = ptree.spawn(["bun", path.join(packageDir, "src", "cli.ts"), "--mode", "rpc"], {
			cwd: packageDir,
			env: {
				...Bun.env,
				ANTHROPIC_API_KEY: "test-dummy-key",
				PI_CODING_AGENT_DIR: sessionDir,
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
		});

		const frames: Record<string, unknown>[] = [];
		const waiters: Array<{
			predicate: (frame: Record<string, unknown>) => boolean;
			resolve: (frame: Record<string, unknown>) => void;
		}> = [];
		const nextFrame = (predicate: (frame: Record<string, unknown>) => boolean) => {
			const existing = frames.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise<Record<string, unknown>>(resolve => {
				waiters.push({ predicate, resolve });
			});
		};
		void (async () => {
			for await (const line of readJsonl(proc!.stdout)) {
				if (!isRecord(line)) continue;
				frames.push(line);
				const index = waiters.findIndex(waiter => waiter.predicate(line));
				if (index !== -1) {
					const [waiter] = waiters.splice(index, 1);
					waiter?.resolve(line);
				}
			}
		})();
		const send = (frame: object) => {
			const stdin = proc?.stdin as FileSink;
			stdin.write(`${JSON.stringify(frame)}\n`);
			void stdin.flush();
		};

		await nextFrame(frame => frame.type === "ready");
		send({
			id: "defer-policy",
			type: "set_task_admission",
			policy: {
				mode: "defer",
				reason: "host MemAvailable reached 2560 MiB",
				maxNewAgents: 2,
				parkIdle: true,
				ttlMs: 15_000,
			},
		});
		const deferred = await nextFrame(
			frame =>
				frame.type === "response" &&
				frame.command === "set_task_admission" &&
				(frame.id === "defer-policy" || frame.id === undefined),
		);
		expect(deferred).toEqual({
			id: "defer-policy",
			type: "response",
			command: "set_task_admission",
			success: true,
			data: { applied: true, running: 0, waiting: 0, parked: 0 },
		});

		const invalidPolicies = [
			{ id: "bad-mode", policy: { mode: "pause" }, field: /mode/i },
			{ id: "bad-limit", policy: { mode: "open", maxNewAgents: -1 }, field: /maxNewAgents/i },
			{ id: "bad-ttl", policy: { mode: "defer", ttlMs: 0 }, field: /ttlMs/i },
			{ id: "bad-park", policy: { mode: "open", parkIdle: "yes" }, field: /parkIdle/i },
		];
		for (const { id, policy, field } of invalidPolicies) {
			send({ id, type: "set_task_admission", policy });
			const response = await nextFrame(
				frame => frame.type === "response" && frame.command === "set_task_admission" && frame.id === id,
			);
			expect(response.success).toBe(false);
			expect(response.error).toEqual(expect.stringMatching(field));
		}

		send({ id: "reopen", type: "set_task_admission", policy: { mode: "open", ttlMs: 15_000 } });
		const reopened = await nextFrame(
			frame => frame.type === "response" && frame.command === "set_task_admission" && frame.id === "reopen",
		);
		expect(reopened).toEqual({
			id: "reopen",
			type: "response",
			command: "set_task_admission",
			success: true,
			data: { applied: true, running: 0, waiting: 0, parked: 0 },
		});
	}, 60_000);
});
