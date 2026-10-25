import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import { resolveModelOverrideWithAuthFallback, resolveSessionModelSelector } from "../config/model-resolver";
import { sessionFilesFromDisk } from "../internal-urls/registry-helpers";
import seanceAssignmentTemplate from "../prompts/system/seance-assignment.md" with { type: "text" };
import seanceTaskGuidanceTemplate from "../prompts/tools/seance-task-guidance.md" with { type: "text" };
import { buildSessionContext, getRestorableSessionModels } from "../session/session-context";
import { listSessionsReadOnly } from "../session/session-listing";
import { sessionDirForCwd } from "../session/session-paths";
import { resolveSessionLeafId, type SessionEntry } from "../session/session-entries";
import { FileSessionStorage, getDefaultSessionStorage, type SessionStorage } from "../session/session-storage";
import { SessionManager, type PersistedSessionInit } from "../session/session-manager";
import { loadSessionFile } from "../session/session-loader";
import type { ModelRegistry } from "../config/model-registry";
import type { TaskItem, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { getBundledAgent } from "./agents";
import { SEANCE_AGENT_NAME } from "./seance-policy";
import type { AgentDefinition } from "./types";

export interface ResolvedSeanceSource {
	file: string;
	id: string;
	/** Active saved model-role selector, then the saved default fallback. */
	modelSelectors: string[];
}

export interface PreparedSeanceSession {
	fork: {
		sourceFile: string;
	};
	promptSuffix: (resolvedModel?: string) => string;
}

export interface RestoredSeanceSession {
	cwd: string;
	modelPattern: string;
	toolNames: string[];
}

export function isBundledSeance(agent: AgentDefinition): boolean {
	return agent.name === SEANCE_AGENT_NAME && agent.source === "bundled";
}

function safeSourceLabel(source: string): string {
	return source
		.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
		.trim()
		.slice(0, 100);
}

function chooseId<T extends { id: string }>(matches: T[], selector: string): T | undefined {
	const normalized = selector.toLowerCase();
	const exact = matches.filter(match => match.id.toLowerCase() === normalized);
	const candidates = exact.length > 0 ? exact : matches.filter(match => match.id.toLowerCase().startsWith(normalized));
	if (candidates.length > 1) throw new Error(`Session selector "${safeSourceLabel(selector)}" is ambiguous.`);
	return candidates[0];
}

function savedModelSelectors(entries: SessionEntry[]): string[] {
	const leafId = resolveSessionLeafId(entries);
	if (leafId === null) return [];
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	const leaf = byId.get(leafId);
	if (!leaf) return [];
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = leaf;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	let lastModelChangeRole: string | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "model_change") {
			lastModelChangeRole = entry.role;
			break;
		}
	}
	const context = buildSessionContext(entries, leaf.id, byId);
	return getRestorableSessionModels(context.models, lastModelChangeRole);
}

async function validateSourceFile(file: string, storage: SessionStorage): Promise<ResolvedSeanceSource> {
	let loaded;
	try {
		loaded = await loadSessionFile(file, storage, { throwIfMissing: true });
	} catch {
		throw new Error("Unable to read the selected session.");
	}
	const header = loaded.entries[0];
	if (loaded.invalidHeader || !header || header.type !== "session" || !header.id) {
		throw new Error("The selected file does not contain a valid session header.");
	}
	const entries = loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	return { file, id: header.id, modelSelectors: savedModelSelectors(entries) };
}

/**
 * Agent transcripts under `artifactsDir`, keyed by agent id (the `.jsonl`
 * basename) with every candidate path kept for ambiguity checks. File storage
 * walks the directory tree; other backends list their own index, because
 * subagent sessions persist through the same session storage as their parent.
 */
async function artifactSessionFiles(artifactsDir: string, storage: SessionStorage): Promise<Map<string, string[]>> {
	if (storage instanceof FileSessionStorage) {
		return sessionFilesFromDisk(artifactsDir, { onlyPreferred: true, preserveDuplicates: true });
	}
	const found = new Map<string, string[]>();
	let files: string[];
	try {
		await storage.ensureCompleteIndex?.();
		files = storage.listFilesSync(artifactsDir, "**/*.jsonl");
	} catch {
		return found;
	}
	for (const file of files) {
		const name = path.basename(file);
		// Advisor transcripts are observability-only, as in `sessionFilesFromDisk`.
		if (name.startsWith("__advisor")) continue;
		const id = name.slice(0, -".jsonl".length);
		const candidates = found.get(id);
		if (candidates) candidates.push(file);
		else found.set(id, [file]);
	}
	return found;
}

/** Unambiguous agent transcript under `artifactsDir` matching `selector`, preferring direct children. */
async function artifactIdMatch(
	selector: string,
	artifactsDir: string,
	storage: SessionStorage,
): Promise<string | undefined> {
	const preferredDir = path.resolve(artifactsDir);
	const files = await artifactSessionFiles(artifactsDir, storage);
	const matches = [...files].flatMap(([id, candidates]) => {
		const direct = candidates.filter(file => path.resolve(path.dirname(file)) === preferredDir);
		return (direct.length > 0 ? direct : candidates).map(file => ({ id, path: file }));
	});
	return chooseId(matches, selector)?.path;
}

/**
 * Resolve an explicit session path or an unambiguous stored session id without opening its writer.
 * Ids search the caller's artifact tree, then the current project; `includeGlobal` (user-typed
 * `/seance` ids) also searches every project's sessions.
 */
export async function resolveSeanceSource(
	selector: string,
	options: {
		cwd: string;
		sessionDirHint?: string;
		artifactsDirHint?: string;
		includeGlobal?: boolean;
		storage?: SessionStorage;
	},
): Promise<ResolvedSeanceSource> {
	const source = selector.trim();
	if (!source) throw new Error("A source session is required.");
	const storage = options.storage ?? getDefaultSessionStorage();
	if (source.includes("/") || source.includes("\\") || source.endsWith(".jsonl")) {
		const file = resolveToCwd(source, options.cwd);
		if (storage instanceof FileSessionStorage) {
			try {
				const stat = await fs.stat(file);
				if (!stat.isFile()) throw new Error("The selected path is not a session file.");
			} catch (error) {
				if (error instanceof Error && error.message === "The selected path is not a session file.") throw error;
				throw new Error("The selected session file was not found or could not be accessed.");
			}
		} else if (!(await storage.exists(file).catch(() => false))) {
			throw new Error("The selected session file was not found or could not be accessed.");
		}
		return validateSourceFile(file, storage);
	}

	const label = safeSourceLabel(source);
	if (options.artifactsDirHint) {
		const match = await artifactIdMatch(source, options.artifactsDirHint, storage);
		if (match) return validateSourceFile(match, storage);
	}
	const sessionDir = options.sessionDirHint ?? sessionDirForCwd(options.cwd);
	const local = await listSessionsReadOnly(sessionDir, storage);
	const localMatch = chooseId(local, source);
	if (localMatch) return validateSourceFile(localMatch.path, storage);
	if (options.includeGlobal) {
		const matchGlobal = chooseId(await SessionManager.listAll(storage), source);
		if (matchGlobal) return validateSourceFile(matchGlobal.path, storage);
	}
	throw new Error(`Session "${label}" was not found.`);
}

/**
 * Resolve a model-initiated seance source on shared (non-file) session storage, where one
 * namespace holds every user's transcripts. Only the caller's own session file and the agent
 * transcripts under its artifacts dir are candidates. Any other path or id is reported as not
 * found without being read or matched, so the answer never reveals another session's existence.
 */
async function resolveOwnedSeanceSource(
	selector: string,
	options: { cwd: string; sessionFile: string | null; artifactsDir: string | undefined; storage: SessionStorage },
): Promise<ResolvedSeanceSource> {
	const source = selector.trim();
	if (!source) throw new Error("A source session is required.");
	const { sessionFile, artifactsDir, storage } = options;
	if (!sessionFile) throw new Error("Seance requires a persisted caller session to locate its source.");

	if (source.includes("/") || source.includes("\\") || source.endsWith(".jsonl")) {
		// Normalize before comparing: `resolveToCwd` keeps absolute paths verbatim, `..` included.
		const target = path.resolve(resolveToCwd(source, options.cwd));
		if (target === path.resolve(sessionFile)) {
			if (await storage.exists(sessionFile).catch(() => false)) return validateSourceFile(sessionFile, storage);
		} else if (artifactsDir) {
			for (const candidates of (await artifactSessionFiles(artifactsDir, storage)).values()) {
				const file = candidates.find(candidate => path.resolve(candidate) === target);
				if (file) return validateSourceFile(file, storage);
			}
		}
		throw new Error("The selected session file was not found or could not be accessed.");
	}

	if (artifactsDir) {
		const match = await artifactIdMatch(source, artifactsDir, storage);
		if (match) return validateSourceFile(match, storage);
	}
	const own = (await storage.exists(sessionFile).catch(() => false))
		? await validateSourceFile(sessionFile, storage).catch(() => undefined)
		: undefined;
	if (own && chooseId([own], source)) return own;
	throw new Error(`Session "${safeSourceLabel(source)}" was not found.`);
}

/**
 * Source files a human picked with the interactive `/seance` command, keyed by the caller's
 * session file. Owner scoping binds model-chosen sources; these explicit picks keep their
 * unscoped reach on shared storage. Only the TUI handler grants, and RPC/ACP dispatch runs no
 * TUI-only command, so neither a model tool call nor a remote client can add an entry.
 */
const userSeanceSources = new Map<string, Set<string>>();

/** Record a source the user chose through the TUI `/seance` command for this caller session. */
export function grantUserSeanceSource(callerSessionFile: string, sourceFile: string): void {
	let sources = userSeanceSources.get(callerSessionFile);
	if (!sources) {
		sources = new Set();
		userSeanceSources.set(callerSessionFile, sources);
	}
	sources.add(sourceFile);
}

const modelSelectorInputSchema = type("string | string[]");
export const seanceTaskSchemaFields = {
	"sourceSession?": type("string"),
	"model?": modelSelectorInputSchema,
};
export const seanceTaskGuidance = seanceTaskGuidanceTemplate;

function validateSeanceFields(
	item: TaskItem | TaskParams,
	agent: string,
	label: string,
	seanceAdvertised: boolean,
): string | undefined {
	if (agent !== SEANCE_AGENT_NAME) {
		if (item.sourceSession !== undefined)
			return `\`sourceSession\` is only accepted for the \`${SEANCE_AGENT_NAME}\` agent.`;
		if (item.model !== undefined) return `\`model\` is only accepted for the \`${SEANCE_AGENT_NAME}\` agent.`;
		return undefined;
	}
	// Hidden bundled seance (plan mode, policy) is rejected at spawn; a custom shadow is an ordinary agent.
	if (!seanceAdvertised) return undefined;
	if (typeof item.sourceSession !== "string" || item.sourceSession.trim().length === 0) {
		return `${label} selects the \`${SEANCE_AGENT_NAME}\` agent and requires a non-empty \`sourceSession\`.`;
	}
	if ("tools" in item && item.tools?.length)
		return `${label} cannot pass custom tools to the read-only \`${SEANCE_AGENT_NAME}\` agent.`;
	const model: unknown = item.model;
	if (
		model !== undefined &&
		!(
			(typeof model === "string" && model.trim().length > 0) ||
			(Array.isArray(model) &&
				model.length > 0 &&
				model.every(value => typeof value === "string" && value.trim().length > 0))
		)
	) {
		return `${label} has an invalid \`model\` selector. Provide a non-empty selector or selector array.`;
	}
	return undefined;
}

export function validateSeanceParams(context: {
	params: TaskParams;
	batchEnabled: boolean;
	defaultAgent: string;
	seanceAdvertised: boolean;
}): string | undefined {
	const { params, batchEnabled, defaultAgent, seanceAdvertised } = context;
	if (batchEnabled && params.tasks !== undefined) {
		if (params.sourceSession !== undefined || params.model !== undefined) {
			return `Put \`sourceSession\` and \`model\` on the individual \`${SEANCE_AGENT_NAME}\` item inside \`tasks[]\`.`;
		}
		for (let index = 0; index < params.tasks.length; index++) {
			const item = params.tasks[index]!;
			const label = `Task ${index + 1}${item.name ? ` (\`${item.name}\`)` : ""}`;
			const error = validateSeanceFields(item, item.agent?.trim() || defaultAgent, label, seanceAdvertised);
			if (error) return error;
		}
		return undefined;
	}
	return validateSeanceFields(params, params.agent?.trim() || defaultAgent, "The call", seanceAdvertised);
}

export async function prepareSeance(context: {
	session: ToolSession;
	invocationKind: "task" | "eval";
	agent: AgentDefinition;
	sourceSession?: string;
	model?: string | string[];
	planMode: boolean;
	isolationRequested: boolean;
	hasCustomTools: boolean;
}): Promise<{ modelPatterns: string[]; session: PreparedSeanceSession }> {
	if (context.invocationKind !== "task" || !isBundledSeance(context.agent)) {
		throw new Error("Seance requires the bundled task agent.");
	}
	const sourceSelector = context.sourceSession;
	if (!sourceSelector?.trim()) throw new Error("The `seance` agent requires a source session.");
	if (context.planMode || context.isolationRequested || context.hasCustomTools) {
		throw new Error("Seance does not support plan mode, isolated execution, or custom tools.");
	}
	const storage = getDefaultSessionStorage();
	const sessionFile = context.session.getSessionFile();
	const artifactsDir = context.session.getArtifactsDir?.() ?? undefined;
	// A shared store (SQL in AgentDesk) holds other users' transcripts under the same
	// project buckets, so a model-chosen source stays inside the caller's own session tree.
	// Exact user `/seance` picks for this caller keep the unscoped resolution they were made with.
	const userPicked = sessionFile !== null && userSeanceSources.get(sessionFile)?.has(sourceSelector) === true;
	const source =
		storage instanceof FileSessionStorage || userPicked
			? await resolveSeanceSource(sourceSelector, {
					cwd: context.session.cwd,
					sessionDirHint: sessionFile ? path.dirname(sessionFile) : undefined,
					artifactsDirHint: artifactsDir,
					storage,
				})
			: await resolveOwnedSeanceSource(sourceSelector, {
					cwd: context.session.cwd,
					sessionFile,
					artifactsDir,
					storage,
				});
	const modelRegistry = context.session.modelRegistry;
	if (!modelRegistry) throw new Error("Seance cannot resolve a model in this session.");
	await modelRegistry.awaitBackgroundRefresh().catch(() => {});
	const requestedModel = context.model;
	const requestedModels =
		requestedModel === undefined
			? source.modelSelectors
			: typeof requestedModel === "string"
				? [requestedModel]
				: requestedModel;
	if (requestedModels.length === 0) {
		throw new Error("The source session has no saved model. Select a model explicitly with `--model`.");
	}
	const modelPatterns: string[] = [];
	for (const selector of requestedModels) {
		if (requestedModel === undefined) {
			if (resolveSessionModelSelector(modelRegistry, selector)) modelPatterns.push(selector);
			continue;
		}
		const resolved = await resolveModelOverrideWithAuthFallback(
			[selector],
			undefined,
			modelRegistry,
			context.session.settings,
			context.session.getSessionId?.() ?? undefined,
		);
		if (resolved.model && modelRegistry.hasConfiguredAuth(resolved.model)) modelPatterns.push(selector);
	}
	if (modelPatterns.length === 0) {
		throw new Error(
			"No available saved model can serve this source. Select an available model explicitly with `--model`.",
		);
	}
	return {
		modelPatterns,
		session: {
			fork: {
				sourceFile: source.file,
			},
			promptSuffix: resolvedModel =>
				prompt.render(seanceAssignmentTemplate, {
					sourceSession: safeSourceLabel(source.id),
					model: resolvedModel ?? "",
				}),
		},
	};
}

export async function restoreSeanceSession(context: {
	init: PersistedSessionInit;
	cwd: string;
	modelRegistry: ModelRegistry;
}): Promise<RestoredSeanceSession | undefined> {
	const { init, cwd, modelRegistry } = context;
	const readOnlyTools = new Set([...(getBundledAgent(SEANCE_AGENT_NAME)?.tools ?? []), "yield"]);
	if (
		!init ||
		typeof init !== "object" ||
		init.agent !== SEANCE_AGENT_NAME ||
		init.restrictToolNames !== true ||
		!Array.isArray(init.systemPrompt) ||
		init.systemPrompt.length === 0 ||
		!init.systemPrompt.every(block => typeof block === "string") ||
		!init.systemPrompt.some(block => typeof block === "string" && block.trim().length > 0) ||
		typeof init.task !== "string" ||
		init.task.trim().length === 0 ||
		typeof init.resolvedModel !== "string" ||
		init.resolvedModel.trim().length === 0 ||
		!Array.isArray(init.tools) ||
		!init.tools.every(tool => typeof tool === "string") ||
		// `grep.enabled`/`glob.enabled` may have trimmed the spawn's list; `read` is the minimum.
		!init.tools.includes("read") ||
		typeof cwd !== "string" ||
		cwd.trim().length === 0
	) {
		return undefined;
	}
	const modelPattern = init.resolvedModel.trim();
	await modelRegistry.awaitBackgroundRefresh().catch(() => {});
	if (!resolveSessionModelSelector(modelRegistry, modelPattern)) return undefined;
	return {
		cwd,
		modelPattern,
		toolNames: init.tools.filter(name => readOnlyTools.has(name)),
	};
}
