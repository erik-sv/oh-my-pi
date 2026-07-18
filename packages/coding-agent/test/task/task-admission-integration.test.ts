import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { TaskAdmission } from "@oh-my-pi/pi-coding-agent/task/admission";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(manager: AsyncJobManager, agentId: string, taskDepth: number): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		taskDepth,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": false, "task.maxConcurrency": 1 }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => agentId,
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

function waitForDeferredCount(admission: TaskAdmission, expected: number): Promise<void> {
	const reached = Promise.withResolvers<void>();
	const admit = admission.admit.bind(admission);
	vi.spyOn(admission, "admit").mockImplementation((signal, options) => {
		const pending = admit(signal, options);
		if (admission.snapshot().waiting === expected) reached.resolve();
		return pending;
	});
	return reached.promise;
}

describe("TaskTool process-global admission", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		TaskAdmission.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		manager = new AsyncJobManager({ maxRunningJobs: 1, onJobComplete: async () => {} });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		TaskAdmission.resetGlobalForTests();
		await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("queues every deferred spawn before acquiring the shared session semaphore", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const starts: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			starts.push(id);
			return {
				index: 0,
				id,
				agent: "task",
				agentSource: "bundled",
				task: "task prompt",
				assignment: "Do the thing.",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			} satisfies SingleResult;
		});
		const admission = TaskAdmission.global();
		admission.setPolicy({ mode: "defer", reason: "host memory floor", ttlMs: 60_000 });
		const deferred = waitForDeferredCount(admission, 2);
		const tool = await TaskTool.create(createSession(manager, "Main", 0));

		await tool.execute("first-call", {
			agent: "task",
			name: "FirstDeferred",
			task: "Do first work.",
		} as TaskParams);
		await tool.execute("second-call", {
			agent: "task",
			name: "SecondDeferred",
			task: "Do second work.",
		} as TaskParams);
		await deferred;

		try {
			expect(admission.snapshot().waiting).toBe(2);
			expect(starts).toEqual([]);
			expect(manager.atCapacity).toBe(false);
			expect(manager.getJob("FirstDeferred")?.queued).toBe(true);
			expect(manager.getJob("SecondDeferred")?.queued).toBe(true);
		} finally {
			admission.setPolicy({ mode: "open", maxNewAgents: 2 });
			await manager.waitForAll();
		}
	});

	it("defers top-level and nested spawns before either a session permit or running-job slot is held", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const releases = new Map([
			["TopWork", Promise.withResolvers<void>()],
			["NestedWork", Promise.withResolvers<void>()],
		]);
		const firstStarted = Promise.withResolvers<string>();
		const secondStarted = Promise.withResolvers<string>();
		const starts: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			starts.push(id);
			(starts.length === 1 ? firstStarted : secondStarted).resolve(id);
			await releases.get(id)!.promise;
			return {
				index: 0,
				id,
				agent: "task",
				agentSource: "bundled",
				task: "task prompt",
				assignment: "Do the thing.",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			} satisfies SingleResult;
		});

		const admission = TaskAdmission.global();
		admission.setPolicy({ mode: "defer", reason: "host memory floor", ttlMs: 60_000 });
		const deferred = waitForDeferredCount(admission, 2);
		const topLevel = await TaskTool.create(createSession(manager, "Main", 0));
		const nested = await TaskTool.create(createSession(manager, "ParentSub", 1));

		await topLevel.execute("top-call", {
			agent: "task",
			name: "TopWork",
			task: "Do top-level work.",
		} as TaskParams);
		await nested.execute("nested-call", {
			agent: "task",
			name: "NestedWork",
			task: "Do nested work.",
		} as TaskParams);
		await deferred;

		try {
			expect(starts).toEqual([]);
			expect(admission.snapshot().waiting).toBe(2);
			expect(manager.atCapacity).toBe(false);
			expect(manager.getJob("TopWork")?.queued).toBe(true);
			expect(manager.getJob("NestedWork")?.queued).toBe(true);

			admission.setPolicy({ mode: "open", maxNewAgents: 1, ttlMs: 60_000 });
			const firstId = await firstStarted.promise;
			expect(starts).toEqual([firstId]);
			expect(admission.snapshot()).toMatchObject({ admittedInEpoch: 1, waiting: 1 });
			expect(manager.atCapacity).toBe(true);
			const waitingId = firstId === "TopWork" ? "NestedWork" : "TopWork";
			expect(manager.getJob(waitingId)?.queued).toBe(true);

			releases.get(firstId)!.resolve();
			await manager.getJob(firstId)!.promise;
			admission.setPolicy({ mode: "open", maxNewAgents: 1, ttlMs: 60_000 });
			const secondId = await secondStarted.promise;
			expect(secondId).toBe(waitingId);
			releases.get(secondId)!.resolve();
			await manager.getJob(secondId)!.promise;
			expect(starts.sort()).toEqual(["NestedWork", "TopWork"]);
		} finally {
			for (const release of releases.values()) release.resolve();
			admission.setPolicy({ mode: "open", maxNewAgents: 2 });
		}
	});
});
