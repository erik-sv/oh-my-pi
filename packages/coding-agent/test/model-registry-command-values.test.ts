import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function stdoutCommand(value: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(value)})`)}`;
}

describe("ModelRegistry command-resolved models.yml values", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-command-values-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	test("provider apiKey and headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://anthropic-proxy.example.com/v1",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						headers: { "X-Api-Key": `!${stdoutCommand("cmd-header")}` },
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.hasCommandBackedApiKey("anthropic")).toBe(true);
		expect(registry.hasCommandBackedApiKey("openai")).toBe(false);
		const models = registry.getAll().filter(model => model.provider === "anthropic");

		expect(models.length).toBeGreaterThan(1);
		for (const model of models) {
			expect(model.headers?.Authorization).toBe("Bearer cmd-api-key");
			expect(model.headers?.["X-Api-Key"]).toBe("cmd-header");
		}
		expect(await registry.getApiKey(models[0])).toBe("cmd-api-key");
	});

	test("modelOverrides headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
						modelOverrides: {
							"custom-model": { headers: { "X-Model-Key": `!${stdoutCommand("cmd-model-header")}` } },
						},
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");

		expect(model).toBeDefined();
		expect(model?.headers?.["X-Model-Key"]).toBe("cmd-model-header");
		expect(model?.headers?.Authorization).toBe("Bearer cmd-api-key");
	});

	test("provider commands retain provider credentials without inheriting storage, JWT, or control-plane secrets", async () => {
		const poisoned = {
			ANTHROPIC_API_KEY: "ambient-anthropic-key",
			OPENAI_API_KEY: "ambient-openai-key",
			DATABASE_URL: "postgres://ambient-database-secret",
			OMP_SESSION_DB_URL: "postgres://ambient-session-secret",
			OMP_SESSION_DB_OPTIONS: "ambient-session-options",
			JWT_SECRET: "ambient-jwt-secret",
			AGENTDESK_API_KEY: "ambient-agentdesk-secret",
			AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
		};
		const innerScript = `process.stdout.write(JSON.stringify({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, DATABASE_URL: process.env.DATABASE_URL, OMP_SESSION_DB_URL: process.env.OMP_SESSION_DB_URL, OMP_SESSION_DB_OPTIONS: process.env.OMP_SESSION_DB_OPTIONS, JWT_SECRET: process.env.JWT_SECRET, AGENTDESK_API_KEY: process.env.AGENTDESK_API_KEY, AGENTDESK_CONTROL_TOKEN: process.env.AGENTDESK_CONTROL_TOKEN }))`;
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(innerScript)}`;
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"provider-command-env": {
						baseUrl: "https://provider-command.example.com/v1",
						api: "openai-completions",
						apiKey: `!${command}`,
						models: [{ id: "env-probe", name: "Environment Probe" }],
					},
				},
			}),
		);

		const probePath = path.join(tempDir, "provider-command-probe.ts");
		const registryModule = path.join(import.meta.dir, "../src/config/model-registry.ts");
		const authStorageModule = path.join(import.meta.dir, "../src/session/auth-storage.ts");
		fs.writeFileSync(
			probePath,
			[
				`import { ModelRegistry } from ${JSON.stringify(registryModule)};`,
				`import { AuthStorage } from ${JSON.stringify(authStorageModule)};`,
				`const storage = await AuthStorage.create(":memory:");`,
				`try {`,
				`  const registry = new ModelRegistry(storage, ${JSON.stringify(modelsPath)});`,
				`  const model = registry.find("provider-command-env", "env-probe");`,
				`  if (!model) throw new Error("env probe model missing");`,
				`  const value = await registry.getApiKey(model);`,
				`  if (!value) throw new Error("provider command returned no value");`,
				`  process.stdout.write(value);`,
				`} finally { storage.close(); }`,
			].join("\n"),
		);

		const child = Bun.spawn([process.execPath, probePath], {
			env: {
				PATH: Bun.env.PATH ?? "/usr/bin:/bin",
				HOME: Bun.env.HOME ?? tempDir,
				TMPDIR: tempDir,
				...poisoned,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const observed = JSON.parse(stdout) as Record<string, string | undefined>;

		expect(observed.ANTHROPIC_API_KEY).toBe(poisoned.ANTHROPIC_API_KEY);
		expect(observed.OPENAI_API_KEY).toBe(poisoned.OPENAI_API_KEY);
		for (const key of [
			"DATABASE_URL",
			"OMP_SESSION_DB_URL",
			"OMP_SESSION_DB_OPTIONS",
			"JWT_SECRET",
			"AGENTDESK_API_KEY",
			"AGENTDESK_CONTROL_TOKEN",
		]) {
			expect(observed[key], `${key} must not cross the provider command boundary`).toBeUndefined();
		}
	});

	test("expiring command keys renew headers and fail closed until explicit recovery", async () => {
		const keyFile = path.join(tempDir, "employee-key");
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
			`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(keyFile)}, "utf8"))`,
		)}`;
		fs.writeFileSync(keyFile, "first-employee-key");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://employee-proxy.example.com/v1",
						apiKey: `!${command}`,
						apiKeyCacheTtlMs: 60_000,
						authHeader: true,
					},
				},
			}),
		);
		authStorage.set("anthropic", { type: "api_key", key: "stored-key-must-not-escape" });
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			const model = registry.getAll().find(entry => entry.provider === "anthropic")!;
			expect(await registry.getApiKey(model)).toBe("first-employee-key");
			fs.writeFileSync(keyFile, "second-employee-key");
			now += 59_999;
			expect(await registry.getApiKey(model)).toBe("first-employee-key");
			now += 1;
			expect(model.headers?.Authorization).toBe("Bearer second-employee-key");
			expect(await registry.getApiKey(model)).toBe("second-employee-key");
			fs.writeFileSync(keyFile, "");
			now += 60_000;
			expect(await registry.getApiKey(model)).toBeUndefined();
			expect(model.headers?.Authorization).toBeUndefined();
			fs.writeFileSync(keyFile, "recovered-employee-key");
			expect(await registry.getApiKey(model)).toBeUndefined();
			expect(await registry.getApiKeyForProvider("anthropic", undefined, { forceRefresh: true })).toBe(
				"recovered-employee-key",
			);
			expect(model.headers?.Authorization).toBe("Bearer recovered-employee-key");
		} finally {
			clock.mockRestore();
		}
	});

	test("explicit refresh replaces a successful process-cached command key", async () => {
		const keyFile = path.join(tempDir, "refresh-key");
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
			`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(keyFile)}, "utf8"))`,
		)}`;
		fs.writeFileSync(keyFile, "old-key");
		const registry = new ModelRegistry(authStorage, modelsPath);
		registry.registerProvider("command-refresh", {
			baseUrl: "https://refresh.example.com/v1",
			apiKey: `!${command}`,
		});
		expect(await registry.getApiKeyForProvider("command-refresh")).toBe("old-key");
		fs.writeFileSync(keyFile, "new-key");
		expect(await registry.getApiKeyForProvider("command-refresh")).toBe("old-key");
		expect(await registry.getApiKeyForProvider("command-refresh", undefined, { forceRefresh: true })).toBe("new-key");
	});

	test("rejects a command cache lifetime that cannot bound credential age", () => {
		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(() =>
			registry.registerProvider("invalid-command-ttl", {
				baseUrl: "https://refresh.example.com/v1",
				apiKey: `!${stdoutCommand("scoped-key")}`,
				apiKeyCacheTtlMs: 0,
			}),
		).toThrow(Error);
	});

	test("resolveCommandConfig caches failed executions so they do not retry", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "0");

		// Command increments a counter and then fails (exit 1).
		const trackingCommand = `node -e "const fs=require('fs'); fs.writeFileSync('${counterFile.replace(/\\/g, "/")}', String(Number(fs.readFileSync('${counterFile.replace(/\\/g, "/")}', 'utf8')) + 1)); process.exit(1);"`;

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackingCommand}`,
					},
				},
			}),
		);

		// Init triggers the first command resolution.
		const registry = new ModelRegistry(authStorage, modelsPath);

		const dummyModel: Model<Api> = buildModel({
			id: "foo",
			name: "foo",
			api: "openai-completions",
			provider: "custom-proxy",
			baseUrl: "a",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});

		// Trigger the fallback resolver which also calls resolveConfigValue.
		await registry.getApiKey(dummyModel);

		// Another call to ensure it hits cache multiple times.
		await registry.getApiKey(dummyModel);

		// The command should have only run once.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});
});
