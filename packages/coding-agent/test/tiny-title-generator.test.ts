import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isSubcommand } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { getDefault, getEnumValues, getUi } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { TinyTitleDownloadProgressComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tiny-title-download-progress";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "@oh-my-pi/pi-coding-agent/tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "@oh-my-pi/pi-coding-agent/tiny/dtype";
import {
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "@oh-my-pi/pi-coding-agent/tiny/models";
import { createTinyTitleSubprocess, tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import type { Subprocess } from "bun";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>, tinyModel: string) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return tinyModel;
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	} as never;
}

type TinyWorkerSpawnOptions = Bun.SpawnOptions.SpawnOptions<"ignore", "ignore", "ignore">;

type TinyWorkerSpawnCall = {
	options: TinyWorkerSpawnOptions & { cmd: string[] };
};

function createTinyWorkerSpawnMock(calls: TinyWorkerSpawnCall[]) {
	function mockSpawn(options: TinyWorkerSpawnOptions & { cmd: string[] }): Subprocess<"ignore", "ignore", "ignore">;
	function mockSpawn(cmd: string[], options?: TinyWorkerSpawnOptions): Subprocess<"ignore", "ignore", "ignore">;
	function mockSpawn(
		first: string[] | (TinyWorkerSpawnOptions & { cmd: string[] }),
		second?: TinyWorkerSpawnOptions,
	): Subprocess<"ignore", "ignore", "ignore"> {
		const options = Array.isArray(first) ? { ...(second ?? {}), cmd: first } : first;
		calls.push({ options });
		return {
			pid: 12345,
			send: () => undefined,
			kill: () => true,
			unref: () => undefined,
			exited: Promise.resolve(0),
		} as unknown as Subprocess<"ignore", "ignore", "ignore">;
	}

	return mockSpawn;
}

function mockOnlineTitle(title: string | null) {
	return vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: title ? [{ type: "text", text: `<title>${title}</title>` }] : [{ type: "text", text: "" }],
	} as never);
}

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("tiny title generator routing", () => {
	it("keeps online-only behavior when Tiny Model is Online", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "online"),
		);

		expect(title).toBe("Online Title");
		expect(local).not.toHaveBeenCalled();
		expect(online).toHaveBeenCalledTimes(1);
	});

	it("uses the local client for selected local models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		expect(title).toBe("Local Title");
		expect(local).toHaveBeenCalledWith("lfm2-350m", "Investigate routing");
		expect(online).not.toHaveBeenCalled();
	});

	it("passes the resolved TITLE_SYSTEM.md prompt to the local client", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		expect(title).toBe("Local Title");
		expect(local).toHaveBeenCalledWith("lfm2-350m", "Investigate routing", { systemPrompt: customPrompt });
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT fall back to online when local returns null (issue #3187)", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue(null);
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate fallback",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		expect(title).toBeNull();
		expect(local).toHaveBeenCalledTimes(1);
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT fall back to online when local throws", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(tinyTitleClient, "generate").mockRejectedValue(new Error("worker crashed"));
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate crash",
			createRegistry(model),
			createSettings(model, "lfm2-700m"),
		);

		expect(title).toBeNull();
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT call the local worker or online path for an unknown tinyModel key", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Late Local");
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate unknown",
			createRegistry(model),
			createSettings(model, "ollama:gpt-oss"),
		);

		expect(title).toBeNull();
		expect(local).not.toHaveBeenCalled();
		expect(online).not.toHaveBeenCalled();
	});
});

describe("tiny title subprocess", () => {
	it("does not inherit worker output into the interactive terminal", async () => {
		const calls: TinyWorkerSpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createTinyWorkerSpawnMock(calls));

		const worker = createTinyTitleSubprocess();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.stdout).toBe("ignore");
		expect(calls[0]?.options.stderr).not.toBe("inherit");
		expect(calls[0]?.options.stderr).not.toBe("pipe");
		await worker.proc.exited;
	});
	it("passes the local-model worker cache and network env without ambient credentials", async () => {
		const inherited = {
			ANTHROPIC_API_KEY: "ambient-provider-secret",
			OPENAI_API_KEY: "ambient-provider-secret",
			DATABASE_URL: "postgres://ambient-storage-secret",
			AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
			JWT_SECRET: "ambient-jwt-secret",
			HF_TOKEN: "ambient-huggingface-secret",
			HF_HOME: "/models/huggingface",
			HF_HUB_CACHE: "/models/huggingface/hub",
			TRANSFORMERS_CACHE: "/models/transformers",
			XDG_CACHE_HOME: "/cache/xdg",
			HTTPS_PROXY: "http://proxy.internal:8443",
			SSL_CERT_FILE: "/etc/ssl/custom-ca.pem",
		};
		const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, Bun.env[key]]));
		for (const [key, value] of Object.entries(inherited)) Bun.env[key] = value;
		const calls: TinyWorkerSpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createTinyWorkerSpawnMock(calls));

		try {
			const worker = createTinyTitleSubprocess();
			expect(calls).toHaveLength(1);
			const env = calls[0]?.options.env as Record<string, string | undefined> | undefined;
			expect(env).toBeDefined();
			expect(env?.HF_HOME).toBe("/models/huggingface");
			expect(env?.HF_HUB_CACHE).toBe("/models/huggingface/hub");
			expect(env?.TRANSFORMERS_CACHE).toBe("/models/transformers");
			expect(env?.XDG_CACHE_HOME).toBe("/cache/xdg");
			expect(env?.HTTPS_PROXY).toBe("http://proxy.internal:8443");
			expect(env?.SSL_CERT_FILE).toBe("/etc/ssl/custom-ca.pem");
			expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
			expect(env?.OPENAI_API_KEY).toBeUndefined();
			expect(env?.DATABASE_URL).toBeUndefined();
			expect(env?.AGENTDESK_CONTROL_TOKEN).toBeUndefined();
			expect(env?.JWT_SECRET).toBeUndefined();
			expect(env?.HF_TOKEN).toBeUndefined();
			await worker.proc.exited;
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});
});

describe("providers.tinyModel schema", () => {
	it("keeps enum values and UI options in sync with the tiny model registry", () => {
		expect(getEnumValues("providers.tinyModel")).toEqual([...TINY_TITLE_MODEL_VALUES]);
		expect(getUi("providers.tinyModel")?.options).toEqual(TINY_TITLE_MODEL_OPTIONS);
		expect(getDefault("providers.tinyModel")).toBe(ONLINE_TINY_TITLE_MODEL_KEY);
	});
});

describe("tiny model acceleration schema", () => {
	it("keeps the device setting in sync with the device module constants", () => {
		expect(getEnumValues("providers.tinyModelDevice")).toEqual([...TINY_MODEL_DEVICE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDevice")?.options).toEqual(TINY_MODEL_DEVICE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDevice")).toBe(TINY_MODEL_DEVICE_DEFAULT);
	});

	it("keeps the precision setting in sync with the dtype module constants", () => {
		expect(getEnumValues("providers.tinyModelDtype")).toEqual([...TINY_MODEL_DTYPE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDtype")?.options).toEqual(TINY_MODEL_DTYPE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDtype")).toBe(TINY_MODEL_DTYPE_DEFAULT);
	});
});

describe("tiny title download progress UI", () => {
	it("renders progress updates and completion state", () => {
		const component = new TinyTitleDownloadProgressComponent("lfm2-700m");
		component.update({
			modelKey: "lfm2-700m",
			status: "progress_total",
			name: "onnx-community/LFM2-700M-ONNX",
			progress: 50,
			loaded: 50,
			total: 100,
			files: {},
		});
		expect(component.render(80).join("\n")).toContain("LFM2 700M");
		expect(component.isComplete()).toBe(false);
		component.update({ modelKey: "lfm2-700m", status: "ready", task: "text-generation", model: "repo" });
		expect(component.isComplete()).toBe(true);
	});
});

describe("tiny-models CLI", () => {
	it("registers tiny-models as a top-level subcommand", () => {
		expect(isSubcommand("tiny-models")).toBe(true);
	});
});
