import { afterEach, describe, expect, it, vi } from "bun:test";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import * as piUtils from "@oh-my-pi/pi-utils";

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

function createReadyRpcProcess(): piUtils.ptree.ChildProcess {
	const encoder = new TextEncoder();
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutController = controller;
			controller.enqueue(encoder.encode('{"type":"ready"}\n'));
		},
	});
	return {
		pid: 8_001,
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
		peekStderr: () => "",
		kill: () => {
			if (exitCode === null) {
				exitCode = 0;
				stdoutController?.close();
				resolveExited(0);
			}
			return true;
		},
	} as unknown as piUtils.ptree.ChildProcess;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RpcClient provider-agent child environment", () => {
	it("keeps ambient provider credentials while isolating storage, control-plane, JWT, and generic service secrets", async () => {
		await withParentEnv(
			{
				ANTHROPIC_API_KEY: "ambient-anthropic-key",
				OPENAI_API_KEY: "ambient-openai-key",
				DATABASE_URL: "postgres://ambient-storage-secret",
				OMP_SESSION_DB_URL: "postgres://ambient-omp-storage-secret",
				AGENTDESK_API_KEY: "ambient-agentdesk-secret",
				AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
				JWT_SECRET: "ambient-jwt-secret",
				GENERIC_SERVICE_TOKEN: "ambient-generic-secret",
				HTTPS_PROXY: "http://proxy.internal:8443",
			},
			async () => {
				let spawnOptions: Parameters<typeof piUtils.ptree.spawn>[1];
				vi.spyOn(piUtils.ptree, "spawn").mockImplementation((_cmd, options) => {
					spawnOptions = options;
					return createReadyRpcProcess();
				});
				const client = new RpcClient({
					cliPath: "/workspace/mock-cli.ts",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					env: { RPC_EXPLICIT_SETTING: "configured" },
				});

				try {
					await client.start();
					const env = spawnOptions?.env as Record<string, string | undefined> | undefined;
					expect(env).toBeDefined();
					expect(env?.ANTHROPIC_API_KEY).toBe("ambient-anthropic-key");
					expect(env?.OPENAI_API_KEY).toBe("ambient-openai-key");
					expect(env?.HTTPS_PROXY).toBe("http://proxy.internal:8443");
					expect(env?.RPC_EXPLICIT_SETTING).toBe("configured");
					expect(env?.DATABASE_URL).toBeUndefined();
					expect(env?.OMP_SESSION_DB_URL).toBeUndefined();
					expect(env?.AGENTDESK_API_KEY).toBeUndefined();
					expect(env?.AGENTDESK_CONTROL_TOKEN).toBeUndefined();
					expect(env?.JWT_SECRET).toBeUndefined();
					expect(env?.GENERIC_SERVICE_TOKEN).toBeUndefined();
				} finally {
					client.stop();
				}
			},
		);
	});
});
