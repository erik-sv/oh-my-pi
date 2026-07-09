/**
 * Regression guard for PR review feedback on #2190.
 *
 * Subagents inherit the parent's extension source *paths* (a cheap FS scan
 * the parent already paid for), but each session MUST rebuild its own
 * `Extension` instances so factories see the subagent's `ExtensionAPI`
 * (cwd, eventBus, runtime). Forwarding the parent's loaded Extension
 * instances would have tools/handlers/commands close over the parent's
 * `cwd` and event bus — wrong for isolated tasks.
 *
 * Pins down `loadExtensions()` so the SDK can rely on it returning fresh
 * Extension instances per call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

interface ExtensionBinding {
	events: EventBus;
	taskDepth?: number;
}

declare global {
	var __bindings: ExtensionBinding[] | undefined;
	var __lastExtBinding: unknown;
}

describe("loadExtensions per-session binding (#2190 review fix)", () => {
	let tmp: string;
	let extPath: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ext-binding-"));
		extPath = path.join(tmp, "record-cwd.ts");
		authStorage = await AuthStorage.create(path.join(tmp, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		// Factory tags the extension with the cwd + events it was bound to so
		// the test can inspect what closures captured.
		await fs.writeFile(
			extPath,
			[
				"export default function (api) {",
				"  api.registerTool({",
				"    name: 'tag',",
				"    description: 'binding probe',",
				"    params: api.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: '' }] }; },",
				"  });",
				"  Object.defineProperty(globalThis, '__lastExtBinding', {",
				"    value: { cwd: api.exec.toString().includes('cwd') ? api : api, events: api.events },",
				"    writable: true,",
				"    configurable: true,",
				"  });",
				"  globalThis.__bindings = globalThis.__bindings || [];",
				"  const binding = { events: api.events };",
				"  api.on('session_start', (_event, ctx) => { binding.taskDepth = ctx.taskDepth; });",
				"  globalThis.__bindings.push(binding);",
				"}",
			].join("\n"),
		);
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(tmp);
		delete globalThis.__bindings;
		delete globalThis.__lastExtBinding;
	});

	it("creates a distinct Extension and ExtensionAPI per call (fresh eventBus + runtime)", async () => {
		globalThis.__bindings = [];

		const parentEventBus = new EventBus();
		const subagentEventBus = new EventBus();
		expect(parentEventBus).not.toBe(subagentEventBus);

		const parent = await loadExtensions([extPath], "/tmp/parent-cwd", parentEventBus);
		const subagent = await loadExtensions([extPath], "/tmp/subagent-cwd", subagentEventBus);

		expect(parent.errors).toEqual([]);
		expect(subagent.errors).toEqual([]);
		expect(parent.extensions).toHaveLength(1);
		expect(subagent.extensions).toHaveLength(1);

		// Distinct Extension instances — the subagent must never share with parent.
		expect(subagent.extensions[0]).not.toBe(parent.extensions[0]);
		// Distinct ExtensionRuntime instances — flagValues and pendingProviderRegistrations
		// MUST NOT be shared, or per-session flags/registrations bleed across.
		expect(subagent.runtime).not.toBe(parent.runtime);

		// Each factory saw the eventBus passed to its own loadExtensions call.
		const bindings = globalThis.__bindings ?? [];
		expect(bindings).toHaveLength(2);
		expect(bindings[0]?.events).toBe(parentEventBus);
		expect(bindings[1]?.events).toBe(subagentEventBus);
	});

	it("exposes the immutable task depth to each session's extension context", async () => {
		globalThis.__bindings = [];

		const parent = await loadExtensions([extPath], "/tmp/parent-cwd", new EventBus());
		const subagent = await loadExtensions([extPath], "/tmp/subagent-cwd", new EventBus());
		expect(parent.errors).toEqual([]);
		expect(subagent.errors).toEqual([]);

		const parentRunner = new ExtensionRunner(
			parent.extensions,
			parent.runtime,
			"/tmp/parent-cwd",
			SessionManager.inMemory(),
			modelRegistry,
			undefined,
			undefined,
			0,
		);
		const subagentRunner = new ExtensionRunner(
			subagent.extensions,
			subagent.runtime,
			"/tmp/subagent-cwd",
			SessionManager.inMemory(),
			modelRegistry,
			undefined,
			undefined,
			2,
		);

		await parentRunner.emit({ type: "session_start" });
		await subagentRunner.emit({ type: "session_start" });

		expect(globalThis.__bindings?.map(binding => binding.taskDepth)).toEqual([0, 2]);
	});
});
