import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { DapClient } from "@oh-my-pi/pi-coding-agent/dap/client";
import { DapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
import type { DapCapabilities, DapResolvedAdapter } from "@oh-my-pi/pi-coding-agent/dap/types";
import type { ChildProcess } from "@oh-my-pi/pi-utils";
import * as piUtils from "@oh-my-pi/pi-utils";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "env-test-adapter",
	command: "env-test-adapter",
	args: ["--stdio"],
	resolvedCommand: "env-test-adapter",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
	acceptsDirectoryProgram: false,
};

type ReverseHandler = (args: unknown) => unknown | Promise<unknown>;
type ProcessInput = Exclude<NonNullable<Parameters<typeof piUtils.ptree.spawn>[1]>["stdin"], undefined>;

type SpawnCall = {
	cmd: string[];
	options: Parameters<typeof piUtils.ptree.spawn>[1];
};

function createFakeProcess<In extends ProcessInput = ProcessInput>(pid: number): ChildProcess<In> {
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutController = controller;
		},
	});
	// ChildProcess has private state. The generic spawn mock therefore needs one assertion around its protocol fake.
	return {
		pid,
		exited,
		get exitCode() {
			return exitCode;
		},
		stdin: {
			write: () => 0,
			flush: () => 0,
			end: async () => 0,
		},
		stdout,
		stderr: new ReadableStream<Uint8Array>(),
		peekStderr: () => "",
		kill: () => {
			if (exitCode === null) {
				exitCode = 0;
				stdoutController?.close();
				resolveExited(0);
			}
			return true;
		},
	} as unknown as ChildProcess<In>;
}

class CapturingDapClient {
	readonly proc = createFakeProcess(4_242);
	readonly reverseHandlers = new Map<string, ReverseHandler>();

	constructor(
		readonly adapter: DapResolvedAdapter,
		readonly cwd: string,
	) {}

	async initialize(): Promise<DapCapabilities> {
		return { supportsConfigurationDoneRequest: false };
	}

	async sendRequest(): Promise<unknown> {
		return {};
	}

	waitForEvent(): Promise<unknown> {
		return Promise.reject(new Error("no initial stop event"));
	}

	onEvent(): () => void {
		return () => {};
	}

	onReverseRequest(command: string, handler: ReverseHandler): () => void {
		this.reverseHandlers.set(command, handler);
		return () => this.reverseHandlers.delete(command);
	}

	isAlive(): boolean {
		return true;
	}

	async dispose(): Promise<void> {
		this.proc.kill();
	}
}

async function withParentEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
	const parentEnv = { ...Bun.env, ...values };
	// @ts-expect-error Bun's vi.spyOn runtime supports accessor mocks, but its types omit accessType.
	const envSpy = vi.spyOn(Bun, "env", "get").mockReturnValue(parentEnv);
	try {
		await run();
	} finally {
		envSpy.mockRestore();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DAP child environment isolation", () => {
	it("spawns the debug adapter with an explicit model-child env", async () => {
		await withParentEnv(
			{
				ANTHROPIC_API_KEY: "ambient-provider-secret",
				DATABASE_URL: "postgres://ambient-storage-secret",
				AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
				JWT_SECRET: "ambient-jwt-secret",
				HTTPS_PROXY: "http://proxy.internal:8443",
				SSL_CERT_FILE: "/etc/ssl/custom-ca.pem",
			},
			async () => {
				const calls: SpawnCall[] = [];
				vi.spyOn(piUtils.ptree, "spawn").mockImplementation(
					<In extends ProcessInput = ProcessInput>(
						cmd: string[],
						options?: Parameters<typeof piUtils.ptree.spawn<In>>[1],
					): ChildProcess<In> => {
						calls.push({ cmd: [...cmd], options });
						return createFakeProcess<In>(4_243);
					},
				);

				const client = await DapClient.spawn({ adapter: TEST_ADAPTER, cwd: "/workspace/project" });
				try {
					expect(calls).toHaveLength(1);
					expect(calls[0]?.cmd).toEqual(["env-test-adapter", "--stdio"]);
					const env = calls[0]?.options?.env as Record<string, string | undefined> | undefined;
					expect(env).toBeDefined();
					expect(env?.HTTPS_PROXY).toBe("http://proxy.internal:8443");
					expect(env?.SSL_CERT_FILE).toBe("/etc/ssl/custom-ca.pem");
					expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
					expect(env?.DATABASE_URL).toBeUndefined();
					expect(env?.AGENTDESK_CONTROL_TOKEN).toBeUndefined();
					expect(env?.JWT_SECRET).toBeUndefined();
				} finally {
					await client.dispose();
				}
			},
		);
	});

	it("sanitizes runInTerminal parent env while preserving the adapter's explicit env", async () => {
		await withParentEnv(
			{
				ANTHROPIC_API_KEY: "ambient-provider-secret",
				DATABASE_URL: "postgres://ambient-storage-secret",
				AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
				JWT_SECRET: "ambient-jwt-secret",
				PATH: "/parent/bin",
			},
			async () => {
				const manager = new DapSessionManager();
				const client = new CapturingDapClient(TEST_ADAPTER, "/workspace/project");
				spyOn(DapClient, "spawn").mockResolvedValue(client as unknown as DapClient);
				await manager.launch(
					{ adapter: TEST_ADAPTER, program: "/workspace/project/app", cwd: "/workspace/project" },
					undefined,
					10,
				);

				const calls: SpawnCall[] = [];
				vi.spyOn(piUtils.ptree, "spawn").mockImplementation(
					<In extends ProcessInput = ProcessInput>(
						cmd: string[],
						options?: Parameters<typeof piUtils.ptree.spawn<In>>[1],
					): ChildProcess<In> => {
						calls.push({ cmd: [...cmd], options });
						return createFakeProcess<In>(9_876);
					},
				);

				try {
					const handler = client.reverseHandlers.get("runInTerminal");
					if (!handler) throw new Error("runInTerminal reverse handler was not registered");
					await expect(
						handler({
							args: ["/bin/echo", "hello"],
							cwd: "/workspace/debuggee",
							env: {
								PATH: "/adapter/bin",
								DAP_CHILD_TOKEN: "explicit-debuggee-token",
							},
						}),
					).resolves.toEqual({ processId: 9_876 });

					expect(calls).toHaveLength(1);
					const env = calls[0]?.options?.env as Record<string, string | undefined> | undefined;
					expect(env).toBeDefined();
					expect(env?.PATH).toBe("/adapter/bin");
					expect(env?.DAP_CHILD_TOKEN).toBe("explicit-debuggee-token");
					expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
					expect(env?.DATABASE_URL).toBeUndefined();
					expect(env?.AGENTDESK_CONTROL_TOKEN).toBeUndefined();
					expect(env?.JWT_SECRET).toBeUndefined();
				} finally {
					await manager.terminate();
				}
			},
		);
	});
});
