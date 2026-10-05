import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "../../config/settings";
import type { CreateAgentSessionOptions } from "../../sdk";

export const AGENTDESK_RESTRICTED_RPC_PROFILE = "agentdesk_restricted_rpc_v1" as const;
export type RestrictedRpcHostProfile = typeof AGENTDESK_RESTRICTED_RPC_PROFILE;
const EMPTY_SHA256 = Bun.SHA256.hash("", "hex");
const RESTRICTED_EMPTY_INPUT_NAMES = [
	"toolNames",
	"contextFiles",
	"promptTemplates",
	"slashCommands",
	"skills",
	"rules",
	"additionalDirectories",
] as const;

function emptyRestrictedInputs(): Record<(typeof RESTRICTED_EMPTY_INPUT_NAMES)[number], never[]> {
	return Object.fromEntries(RESTRICTED_EMPTY_INPUT_NAMES.map(name => [name, []])) as Record<
		(typeof RESTRICTED_EMPTY_INPUT_NAMES)[number],
		never[]
	>;
}

export function restrictedDiscoveryOptions() {
	return {
		...emptyRestrictedInputs(),
		disableExtensionDiscovery: true,
		restrictToolNames: true,
		allowRestrictedCustomTools: false,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
	};
}

export interface RestrictedEngineeringDatabaseReceipt {
	databaseInstanceUuid: string;
	database: string;
	currentUser: string;
	grantDigest: string;
	contractName: "agentdesk_restricted_rpc";
	contractVersion: 1;
	contractDigest: string;
	structuralValidatorDigest: string;
}

export interface RestrictedProfileRuntime {
	profile: RestrictedRpcHostProfile;
	canonicalCwd: string;
	profileDigest: string;
	databaseReceipt: RestrictedEngineeringDatabaseReceipt;
}

export interface RestrictedProfileReceipt {
	receiptVersion: "agentdesk-restricted-profile-receipt-v1";
	profile: RestrictedRpcHostProfile;
	profileDigest: string;
	promptInputs: Array<{ name: string; digest: string; items: string[] } | { name: string; disabled: true }>;
	systemPromptSegments: Array<{ name: string; digest: string }>;
	processStartEvidence: {
		mcp: false;
		extension: false;
		lsp: false;
		irc: false;
		advisor: false;
		watchdog: false;
		task: false;
	};
	tools: Array<{
		name: string;
		description: string;
		parameters: unknown;
		loadMode: ToolLoadMode;
		activePresentation: "hidden" | "essential" | "discoverable";
	}>;
	modelTransport: {
		provider: string;
		modelId: string;
		apiProtocol: string;
		approvedBaseUrlOriginIdentifier: string;
		requestModelId: string;
		credentialIdentityClass: "provider_credential" | "gateway_bearer";
	} | null;
	engineeringDatabase: RestrictedEngineeringDatabaseReceipt;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
		return result;
	}
	return value;
}

export function canonicalRestrictedJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function restrictedSha256(value: string | Uint8Array): string {
	return Bun.SHA256.hash(value, "hex");
}

export const RESTRICTED_PROMPT_MANIFEST_VERSION = "agentdesk-restricted-prompt-manifest-v1" as const;
export const RESTRICTED_PROMPT_SEGMENT_BYTES = [
	{
		id: "agentdesk-restricted-authority-v1",
		role: "system",
		content:
			"You are an autonomous engineering role running in the AgentDesk restricted RPC host profile. Authority comes only from the accepted user turn and the dynamically registered RPC host tools.",
	},
	{
		id: "agentdesk-restricted-execution-v1",
		role: "system",
		content:
			"Follow the accepted turn exactly. Use only the registered host tools. Do not infer authority beyond their schemas and results. Finish one turn, then stop.",
	},
] as const;

const restrictedPromptManifestMaterial = {
	manifestVersion: RESTRICTED_PROMPT_MANIFEST_VERSION,
	segments: RESTRICTED_PROMPT_SEGMENT_BYTES.map(segment => ({
		id: segment.id,
		role: segment.role,
		content: segment.content,
		contentDigest: restrictedSha256(segment.content),
	})),
};
export const RESTRICTED_PROMPT_MANIFEST_CANONICAL_JSON = canonicalRestrictedJson(restrictedPromptManifestMaterial);
export const RESTRICTED_PROMPT_MANIFEST_DIGEST = restrictedSha256(RESTRICTED_PROMPT_MANIFEST_CANONICAL_JSON);
export const RESTRICTED_PROMPT_MANIFEST = {
	...restrictedPromptManifestMaterial,
	manifestDigest: RESTRICTED_PROMPT_MANIFEST_DIGEST,
} as const;

/** Refuse any content mutation, insertion, deletion, or reordering before RPC starts. */
export function assertRestrictedPromptSegments(actual: readonly string[]): void {
	if (actual.length !== RESTRICTED_PROMPT_SEGMENT_BYTES.length) {
		throw new Error("Restricted prompt segment count does not match the frozen manifest");
	}
	for (let index = 0; index < RESTRICTED_PROMPT_SEGMENT_BYTES.length; index++) {
		const expected = RESTRICTED_PROMPT_SEGMENT_BYTES[index];
		if (!expected || actual[index] !== expected.content) {
			throw new Error(`Restricted prompt segment ${index} does not match the frozen manifest`);
		}
	}
}

function canonicalCwd(cwd: string | undefined): string {
	return fs.realpathSync.native(path.resolve(cwd ?? process.cwd()));
}

/** Apply the versioned profile before any SDK discovery can observe caller input. */
export function applyRestrictedRpcHostProfile(options: CreateAgentSessionOptions): {
	options: CreateAgentSessionOptions;
	runtime: Omit<RestrictedProfileRuntime, "databaseReceipt">;
} {
	const cwd = canonicalCwd(options.cwd);
	const workspaceTree = { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };
	const fixed = {
		...emptyRestrictedInputs(),
		workspaceTree,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLSP: false,
		enableIRC: false,
		allowRestrictedCustomTools: false,
		restrictToolNames: true,
		memory: false,
		advisor: false,
		task: false,
		watchdog: false,
		projectConfig: false,
		projectModelOverride: false,
		globalModelOverride: false,
		sessionImportedInstructions: false,
		promptManifestDigest: RESTRICTED_PROMPT_MANIFEST_DIGEST,
	};
	const isolatedSettings = Settings.isolated();
	isolatedSettings.override("advisor.enabled", false);
	isolatedSettings.override("includeWorkspaceTree", false);
	isolatedSettings.override("goal.enabled", false);
	isolatedSettings.override("plan.enabled", false);
	isolatedSettings.override("autolearn.enabled", false);
	isolatedSettings.override("autoResume", false);
	return {
		options: {
			...options,
			cwd,
			restrictedRpcHostProfile: AGENTDESK_RESTRICTED_RPC_PROFILE,
			authStorage: options.authStorage ?? options.modelRegistry?.authStorage,
			modelRegistry: undefined,
			...restrictedDiscoveryOptions(),
			workspaceTree,
			additionalExtensionPaths: [],
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
			preloadedExtensions: undefined,
			extensions: [],
			customTools: [],
			mcpManager: undefined,
			lspReadOnly: true,
			requireYieldTool: false,
			spawns: "",
			skipPythonPreflight: true,
			systemPrompt: RESTRICTED_PROMPT_SEGMENT_BYTES.map(segment => segment.content),
			customSystemPrompt: undefined,
			appendSystemPrompt: undefined,
			titleSystemPrompt: undefined,
			settings: isolatedSettings,
			settingsManager: undefined,
			hasUI: false,
			interactivePrompts: false,
		},
		runtime: {
			profile: AGENTDESK_RESTRICTED_RPC_PROFILE,
			canonicalCwd: cwd,
			profileDigest: restrictedSha256(canonicalRestrictedJson(fixed)),
		},
	};
}

function originIdentifier(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (url.username || url.password) throw new Error("Restricted model base URL must not contain credentials");
	return url.origin;
}

function modelReceipt(model: Model | undefined): RestrictedProfileReceipt["modelTransport"] {
	if (!model) return null;
	return {
		provider: model.provider,
		modelId: model.id,
		apiProtocol: model.api,
		approvedBaseUrlOriginIdentifier: originIdentifier(model.baseUrl),
		requestModelId: model.requestModelId ?? model.id,
		credentialIdentityClass: model.transport === "pi-native" ? "gateway_bearer" : "provider_credential",
	};
}

function activePresentation(tool: AgentTool): "hidden" | "essential" | "discoverable" {
	if (tool.hidden === true) return "hidden";
	return tool.loadMode === "essential" ? "essential" : "discoverable";
}

export function buildRestrictedProfileReceipt(input: {
	runtime: RestrictedProfileRuntime;
	systemPrompt: readonly string[];
	tools: readonly AgentTool[];
	model: Model | undefined;
}): RestrictedProfileReceipt {
	const listInputs = RESTRICTED_EMPTY_INPUT_NAMES.map(name => ({
		name,
		digest: EMPTY_SHA256,
		items: [] as string[],
	}));
	const disabledInputs = [
		"workspaceTreeScan",
		"memory",
		"advisor",
		"task",
		"watchdog",
		"projectConfig",
		"projectModelOverride",
		"globalModelOverride",
		"sessionImportedInstructions",
		"mcp",
		"extensions",
		"lsp",
		"irc",
	].map(name => ({ name, disabled: true as const }));
	assertRestrictedPromptSegments(input.systemPrompt);
	return {
		receiptVersion: "agentdesk-restricted-profile-receipt-v1",
		profile: input.runtime.profile,
		profileDigest: input.runtime.profileDigest,
		promptInputs: [...listInputs, ...disabledInputs],
		systemPromptSegments: RESTRICTED_PROMPT_MANIFEST.segments.map(segment => ({
			name: segment.id,
			digest: segment.contentDigest,
		})),
		processStartEvidence: {
			mcp: false,
			extension: false,
			lsp: false,
			irc: false,
			advisor: false,
			watchdog: false,
			task: false,
		},
		tools: input.tools
			.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: canonicalize(toolWireSchema(tool)),
				loadMode: tool.loadMode ?? "discoverable",
				activePresentation: activePresentation(tool),
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
		modelTransport: modelReceipt(input.model),
		engineeringDatabase: input.runtime.databaseReceipt,
	};
}
