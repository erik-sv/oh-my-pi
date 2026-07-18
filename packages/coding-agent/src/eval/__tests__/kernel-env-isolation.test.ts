import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../config/settings";
import { JuliaKernel } from "../jl/kernel";
import type { KernelShutdownResult, KernelStartOptions } from "../kernel-base";
import { PythonKernel } from "../py/kernel";
import { RubyKernel } from "../rb/kernel";

interface StartedKernel {
	shutdown(): Promise<KernelShutdownResult>;
}

type KernelStarter = (options: KernelStartOptions) => Promise<StartedKernel>;

type KernelSpawnOptions = Bun.SpawnOptions.SpawnOptions<"pipe", "pipe", "pipe">;

function createFailingKernelProcess(): Bun.Subprocess<"pipe", "pipe", "pipe"> {
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const finish = () => {
		if (exitCode !== null) return;
		exitCode = 1;
		stdoutController?.close();
		stderrController?.close();
		resolveExited(1);
	};
	return {
		pid: 6_001,
		exited,
		get exitCode() {
			return exitCode;
		},
		stdin: {
			write(raw: string | Uint8Array) {
				queueMicrotask(finish);
				return typeof raw === "string" ? Buffer.byteLength(raw, "utf-8") : raw.byteLength;
			},
			flush: async () => 0,
			end: async () => 0,
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				stdoutController = controller;
			},
		}),
		stderr: new ReadableStream<Uint8Array>({
			start(controller) {
				stderrController = controller;
			},
		}),
		kill: () => {
			finish();
			return true;
		},
	} as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
}

async function expectSanitizedKernelSpawn(start: KernelStarter, interpreter: string): Promise<void> {
	vi.spyOn(Settings, "init").mockResolvedValue({
		getShellConfig: () => ({
			env: {
				PATH: "/usr/local/bin:/usr/bin",
				HOME: "/home/agent",
				LANG: "en_US.UTF-8",
				XDG_CACHE_HOME: "/home/agent/.cache",
				HTTPS_PROXY: "http://proxy.internal:8443",
				SSL_CERT_FILE: "/etc/ssl/custom-ca.pem",
				ANTHROPIC_API_KEY: "ambient-provider-secret",
				DATABASE_URL: "postgres://ambient-storage-secret",
				AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
				JWT_SECRET: "ambient-jwt-secret",
				PI_AGENTDESK_TOKEN: "ambient-prefixed-control-secret",
			},
		}),
	} as unknown as Settings);

	const calls: Array<{ cmd: string[]; options?: KernelSpawnOptions }> = [];
	vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: KernelSpawnOptions) => {
		calls.push({ cmd: [...cmd], options });
		return createFailingKernelProcess();
	}) as typeof Bun.spawn);

	const outcome = await start({
		cwd: process.cwd(),
		interpreter,
		env: {
			PI_TOOL_BRIDGE_URL: "http://127.0.0.1:43123",
			PI_TOOL_BRIDGE_TOKEN: "explicit-kernel-bridge-token",
		},
	}).then(
		kernel => ({ kernel }),
		(error: unknown) => ({ error }),
	);
	if ("kernel" in outcome) await outcome.kernel.shutdown();

	if (calls.length === 0 && "error" in outcome) throw outcome.error;
	expect(calls).toHaveLength(1);
	const env = calls[0]?.options?.env as Record<string, string | undefined> | undefined;
	expect(env).toBeDefined();
	expect(env?.PATH).toBe("/usr/local/bin:/usr/bin");
	expect(env?.HOME).toBe("/home/agent");
	expect(env?.HTTPS_PROXY).toBe("http://proxy.internal:8443");
	expect(env?.SSL_CERT_FILE).toBe("/etc/ssl/custom-ca.pem");
	expect(env?.PI_TOOL_BRIDGE_URL).toBe("http://127.0.0.1:43123");
	expect(env?.PI_TOOL_BRIDGE_TOKEN).toBe("explicit-kernel-bridge-token");
	expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
	expect(env?.DATABASE_URL).toBeUndefined();
	expect(env?.AGENTDESK_CONTROL_TOKEN).toBeUndefined();
	expect(env?.JWT_SECRET).toBeUndefined();
	expect(env?.PI_AGENTDESK_TOKEN).toBeUndefined();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("eval kernel child environment isolation", () => {
	it("passes an explicit sanitized env to the Python kernel", async () => {
		await expectSanitizedKernelSpawn(options => PythonKernel.start(options), "/runtime/python");
	});

	it("passes an explicit sanitized env to the Ruby kernel", async () => {
		await expectSanitizedKernelSpawn(options => RubyKernel.start(options), "/runtime/ruby");
	});

	it("passes an explicit sanitized env to the Julia kernel", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-julia-env-probe-"));
		const interpreter = path.join(tempDir, process.platform === "win32" ? "julia.cmd" : "julia");
		fs.writeFileSync(interpreter, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
		if (process.platform !== "win32") fs.chmodSync(interpreter, 0o755);
		try {
			await expectSanitizedKernelSpawn(options => JuliaKernel.start(options), interpreter);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
