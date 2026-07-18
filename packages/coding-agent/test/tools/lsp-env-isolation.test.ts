import { afterEach, describe, expect, it, vi } from "bun:test";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { type ChildProcess, TempDir } from "@oh-my-pi/pi-utils";

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
}
type ProcessInput = Exclude<NonNullable<Parameters<typeof piUtils.ptree.spawn>[1]>["stdin"], undefined>;

type SpawnCall = {
	cmd: string[];
	options: Parameters<typeof piUtils.ptree.spawn>[1];
};

function installInitializingLsp(calls: SpawnCall[]): void {
	const encoder = new TextEncoder();
	let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let exitCode: number | null = null;
	let pendingBytes = Buffer.alloc(0);
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			stdoutController = controller;
		},
	});
	const send = (message: unknown) => {
		const content = JSON.stringify(message);
		stdoutController?.enqueue(
			encoder.encode(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`),
		);
	};
	const exit = () => {
		if (exitCode !== null) return;
		exitCode = 0;
		stdoutController?.close();
		resolveExited(0);
	};
	const consume = (raw: string | Uint8Array) => {
		const chunk = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
		pendingBytes = pendingBytes.length === 0 ? chunk : Buffer.concat([pendingBytes, chunk]);
		while (true) {
			const headerEnd = pendingBytes.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const lengthMatch = /Content-Length: (\d+)/i.exec(pendingBytes.toString("utf-8", 0, headerEnd));
			if (!lengthMatch) throw new Error("LSP client emitted a frame without Content-Length");
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + Number(lengthMatch[1]);
			if (pendingBytes.length < bodyEnd) return;
			const message = JSON.parse(pendingBytes.toString("utf-8", bodyStart, bodyEnd)) as RpcMessage;
			pendingBytes = pendingBytes.subarray(bodyEnd);
			if (message.method === "exit") {
				exit();
			} else if (message.id !== undefined) {
				send({
					jsonrpc: "2.0",
					id: message.id,
					result: message.method === "initialize" ? { capabilities: {} } : null,
				});
			}
		}
	};
	const proc = {
		pid: 7_001,
		exited,
		get exitCode() {
			return exitCode;
		},
		stdin: {
			write(raw: string | Uint8Array) {
				consume(raw);
				return typeof raw === "string" ? Buffer.byteLength(raw, "utf-8") : raw.byteLength;
			},
			flush: async () => 0,
			end: async () => 0,
		},
		stdout,
		peekStderr: () => "",
		kill: () => {
			exit();
			return true;
		},
	};

	vi.spyOn(piUtils.ptree, "spawn").mockImplementation(
		<In extends ProcessInput = ProcessInput>(
			cmd: string[],
			options?: Parameters<typeof piUtils.ptree.spawn<In>>[1],
		): ChildProcess<In> => {
			calls.push({ cmd: [...cmd], options });
			// ChildProcess has private state. The generic spawn mock therefore needs one assertion around its protocol fake.
			return proc as unknown as ChildProcess<In>;
		},
	);
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

afterEach(async () => {
	await lspClient.shutdownAll();
	vi.restoreAllMocks();
});

describe("LSP child environment isolation", () => {
	it("spawns a direct language server with an explicit sanitized model-child env", async () => {
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
				installInitializingLsp(calls);
				const tempDir = TempDir.createSync("@omp-lsp-env-");
				try {
					const config: ServerConfig = {
						command: "env-isolation-lsp",
						args: ["--stdio"],
						fileTypes: [".ts"],
						rootMarkers: [],
					};
					await lspClient.getOrCreateClient(config, tempDir.path());

					expect(calls).toHaveLength(1);
					expect(calls[0]?.cmd).toEqual(["env-isolation-lsp", "--stdio"]);
					const env = calls[0]?.options?.env as Record<string, string | undefined> | undefined;
					expect(env).toBeDefined();
					expect(env?.HTTPS_PROXY).toBe("http://proxy.internal:8443");
					expect(env?.SSL_CERT_FILE).toBe("/etc/ssl/custom-ca.pem");
					expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
					expect(env?.DATABASE_URL).toBeUndefined();
					expect(env?.AGENTDESK_CONTROL_TOKEN).toBeUndefined();
					expect(env?.JWT_SECRET).toBeUndefined();
				} finally {
					await lspClient.shutdownAll();
					tempDir.removeSync();
				}
			},
		);
	});
});
