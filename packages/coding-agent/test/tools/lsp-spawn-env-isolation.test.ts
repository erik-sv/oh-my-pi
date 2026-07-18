import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { BiomeClient, SwiftLintClient } from "@oh-my-pi/pi-coding-agent/lsp/clients";
import { detectLspmux } from "@oh-my-pi/pi-coding-agent/lsp/lspmux";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

type BunSpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

interface BunSpawnCall {
	cmd: string[];
	options?: BunSpawnOptions;
}

interface BunSpawnOutput {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

const CHILD_PATH = "/opt/omp-env-test/bin:/usr/bin";
const AMBIENT_SECRET_KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"DATABASE_URL",
	"OMP_SESSION_DB_URL",
	"JWT_SECRET",
	"AGENTDESK_CONTROL_TOKEN",
] as const;

function textStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) throw new Error("Failed to create text stream");
	return body;
}

function completedProcess(stdout = "", stderr = "", exitCode = 0): Subprocess {
	return {
		pid: 12_345,
		stdout: textStream(stdout),
		stderr: textStream(stderr),
		exited: Promise.resolve(exitCode),
		kill: () => true,
	} as unknown as Subprocess;
}

function recordBunSpawn(calls: BunSpawnCall[], outputForCommand: (cmd: string[]) => BunSpawnOutput = () => ({})): void {
	vi.spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: BunSpawnOptions) => {
		const recordedCmd = [...cmd];
		calls.push({ cmd: recordedCmd, options });
		const output = outputForCommand(recordedCmd);
		return completedProcess(output.stdout, output.stderr, output.exitCode);
	}) as typeof Bun.spawn);
}

async function withAmbientSecrets(run: () => Promise<void>): Promise<void> {
	const poisonedEnv: Record<string, string> = {
		PATH: CHILD_PATH,
		OPENAI_API_KEY: "ambient-openai-secret",
		ANTHROPIC_API_KEY: "ambient-anthropic-secret",
		DATABASE_URL: "postgres://ambient-database-secret",
		OMP_SESSION_DB_URL: "postgres://ambient-session-secret",
		JWT_SECRET: "ambient-jwt-secret",
		AGENTDESK_CONTROL_TOKEN: "ambient-agentdesk-secret",
	};
	const parentEnv = { ...Bun.env, ...poisonedEnv };
	delete parentEnv.PI_DISABLE_LSPMUX;
	// @ts-expect-error Bun's vi.spyOn runtime supports accessor mocks, but its types omit accessType.
	const envSpy = vi.spyOn(Bun, "env", "get").mockReturnValue(parentEnv);
	try {
		await run();
	} finally {
		envSpy.mockRestore();
	}
}

function expectSanitizedChildEnv(options: BunSpawnOptions | undefined): void {
	const env = options?.env as Record<string, string | undefined> | undefined;
	expect(env).toBeDefined();
	expect(env?.PATH).toBe(CHILD_PATH);
	for (const key of AMBIENT_SECRET_KEYS) expect(env).not.toHaveProperty(key);
}

async function captureGoWorkspaceDiagnosticsSpawns(): Promise<BunSpawnCall[]> {
	const tempDir = TempDir.createSync("@omp-lsp-go-env-");
	const calls: BunSpawnCall[] = [];
	recordBunSpawn(calls, cmd => {
		if (cmd.join("\0") === "go\0work\0edit\0-json") {
			return { stdout: JSON.stringify({ Use: [{ DiskPath: "./service" }] }) };
		}
		return {};
	});

	try {
		const serviceDir = path.join(tempDir.path(), "service");
		await fs.promises.mkdir(serviceDir, { recursive: true });
		await Bun.write(path.join(tempDir.path(), "go.work"), "go 1.22\n\nuse ./service\n");
		await Bun.write(path.join(serviceDir, "go.mod"), "module example.com/service\n\ngo 1.22\n");
		const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
		await tool.execute("go-work-env", { action: "diagnostics", file: "*" });
		return calls;
	} finally {
		tempDir.removeSync();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LSP helper child environment isolation", () => {
	it("sanitizes the Go workspace command-resolution child", async () => {
		await withAmbientSecrets(async () => {
			const calls = await captureGoWorkspaceDiagnosticsSpawns();
			const goWork = calls.find(call => call.cmd.join("\0") === "go\0work\0edit\0-json");
			expect(goWork).toBeDefined();
			expectSanitizedChildEnv(goWork?.options);
		});
	});

	it("sanitizes the Go workspace diagnostics child", async () => {
		await withAmbientSecrets(async () => {
			const calls = await captureGoWorkspaceDiagnosticsSpawns();
			const goBuild = calls.find(call => call.cmd[0] === "go" && call.cmd[1] === "build");
			expect(goBuild).toBeDefined();
			expectSanitizedChildEnv(goBuild?.options);
		});
	});

	it("sanitizes the lspmux status child", async () => {
		await withAmbientSecrets(async () => {
			const calls: BunSpawnCall[] = [];
			let lspmuxPath: string | null = null;
			vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "lspmux" ? lspmuxPath : null));
			recordBunSpawn(calls);
			await detectLspmux();
			lspmuxPath = "/opt/omp-env-test/bin/lspmux";

			const state = await detectLspmux();
			expect(state.running).toBe(true);
			const status = calls.find(call => call.cmd.join("\0") === "/opt/omp-env-test/bin/lspmux\0status");
			expect(status).toBeDefined();
			expectSanitizedChildEnv(status?.options);
		});
	});

	it("sanitizes the Biome CLI child", async () => {
		await withAmbientSecrets(async () => {
			const tempDir = TempDir.createSync("@omp-biome-env-");
			const calls: BunSpawnCall[] = [];
			recordBunSpawn(calls, () => ({ stdout: JSON.stringify({ diagnostics: [] }) }));
			try {
				const config: ServerConfig = {
					command: "biome",
					resolvedCommand: "/opt/omp-env-test/bin/biome",
					fileTypes: [".ts"],
					rootMarkers: [],
				};
				const filePath = path.join(tempDir.path(), "input.ts");
				const diagnostics = await new BiomeClient(config, tempDir.path()).lint(filePath);
				expect(diagnostics).toEqual([]);
				const biome = calls.find(call => call.cmd[0] === config.resolvedCommand);
				expect(biome).toBeDefined();
				expectSanitizedChildEnv(biome?.options);
			} finally {
				tempDir.removeSync();
			}
		});
	});

	it("sanitizes the SwiftLint CLI child", async () => {
		await withAmbientSecrets(async () => {
			const tempDir = TempDir.createSync("@omp-swiftlint-env-");
			const calls: BunSpawnCall[] = [];
			recordBunSpawn(calls, () => ({ stdout: "[]" }));
			try {
				const config: ServerConfig = {
					command: "swiftlint",
					resolvedCommand: "/opt/omp-env-test/bin/swiftlint",
					fileTypes: [".swift"],
					rootMarkers: [],
				};
				const filePath = path.join(tempDir.path(), "Input.swift");
				const diagnostics = await new SwiftLintClient(config, tempDir.path()).lint(filePath);
				expect(diagnostics).toEqual([]);
				const swiftlint = calls.find(call => call.cmd[0] === config.resolvedCommand);
				expect(swiftlint).toBeDefined();
				expectSanitizedChildEnv(swiftlint?.options);
			} finally {
				tempDir.removeSync();
			}
		});
	});
});
