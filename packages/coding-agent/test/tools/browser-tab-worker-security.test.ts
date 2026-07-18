import { afterEach, describe, expect, it, vi } from "bun:test";
import * as browserLaunch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { acquireTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { Browser, default as Puppeteer } from "puppeteer-core";

const POISONED_ENV = {
	PATH: "/test/bin:/usr/bin",
	HOME: "/test/home",
	ANTHROPIC_API_KEY: "ambient-provider-secret",
	DATABASE_URL: "postgres://ambient-storage-secret",
	JWT_SECRET: "ambient-jwt-secret",
	AGENTDESK_CONTROL_TOKEN: "ambient-agentdesk-secret",
	NPM_TOKEN: "ambient-package-secret",
	CUSTOM_SERVICE_CREDENTIAL: "ambient-custom-secret",
} as const;

const savedEnv = Object.fromEntries(Object.keys(POISONED_ENV).map(key => [key, process.env[key]]));
const testTabNames = new Set<string>();
const originalWorker = globalThis.Worker;

type FakeWorkerListener = (event: MessageEvent | ErrorEvent) => void;

class FakeBrowserTabWorker {
	readonly #listeners = new Map<string, Set<FakeWorkerListener>>();

	constructor(private readonly startup: "ready" | "error") {}

	postMessage(message: WorkerInbound): void {
		if (message.type === "init") {
			queueMicrotask(() => {
				if (this.startup === "error") {
					this.#emit("error", {
						error: new Error("forced isolated Worker startup failure"),
						message: "forced isolated Worker startup failure",
					} as ErrorEvent);
					return;
				}
				this.#emit("message", {
					data: {
						type: "ready",
						info: {
							url: "about:blank",
							title: "Worker tab",
							viewport: { width: 1024, height: 768 },
							targetId: "target-test",
						},
					},
				} as MessageEvent<WorkerOutbound>);
			});
			return;
		}
		if (message.type === "close") {
			queueMicrotask(() => this.#emit("message", { data: { type: "closed" } } as MessageEvent<WorkerOutbound>));
		}
	}

	addEventListener(type: string, listener: FakeWorkerListener): void {
		let listeners = this.#listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: FakeWorkerListener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	terminate(): void {}

	#emit(type: string, event: MessageEvent | ErrorEvent): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

interface CapturedWorkerOptions {
	env?: Record<string, string | undefined>;
}

function installWorker(
	startup: "ready" | "error",
	capture?: (options: CapturedWorkerOptions | undefined) => void,
): void {
	class BrowserWorkerReplacement extends FakeBrowserTabWorker {
		constructor(_entry: string | URL, options?: WorkerOptions) {
			super(startup);
			capture?.(options as unknown as CapturedWorkerOptions | undefined);
		}
	}
	Object.defineProperty(globalThis, "Worker", {
		configurable: true,
		writable: true,
		value: BrowserWorkerReplacement as unknown as typeof Worker,
	});
}

interface FakePage {
	url(): string;
	title(): Promise<string>;
	viewport(): { width: number; height: number };
	target(): FakeTarget;
	on(): void;
	off(): void;
	isClosed(): boolean;
}

interface FakeTarget {
	_targetId: string;
	type(): string;
	page(): Promise<FakePage>;
}

function makeAttachedBrowser(): PuppeteerBrowserHandle {
	let connected = true;
	let target: FakeTarget;
	const page: FakePage = {
		url: () => "about:blank",
		title: async () => "Worker tab",
		viewport: () => ({ width: 1024, height: 768 }),
		target: () => target,
		on: () => undefined,
		off: () => undefined,
		isClosed: () => false,
	};
	target = {
		_targetId: "target-test",
		type: () => "page",
		page: async () => page,
	};
	const browser = {
		get connected() {
			return connected;
		},
		wsEndpoint: () => "ws://127.0.0.1/devtools/browser/test",
		targets: () => [target],
		pages: async () => [page],
		disconnect: () => {
			connected = false;
		},
	} as unknown as Browser;
	return {
		key: "connected:http://127.0.0.1:9222",
		kind: { kind: "connected", cdpUrl: "http://127.0.0.1:9222" },
		refCount: 0,
		browser,
		cdpUrl: "http://127.0.0.1:9222",
		stealth: { browserSession: null, override: null },
	};
}

afterEach(async () => {
	try {
		for (const name of testTabNames) await releaseTab(name, { kill: false }).catch(() => undefined);
		testTabNames.clear();
	} finally {
		vi.restoreAllMocks();
		Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: originalWorker });
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

describe("browser tab Worker isolation", () => {
	it("starts the model-authored JavaScript Worker with an explicit untrusted environment", async () => {
		Object.assign(process.env, POISONED_ENV);
		let workerOptions: CapturedWorkerOptions | undefined;
		installWorker("ready", options => {
			workerOptions = options;
		});
		const browser = makeAttachedBrowser();
		const name = `worker-env-${crypto.randomUUID()}`;
		testTabNames.add(name);

		await acquireTab(name, browser, { timeoutMs: 1_000 });

		const workerEnv = workerOptions?.env;
		expect(workerEnv?.PATH).toBe(POISONED_ENV.PATH);
		expect(workerEnv?.HOME).toBe(POISONED_ENV.HOME);
		for (const key of [
			"ANTHROPIC_API_KEY",
			"DATABASE_URL",
			"JWT_SECRET",
			"AGENTDESK_CONTROL_TOKEN",
			"NPM_TOKEN",
			"CUSTOM_SERVICE_CREDENTIAL",
		]) {
			expect(workerEnv, `${key} must not cross the browser Worker boundary`).not.toHaveProperty(key);
		}
	});

	it("rejects isolated Worker startup failure instead of falling back inline when the parent bears secrets", async () => {
		Object.assign(process.env, POISONED_ENV);
		installWorker("error");
		const browser = makeAttachedBrowser();
		const fakePuppeteer = { connect: async () => browser.browser } as unknown as typeof Puppeteer;
		vi.spyOn(browserLaunch, "loadPuppeteerInWorker").mockResolvedValue(fakePuppeteer);
		const name = `secret-worker-failure-${crypto.randomUUID()}`;
		testTabNames.add(name);

		await expect(acquireTab(name, browser, { timeoutMs: 1_000 })).rejects.toThrow(/inline fallback.*secret/i);
	});
});
