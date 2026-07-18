export type ChildEnvContract =
	| "model-child"
	| "mcp-stdio"
	| "local-model-worker"
	| "provider-agent-child"
	| "debug-adapter"
	| "untrusted-js"
	| "browser-app"
	| "ssh-control"
	| "network-helper"
	| "package-installer"
	| "direct-user-shell"
	| "shell-snapshot"
	| "extension-installer"
	| "repo-tool"
	| "audio-helper"
	| "desktop-helper"
	| "managed-daemon";

type Env = Record<string, string | undefined>;

export interface BuildChildEnvOptions {
	parentEnv: Env;
	explicitEnv?: Env;
	patches?: Env | readonly Env[];
	platform?: NodeJS.Platform;
}

const SAFE_NAMES = new Set([
	"PATH",
	"HOME",
	"USER",
	"USERNAME",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LANGUAGE",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"COLORTERM",
	"TMPDIR",
	"TEMP",
	"TMP",
	"TZ",
	"DISPLAY",
	"XAUTHORITY",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"HOMEDRIVE",
	"HOMEPATH",
	"USERPROFILE",
	"USERDOMAIN",
	"COMPUTERNAME",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"SESSIONNAME",
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"VIRTUAL_ENV",
	"PYTHONPATH",
]);
const SAFE_PREFIXES = [
	"LC_",
	"XDG_",
	"NVM_",
	"MISE_",
	"ASDF_",
	"VOLTA_",
	"PYENV_",
	"RBENV_",
	"RUBY",
	"GEM_",
	"BUNDLE",
	"CHRUBY_",
	"JULIA_",
	"OPENBLAS_",
	"MKL_",
	"CARGO_",
	"RUSTUP_",
	"GOPATH",
	"GOROOT",
	"JAVA_HOME",
];
const LOCAL_MODEL_NAMES = new Set([
	"HF_HOME",
	"HF_HUB_CACHE",
	"HUGGINGFACE_HUB_CACHE",
	"TRANSFORMERS_CACHE",
	"TORCH_HOME",
	"XDG_CACHE_HOME",
]);
const PROVIDER_NAMES = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_ENDPOINT",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"MISTRAL_API_KEY",
	"PERPLEXITY_API_KEY",
	"PERPLEXITY_COOKIES",
	"EXA_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"GOOGLE_APPLICATION_CREDENTIALS",
]);
const CONTRACT_NAMES: Partial<Record<ChildEnvContract, readonly string[]>> = {
	"package-installer": ["BUN_BE_BUN", "ONNXRUNTIME_NODE_INSTALL"],
	"repo-tool": [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GPG_TTY",
		"GIT_ASKPASS",
		"GIT_EDITOR",
		"GIT_INDEX_FILE",
		"GIT_OPTIONAL_LOCKS",
		"GIT_TERMINAL_PROMPT",
		"GH_PROMPT_DISABLED",
		"SSH_ASKPASS",
	],
	"audio-helper": ["DBUS_SESSION_BUS_ADDRESS", "PULSE_SERVER", "WAYLAND_DISPLAY"],
	"desktop-helper": ["DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "WSL_DISTRO_NAME", "WSL_INTEROP"],
	"browser-app": ["DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY"],
	"direct-user-shell": ["GH_TOKEN", "GITHUB_TOKEN", "GPG_TTY"],
};
const ALWAYS_DENY =
	/^(?:OMP_SESSION_DB(?:_|$)|DATABASE_URL$|PG(?:PASSWORD|USER|HOST|PORT|DATABASE|SERVICE|SERVICEFILE)$|.*AGENTDESK(?:_|$)|JWT(?:_|$))/i;
const SECRET_SHAPE = /(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

function normalized(key: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? key.toUpperCase() : key;
}

function inheritAllowed(contract: ChildEnvContract, key: string, platform: NodeJS.Platform): boolean {
	const name = normalized(key, platform);
	if (ALWAYS_DENY.test(name)) return false;
	if (CONTRACT_NAMES[contract]?.includes(name)) return true;
	if (contract === "provider-agent-child" && PROVIDER_NAMES.has(name)) return true;
	if (SECRET_SHAPE.test(name)) return false;
	if (SAFE_NAMES.has(name) || SAFE_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
	if (contract === "shell-snapshot" || contract === "direct-user-shell") return true;
	return contract === "local-model-worker" && LOCAL_MODEL_NAMES.has(name);
}

function requiresShellRemoval(key: string, platform: NodeJS.Platform): boolean {
	const name = normalized(key, platform);
	return ALWAYS_DENY.test(name) || PROVIDER_NAMES.has(name) || /^SESSION_(?:SECRET|TOKEN|KEY)$/i.test(name);
}

/** Returns parent variable names excluded by a child environment contract. */
export function getDeniedChildEnvNames(
	contract: ChildEnvContract,
	parentEnv: Env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	return Object.keys(parentEnv).filter(
		key =>
			parentEnv[key] !== undefined &&
			!inheritAllowed(contract, key, platform) &&
			requiresShellRemoval(key, platform),
	);
}

/** Returns true when an environment contains values that cannot cross an untrusted-code isolation boundary. */
export function hasSecretBearingEnv(env: Env): boolean {
	return Object.entries(env).some(
		([key, value]) => value !== undefined && value !== "" && (ALWAYS_DENY.test(key) || SECRET_SHAPE.test(key)),
	);
}

function apply(target: Record<string, string>, source: Env | undefined, platform: NodeJS.Platform): void {
	if (!source) return;
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (platform === "win32") {
			const folded = key.toUpperCase();
			for (const existing of Object.keys(target)) if (existing.toUpperCase() === folded) delete target[existing];
		}
		target[normalized(key, platform) === "PATH" ? "PATH" : key] = value;
	}
}

function applyAllowed(
	target: Record<string, string>,
	source: Env | undefined,
	contract: ChildEnvContract,
	platform: NodeJS.Platform,
): void {
	if (!source) return;
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && inheritAllowed(contract, key, platform)) apply(target, { [key]: value }, platform);
	}
}

/** Builds the complete environment for a security-sensitive child process. */
export function buildChildEnv(contract: ChildEnvContract, options: BuildChildEnvOptions): Record<string, string> {
	const platform = options.platform ?? process.platform;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(options.parentEnv)) {
		if (value !== undefined && inheritAllowed(contract, key, platform)) apply(env, { [key]: value }, platform);
	}
	const patches = options.patches ? (Array.isArray(options.patches) ? options.patches : [options.patches]) : [];
	for (const patch of patches) applyAllowed(env, patch, contract, platform);
	if (["mcp-stdio", "provider-agent-child", "debug-adapter", "managed-daemon"].includes(contract)) {
		apply(env, options.explicitEnv, platform);
	} else {
		applyAllowed(env, options.explicitEnv, contract, platform);
	}
	return env;
}
