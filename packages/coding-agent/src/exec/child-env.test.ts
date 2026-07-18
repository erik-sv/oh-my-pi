import { describe, expect, it } from "bun:test";
import { buildChildEnv } from "./child-env";

const SAFE_PARENT_ENV = {
	PATH: "/usr/local/bin:/usr/bin",
	HOME: "/home/agent",
	LANG: "en_US.UTF-8",
	TMPDIR: "/tmp/agent",
	XDG_CACHE_HOME: "/home/agent/.cache",
	HTTPS_PROXY: "http://proxy.internal:8443",
	NO_PROXY: "localhost,127.0.0.1",
	SSL_CERT_FILE: "/etc/ssl/custom-ca.pem",
	NODE_EXTRA_CA_CERTS: "/etc/ssl/node-ca.pem",
} as const;

const AMBIENT_SECRETS = {
	ANTHROPIC_API_KEY: "anthropic-parent-secret",
	OPENAI_API_KEY: "openai-parent-secret",
	DATABASE_URL: "postgres://storage-parent-secret",
	OMP_SESSION_DB_URL: "postgres://omp-storage-parent-secret",
	AGENTDESK_API_KEY: "agentdesk-parent-secret",
	AGENTDESK_CONTROL_TOKEN: "agentdesk-control-parent-secret",
	JWT_SECRET: "jwt-parent-secret",
	GENERIC_SERVICE_TOKEN: "generic-parent-secret",
	NPM_TOKEN: "npm-parent-secret",
	CUSTOM_CREDENTIAL: "custom-parent-credential",
	INTERNAL_SERVICE_SECRET: "internal-parent-secret",
} as const;

function expectAmbientSecretsAbsent(env: Record<string, string>): void {
	for (const key of Object.keys(AMBIENT_SECRETS)) {
		expect(env[key], `${key} must not cross the child boundary`).toBeUndefined();
	}
}

const ORDINARY_CONTRACTS = [
	"model-child",
	"local-model-worker",
	"untrusted-js",
	"browser-app",
	"ssh-control",
	"network-helper",
	"package-installer",
	"direct-user-shell",
	"shell-snapshot",
	"extension-installer",
	"audio-helper",
	"desktop-helper",
] as const;

describe("buildChildEnv", () => {
	it("gives a model child safe OS, proxy, certificate, and runtime values without ambient secrets", () => {
		const env = buildChildEnv("model-child", {
			parentEnv: {
				...SAFE_PARENT_ENV,
				...AMBIENT_SECRETS,
				UNRELATED_PARENT_SETTING: "not-part-of-the-model-runtime",
			},
		});

		expect(env).toEqual(expect.objectContaining(SAFE_PARENT_ENV));
		expectAmbientSecretsAbsent(env);
		expect(env.UNRELATED_PARENT_SETTING).toBeUndefined();
	});

	it("lets explicit MCP env override inherited values and carry the server's own secret", () => {
		const env = buildChildEnv("mcp-stdio", {
			parentEnv: {
				...SAFE_PARENT_ENV,
				...AMBIENT_SECRETS,
				MCP_SERVER_TOKEN: "ambient-token-must-not-cross",
				MCP_SERVER_MODE: "ambient-mode",
			},
			explicitEnv: {
				MCP_SERVER_TOKEN: "explicit-server-token",
				MCP_SERVER_MODE: "explicit-mode",
			},
		});

		expectAmbientSecretsAbsent(env);
		expect(env.MCP_SERVER_TOKEN).toBe("explicit-server-token");
		expect(env.MCP_SERVER_MODE).toBe("explicit-mode");
	});

	it("folds Windows env names case-insensitively before applying explicit MCP env", () => {
		const env = buildChildEnv("mcp-stdio", {
			platform: "win32",
			parentEnv: {
				Path: "C:\\parent\\bin",
				mcp_server_token: "ambient-token-must-not-cross",
				openai_api_key: "ambient-provider-secret",
			},
			explicitEnv: {
				PATH: "C:\\mcp\\bin",
				MCP_SERVER_TOKEN: "explicit-server-token",
			},
		});

		const paths = Object.entries(env).filter(([key]) => key.toLowerCase() === "path");
		const serverTokens = Object.entries(env).filter(([key]) => key.toLowerCase() === "mcp_server_token");
		expect(paths).toEqual([["PATH", "C:\\mcp\\bin"]]);
		expect(serverTokens).toEqual([["MCP_SERVER_TOKEN", "explicit-server-token"]]);
		expect(Object.keys(env).some(key => key.toLowerCase() === "openai_api_key")).toBe(false);
	});

	it("keeps local-model cache and network configuration while stripping provider credentials", () => {
		const env = buildChildEnv("local-model-worker", {
			parentEnv: {
				...SAFE_PARENT_ENV,
				...AMBIENT_SECRETS,
				HF_HOME: "/models/huggingface",
				HF_HUB_CACHE: "/models/huggingface/hub",
				HUGGINGFACE_HUB_CACHE: "/models/huggingface/legacy-hub",
				TRANSFORMERS_CACHE: "/models/transformers",
				HF_TOKEN: "ambient-huggingface-secret",
			},
		});

		expect(env).toEqual(
			expect.objectContaining({
				HF_HOME: "/models/huggingface",
				HF_HUB_CACHE: "/models/huggingface/hub",
				HUGGINGFACE_HUB_CACHE: "/models/huggingface/legacy-hub",
				TRANSFORMERS_CACHE: "/models/transformers",
				HTTPS_PROXY: SAFE_PARENT_ENV.HTTPS_PROXY,
				SSL_CERT_FILE: SAFE_PARENT_ENV.SSL_CERT_FILE,
			}),
		);
		expectAmbientSecretsAbsent(env);
		expect(env.HF_TOKEN).toBeUndefined();
	});

	it("keeps provider credentials only for a full provider-agent child", () => {
		const env = buildChildEnv("provider-agent-child", {
			parentEnv: {
				...SAFE_PARENT_ENV,
				...AMBIENT_SECRETS,
			},
		});

		expect(env.ANTHROPIC_API_KEY).toBe("anthropic-parent-secret");
		expect(env.OPENAI_API_KEY).toBe("openai-parent-secret");
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.OMP_SESSION_DB_URL).toBeUndefined();
		expect(env.AGENTDESK_API_KEY).toBeUndefined();
		expect(env.AGENTDESK_CONTROL_TOKEN).toBeUndefined();
		expect(env.JWT_SECRET).toBeUndefined();
		expect(env.GENERIC_SERVICE_TOKEN).toBeUndefined();
		expect(env.NPM_TOKEN).toBeUndefined();
		expect(env.CUSTOM_CREDENTIAL).toBeUndefined();
		expect(env.INTERNAL_SERVICE_SECRET).toBeUndefined();
	});

	for (const contract of ORDINARY_CONTRACTS) {
		it(`filters denied patch and explicit values after resolving ${contract} precedence`, () => {
			const env = buildChildEnv(contract, {
				parentEnv: {
					PATH: "/parent/bin",
					HOME: "/parent/home",
					DATABASE_URL: "postgres://parent-secret",
				},
				patches: [
					{
						PATH: "/first-patch/bin",
						HOME: "/first-patch/home",
						DATABASE_URL: "postgres://first-patch-secret",
						NPM_TOKEN: "first-patch-secret",
					},
					{
						HOME: "/last-patch/home",
						DATABASE_URL: "postgres://last-patch-secret",
						CUSTOM_CREDENTIAL: "last-patch-secret",
					},
				],
				explicitEnv: {
					PATH: "/explicit/bin",
					DATABASE_URL: "postgres://explicit-secret",
					INTERNAL_SERVICE_SECRET: "explicit-secret",
				},
			});

			expect(env.PATH, `${contract} explicit safe values must win over patches`).toBe("/explicit/bin");
			expect(env.HOME, `${contract} later safe patches must win over earlier patches`).toBe("/last-patch/home");
			expect(
				["DATABASE_URL", "NPM_TOKEN", "CUSTOM_CREDENTIAL", "INTERNAL_SERVICE_SECRET"].filter(
					key => env[key] !== undefined,
				),
				`${contract} must filter denied values from patches and explicit env`,
			).toEqual([]);
		});
	}

	it("allows provider credentials from provider-agent patches and reviewed explicit env", () => {
		const env = buildChildEnv("provider-agent-child", {
			parentEnv: { PATH: "/usr/bin" },
			patches: {
				OPENAI_API_KEY: "patch-openai-secret",
				ANTHROPIC_API_KEY: "patch-anthropic-secret",
			},
			explicitEnv: {
				ANTHROPIC_API_KEY: "explicit-anthropic-secret",
				CUSTOM_CREDENTIAL: "explicit-reviewed-credential",
			},
		});

		expect(env.OPENAI_API_KEY).toBe("patch-openai-secret");
		expect(env.ANTHROPIC_API_KEY).toBe("explicit-anthropic-secret");
		expect(env.CUSTOM_CREDENTIAL).toBe("explicit-reviewed-credential");
	});

	it.each(["mcp-stdio", "managed-daemon"] as const)(
		"allows reviewed %s explicit secrets but rejects unreviewed secret patches",
		contract => {
			const env = buildChildEnv(contract, {
				parentEnv: { PATH: "/usr/bin" },
				patches: { NPM_TOKEN: "unreviewed-patch-secret" },
				explicitEnv: {
					CUSTOM_CREDENTIAL: `${contract}-configured-credential`,
					INTERNAL_SERVICE_SECRET: `${contract}-configured-secret`,
				},
			});

			expect(env.CUSTOM_CREDENTIAL).toBe(`${contract}-configured-credential`);
			expect(env.INTERNAL_SERVICE_SECRET).toBe(`${contract}-configured-secret`);
			expect(env.NPM_TOKEN, `${contract} patches are not reviewed secret configuration`).toBeUndefined();
		},
	);

	it("allows repo-tool GitHub tokens without admitting other explicit or patched credentials", () => {
		const env = buildChildEnv("repo-tool", {
			parentEnv: { PATH: "/usr/bin" },
			patches: {
				GH_TOKEN: "patched-gh-token",
				NPM_TOKEN: "patched-npm-token",
			},
			explicitEnv: {
				GITHUB_TOKEN: "explicit-github-token",
				CUSTOM_CREDENTIAL: "explicit-custom-credential",
				INTERNAL_SERVICE_SECRET: "explicit-service-secret",
			},
		});

		expect(env.GH_TOKEN).toBe("patched-gh-token");
		expect(env.GITHUB_TOKEN).toBe("explicit-github-token");
		expect(env.NPM_TOKEN).toBeUndefined();
		expect(env.CUSTOM_CREDENTIAL).toBeUndefined();
		expect(env.INTERNAL_SERVICE_SECRET).toBeUndefined();
	});
});
