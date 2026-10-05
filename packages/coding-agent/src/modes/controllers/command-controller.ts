import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import {
	getEnvApiKey,
	getProviderDetails,
	type ProviderDetails,
	type DisabledCredentialSummary,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { type Component, Loader, Markdown, Spacer, Text, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { formatDuration, logger, Snowflake, sanitizeText } from "@oh-my-pi/pi-utils";
import { shouldEnableAppendOnlyContext } from "../../config/append-only-context-mode";
import { type BashResult, isPersistentShellCdCommand } from "../../exec/bash-executor";
import { type LoadedCustomShare, loadCustomShare } from "../../export/custom-share";
import { parseExportArgs } from "../../export/html/args";
import { shareSession } from "../../export/share";
import type { CompactOptions } from "../../extensibility/extensions/types";
import {
	diffMentalModelContent,
	type HindsightApi,
	type HindsightSessionState,
	loadHindsightConfig,
	reloadMentalModelsForSession,
	resolveSeedsForScope,
	seedAlreadyExists,
	summarizeMentalModel,
} from "../../hindsight";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../../memory-backend";
import { BashExecutionComponent, bashPtyViewport } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { BorderedLoader } from "@oh-my-pi/pi-tui/overlays/bordered-loader";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { MoveOverlay, type MoveOverlayResult } from "@oh-my-pi/pi-tui/overlays/move-overlay";
import { moveDirectorySource } from "../move-directory-source";
import { getMarkdownTheme, getSymbolTheme, theme, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../../modes/types";
import { ContextUsageView, contextUsageHead } from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { OverlayHandle } from "@oh-my-pi/pi-tui";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import type { TspText } from "@oh-my-pi/pi-wire";
import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import { buildHotkeysMarkdown, HotkeysSheetComponent } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { buildToolsMarkdown } from "@oh-my-pi/pi-tui/prompt/tools-markdown";
import type { AsyncJobSnapshotItem } from "../../session/agent-session";
import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";
import type { CompactMode } from "../../session/compact-modes";
import type { NewSessionOptions } from "../../session/session-entries";
import {
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	formatSessionWorktreeSummary,
	type SessionWorktree,
} from "../../session/session-worktree";
import { formatShakeSummary, type ShakeMode, type ShakeResult } from "../../session/shake-types";
import { formatUsageBreakdown, type UsageStyler } from "../../cli/usage-cli";
import { limitMatchesActiveAccount } from "../../slash-commands/helpers/active-oauth-account";
import { formatCompactQuota } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { outputMeta } from "../../tools/output-meta";
import { resolveToCwd, stripOuterDoubleQuotes } from "../../tools/path-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	getChangelogPath,
	parseChangelog,
	parseChangelogView,
	renderChangelogEntries,
	selectChangelogEntries,
} from "../../utils/changelog";
import { copyToClipboard } from "../../utils/clipboard";
import { formatDumpArchiveReport } from "../../session/session-dump-format";
import { openPath } from "../../utils/open";
import { resumeCommand } from "../../utils/resume-command";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { collapseSharedUsageReports } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { collectStoredUsageAccounts } from "../../usage-accounts";
import type { UnavailableUsageAccount } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { cfgTerminalShowImages } from "../settings";
import { cfgProviderAppendOnlyContext } from "../../session/settings";
import { cfgShareRedactSecrets, cfgShareServerUrl, cfgShareStore } from "../../commands/settings";

function formatCreditValue(value: number): string {
	return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export class CommandController {
	/** The open native report sheet. */
	#reportSheet: OverlayHandle | undefined;
	/** The editor sat on the bottom row when the text-mode report above it opened. */
	#reportOpenedAtBottom = false;

	constructor(private readonly ctx: InteractiveModeContext) {}

	/**
	 * Esc: take away the report shown above the editor (text mode); false when
	 * none is shown. While open it may have pushed rows into the terminal's
	 * scrollback that cannot come back, so an editor that sat on the bottom
	 * row before is pinned there again instead of jumping up the screen.
	 */
	dismissCommandReport(): boolean {
		if (!this.#clearReport()) return false;
		if (this.#reportOpenedAtBottom) this.ctx.pinComposerToBottom();
		this.#reportOpenedAtBottom = false;
		return true;
	}

	/**
	 * Drop any report — the one above the editor, or a focused sheet/page —
	 * without pinning anything: the transcript or session under it was reset,
	 * and its contents describe what is gone.
	 */
	clearCommandReport(): void {
		this.#clearReport();
		this.#closeReportSheet();
		this.#reportOpenedAtBottom = false;
	}

	#clearReport(): boolean {
		const docked = this.ctx.reportContainer;
		if (docked.children.length === 0) return false;
		docked.dispose();
		docked.clear();
		this.ctx.ui.requestRender();
		return true;
	}

	#closeReportSheet(): void {
		const sheet = this.#reportSheet;
		if (!sheet) return;
		this.#reportSheet = undefined;
		sheet.hide();
		this.ctx.ui.setFocus(this.ctx.editorContainer.children[0] ?? this.ctx.editor);
		this.ctx.ui.requestRender();
	}

	/**
	 * Show a read-only report, replacing the previous one. In text mode one that
	 * fits the rows above the editor shows there like `/btw`: the editor keeps
	 * focus and its Esc takes the report away. A taller one opens as a
	 * full-screen page on the terminal's alternate screen, scrolled with the
	 * arrow/page keys and the wheel, so the main screen is never touched and
	 * Esc returns to it as it was. Natively it is a focused sheet like
	 * `/usage`, its body scrolled by the terminal once it is long, closed by
	 * Esc or Close.
	 */
	showCommandReport(options: { title: string; head?: TspText; body: Component }): void {
		// A replacement keeps where the editor sat before the first report.
		const openedAtBottom =
			this.ctx.reportContainer.children.length > 0 ? this.#reportOpenedAtBottom : this.ctx.composerInputAtBottom();
		this.#clearReport();
		this.#closeReportSheet();
		const terminal = this.ctx.ui.terminal;
		const inline = this.ctx.commandReportRows() ?? terminal.rows;
		let fullScreen = false;
		const report = new ReportPanel({
			...options,
			closeKey: appKey(this.ctx.keybindings, "app.interrupt"),
			onClose: () => this.#closeReportSheet(),
			maxRows: () => (fullScreen ? terminal.rows : this.ctx.commandReportRows()),
		});
		if (isNativeRendering()) {
			report.holdFocus();
			this.#reportSheet = this.ctx.ui.showOverlay(report, { anchor: "center", width: "90%", maxHeight: "90%" });
			this.ctx.ui.setFocus(report);
		} else if (report.heightAt(terminal.columns) > inline) {
			fullScreen = true;
			report.holdFocus();
			this.#reportSheet = this.ctx.ui.showOverlay(report, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
				fullscreen: true,
			});
			this.ctx.ui.setFocus(report);
		} else {
			this.ctx.reportContainer.addChild(report);
			this.#reportOpenedAtBottom = openedAtBottom;
		}
		this.ctx.ui.requestRender();
	}

	/** A titled markdown report; see {@link showCommandReport}. */
	#showMarkdownPanel(title: string, markdown: string): void {
		this.showCommandReport({ title, body: new Markdown(markdown.trim(), 0, 0, getMarkdownTheme()) });
	}

	async #restoreAfterMoveFailure(
		previousState: Parameters<InteractiveModeContext["sessionManager"]["rollbackMove"]>[0],
		initialError?: unknown,
	): Promise<void> {
		if (initialError !== undefined) {
			this.ctx.showError(
				`Failed to switch workspace: ${initialError instanceof Error ? initialError.message : String(initialError)}`,
			);
		}

		try {
			await this.ctx.sessionManager.rollbackMove(previousState);
		} catch (rollbackError) {
			const actual = this.ctx.sessionManager.getCwd();
			let realigned = false;
			try {
				realigned = await this.ctx.applyCwdChange(actual);
			} catch {}
			if (!realigned) {
				this.ctx.showError(
					`Failed to roll back move: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} (failed to re-align workspace to ${actual})`,
				);
				await this.ctx.shutdown();
				return;
			}
			this.ctx.showError(
				`Failed to roll back move: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} (workspace remains at ${actual})`,
			);
			return;
		}

		let sourceRestored = false;
		try {
			sourceRestored = await this.ctx.applyCwdChange(previousState.cwd);
		} catch {}
		if (sourceRestored) return;

		const actual = this.ctx.sessionManager.getCwd();
		let realigned = false;
		try {
			realigned = await this.ctx.applyCwdChange(actual);
		} catch {}
		if (!realigned) {
			this.ctx.showError(`Failed to restore source workspace after rollback: workspace remains at ${actual}`);
			await this.ctx.shutdown();
			return;
		}
		this.ctx.showError(`Failed to restore source workspace after rollback: workspace remains at ${actual}`);
	}

	openInBrowser(urlOrPath: string): void {
		openPath(urlOrPath);
	}

	async handleExportCommand(text: string): Promise<void> {
		try {
			const { outputPath, useUserThemes } = parseExportArgs(text.slice("/export".length));
			if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
				this.ctx.showWarning("Use /dump to copy the session to clipboard.");
				return;
			}

			// The viewed session: the focused subagent's transcript (plus its own
			// subagents) from a focused view, otherwise the main session.
			const filePath = await this.ctx.viewSession.exportToHtml(outputPath, useUserThemes);
			this.ctx.showStatus(`Session exported to: ${filePath}`);
			this.openInBrowser(filePath);
		} catch (error: unknown) {
			this.ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
	async handleTraceCommand(): Promise<void> {
		const sessionFile = this.ctx.session.sessionFile;
		if (!sessionFile) {
			this.ctx.showWarning("No session file yet — send a message first.");
			return;
		}
		try {
			// Lazy: the stats dashboard (server + sqlite) loads on demand only,
			// matching src/cli/stats-cli.ts, to keep CLI startup fast.
			const { formatStatsDashboardUrl, startServer } = await import("@oh-my-pi/omp-stats");
			const { hostname, port } = await startServer();
			const url = `${formatStatsDashboardUrl(hostname, port)}/#/traces?s=${encodeURIComponent(sessionFile)}`;
			this.openInBrowser(url);
			this.ctx.showStatus(`Trace: ${url}`);
		} catch (error: unknown) {
			this.ctx.showError(`Failed to open trace: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleDumpCommand(): Promise<void> {
		try {
			const formatted = this.ctx.session.formatSessionAsText();
			if (!formatted) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			// Build the LLM request JSON sidecar first so its path (and a
			// raw-context warning) can be appended to the copied transcript.
			let sidecarPath: string | undefined;
			let sidecarError: string | undefined;
			try {
				sidecarPath = await this.ctx.session.dumpLlmRequestToTmpDir();
			} catch (error: unknown) {
				sidecarError = error instanceof Error ? error.message : "Unknown error";
			}
			const doc = sidecarPath
				? `${formatted}\n\n---\nLLM request JSON: ${sidecarPath}\nThis file persists on disk and may contain raw context/secrets — treat accordingly.`
				: formatted;
			await copyToClipboard(doc);
			const statusParts = ["Session copied to clipboard"];
			if (sidecarPath) statusParts.push(`LLM request JSON: ${sidecarPath}`);
			if (sidecarError) statusParts.push(`LLM request JSON unavailable: ${sidecarError}`);
			this.ctx.showStatus(statusParts.join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(`Failed to copy session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleDumpAllCommand(): Promise<void> {
		try {
			const archive = await this.ctx.session.dumpSessionArchiveToTmpDir();
			if (!archive) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			await copyToClipboard(archive.path);
			this.ctx.showStatus([...formatDumpArchiveReport(archive), "Archive path copied to clipboard"].join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to write session dump: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	handleAdvisorDumpCommand(isRaw = false) {
		try {
			const advisorHistory = this.ctx.session.formatAdvisorHistoryAsText({ compact: !isRaw });
			if (advisorHistory === null) {
				this.ctx.showError("Advisor is not active for this session.");
				return;
			}
			if (!advisorHistory) {
				this.ctx.showError("Advisor has no history yet.");
				return;
			}
			copyToClipboard(advisorHistory);
			this.ctx.showStatus("Advisor history copied to clipboard");
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to copy advisor history: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleDebugTranscriptCommand(): Promise<void> {
		try {
			const width = Math.max(1, this.ctx.ui.terminal.columns);
			const renderedLines = this.ctx.chatContainer.render(width).map(line => replaceTabs(Bun.stripANSI(line)));
			const rendered = renderedLines.join("\n").trimEnd();
			if (!rendered) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			const tmpPath = path.join(os.tmpdir(), `${Snowflake.next()}-tmp.txt`);
			await Bun.write(tmpPath, `${rendered}\n`);
			this.ctx.showStatus(`Debug transcript written to:\n${tmpPath}`);
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to write debug transcript: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleShareCommand(): Promise<void> {
		let customShare: LoadedCustomShare | null;
		try {
			customShare = await loadCustomShare();
		} catch (err) {
			this.ctx.showError(err instanceof Error ? err.message : String(err));
			return;
		}

		const loader = new BorderedLoader(this.ctx.ui, theme, "Sharing session...");
		this.ctx.editorContainer.clear();
		this.ctx.editorContainer.addChild(loader);
		this.ctx.ui.setFocus(loader);
		this.ctx.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.ctx.editorContainer.clear();
			this.ctx.editorContainer.addChild(this.ctx.editor);
			this.ctx.ui.setFocus(this.ctx.editor);
		};
		loader.onAbort = () => {
			restoreEditor();
			this.ctx.showStatus("Share cancelled");
		};

		// Custom share scripts keep their legacy contract: they receive a path
		// to a standalone HTML export. No fallback to the default flow on error.
		if (customShare) {
			const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
			try {
				await this.ctx.session.exportToHtml(tmpFile);
				const result = await customShare.fn(tmpFile);
				if (loader.signal.aborted) return;
				restoreEditor();

				if (typeof result === "string") {
					this.ctx.showStatus(`Share URL: ${result}`);
					this.openInBrowser(result);
				} else if (result) {
					const parts: string[] = [];
					if (result.url) parts.push(`Share URL: ${result.url}`);
					if (result.message) parts.push(result.message);
					if (parts.length > 0) this.ctx.showStatus(parts.join("\n"));
					if (result.url) this.openInBrowser(result.url);
				} else {
					this.ctx.showStatus("Session shared");
				}
			} catch (err) {
				if (!loader.signal.aborted) {
					restoreEditor();
					this.ctx.showError(`Custom share failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			} finally {
				await fs.rm(tmpFile, { force: true }).catch(() => {});
			}
			return;
		}

		// Default: encrypted snapshot to a secret gist (preferred) or the share
		// server; the key rides in the link fragment and never leaves the client.
		try {
			const result = await shareSession(this.ctx.session.sessionManager, {
				serverUrl: cfgShareServerUrl.get(this.ctx.settings),
				store: cfgShareStore.get(this.ctx.settings),
				state: this.ctx.session.state,
				obfuscator: cfgShareRedactSecrets.get(this.ctx.settings) ? this.ctx.session.obfuscator : undefined,
			});
			if (loader.signal.aborted) return;
			restoreEditor();

			const lines = [`Share URL: ${result.url}`];
			if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
			if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
			this.ctx.showStatus(lines.join("\n"));
			this.openInBrowser(result.url);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.ctx.showError(`Failed to share session: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	async handleSessionCommand(): Promise<void> {
		const stats = this.ctx.session.getSessionStats();
		const premiumRequests =
			"premiumRequests" in stats && typeof stats.premiumRequests === "number"
				? stats.premiumRequests
				: this.ctx.session.sessionManager.getUsageStatistics().premiumRequests;
		const normalizedPremiumRequests = Math.round((premiumRequests + Number.EPSILON) * 100) / 100;

		let info = "";
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n`;
		info += `\n${theme.bold("Provider")}\n`;
		const model = this.ctx.session.model;
		if (!model) {
			info += `${theme.fg("dim", "No model selected")}\n`;
		} else {
			const authMode = resolveProviderAuthMode(this.ctx.session.modelRegistry.authStorage, model.provider);
			const credentialSource = this.ctx.session.modelRegistry.authStorage.keys.describe(
				model.provider,
				stats.sessionId,
			);
			const providerDetails = getProviderDetails({
				model,
				sessionId: stats.sessionId,
				authMode,
				credentialSource,
				preferWebsockets: this.ctx.session.preferWebsockets,
				providerSessionState: this.ctx.session.providerSessionState,
			});
			info += renderProviderSection(providerDetails, theme);
			if (stats.routedModels !== undefined) {
				const routed = Object.entries(stats.routedModels)
					.sort(([aId, aCount], [bId, bCount]) => bCount - aCount || aId.localeCompare(bId))
					.map(
						([id, count]) => `${replaceTabs(sanitizeText(id))}${count > 1 ? theme.fg("dim", ` ×${count}`) : ""}`,
					);
				info += `${theme.fg("dim", "Served:")} ${routed.join(", ")}\n`;
			}
		}
		info += `\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		// Append-only context
		{
			const setting = cfgProviderAppendOnlyContext.get(this.ctx.settings);
			const model = this.ctx.session.model;
			const mode = shouldEnableAppendOnlyContext(setting, model);
			const activeLabel = mode ? theme.fg("success", "active") : theme.fg("dim", "inactive");
			const settingLabel = setting === "auto" ? `${setting} (${model?.provider ?? "?"})` : setting;
			info += `${theme.fg("dim", "Append-Only:")} ${activeLabel} (setting: ${settingLabel})\n`;
		}
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0 || normalizedPremiumRequests > 0 || stats.credits !== undefined) {
			info += `\n${theme.bold("Cost")}\n`;
			if (stats.cost > 0) {
				info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}\n`;
			}
			if (normalizedPremiumRequests > 0) {
				info += `${theme.fg("dim", "Premium Requests:")} ${normalizedPremiumRequests.toLocaleString()}\n`;
			}
			if (stats.credits !== undefined) {
				info += `${theme.fg("dim", "Credits:")} ${formatCreditValue(stats.credits.cost)}\n`;
				info += `${theme.fg("dim", "Committed Credits:")} ${formatCreditValue(stats.credits.committedCost)}\n`;
				info += `${theme.fg("dim", "Committed ACU:")} ${formatCreditValue(stats.credits.acuCost)}\n`;
			}
		}

		if (this.ctx.lspServers && this.ctx.lspServers.length > 0) {
			info += `\n${theme.bold("LSP Servers")}\n`;
			for (const server of this.ctx.lspServers) {
				const statusColor =
					server.status === "ready"
						? "success"
						: server.status === "available"
							? "dim"
							: server.status === "connecting"
								? "warning"
								: "error";
				const statusText =
					server.status === "error" && server.error ? `${server.status}: ${server.error}` : server.status;
				info += `${theme.fg("dim", `${server.name}:`)} ${theme.fg(statusColor, statusText)} ${theme.fg("dim", `(${server.fileTypes.join(", ")})`)}\n`;
			}
		}

		if (this.ctx.mcpManager) {
			const mcpServers = this.ctx.mcpManager.getConnectedServers();
			info += `\n${theme.bold("MCP Servers")}\n`;
			if (mcpServers.length === 0) {
				info += `${theme.fg("dim", "None connected")}\n`;
			} else {
				for (const name of mcpServers) {
					const conn = this.ctx.mcpManager.getConnection(name);
					const toolCount = conn?.tools?.length ?? 0;
					info += `${theme.fg("dim", `${name}:`)} ${theme.fg("success", "connected")} ${theme.fg("dim", `(${toolCount} tools)`)}\n`;
				}
			}
		}

		this.ctx.showSessionInfo(info, this.ctx.session.getContextUsage());
	}

	static readonly #advisorStatusGlyph: Record<string, string> = {
		running: "●",
		paused: "○",
		no_model: "○",
		quota_exhausted: "✕",
		error: "✕",
	};

	static readonly #advisorStatusLabel: Record<string, string> = {
		running: "running",
		paused: "off",
		no_model: "no model",
		quota_exhausted: "quota exhausted",
		error: "error",
	};

	async handleAdvisorStatusCommand(): Promise<void> {
		const stats = this.ctx.session.getAdvisorStats();
		if (!stats.configured) {
			this.showCommandReport({ title: "Advisor Status", body: new Text("Advisor is disabled.", 0, 0) });
			return;
		}
		// Fetch live quota data (cached 5 min by the auth-gateway) so we can show
		// real usage windows/reset timers per advisor provider. Non-fatal when absent.
		const usageProvider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
		let usageReports: UsageReport[] | null = null;
		if (usageProvider.fetchUsageReports) {
			try {
				usageReports = await usageProvider.fetchUsageReports();
			} catch {
				// Network/auth failure is non-fatal — just skip the quota line.
			}
		}
		// Resolve the active OAuth identity for each advisor's provider so quota
		// filtering matches the credential actually in use (not sibling accounts).
		const resolveActiveAdvisorAccount = (provider: string, sessionId?: string): OAuthAccountIdentity | undefined =>
			this.ctx.session.modelRegistry.authStorage.oauth.identity(provider, sessionId ?? this.ctx.session.sessionId);
		const nowMs = Date.now();
		// Roster view: show every configured advisor with its status, even when
		// none are live (all paused/no-model). The old code returned a generic
		// message that hid the per-advisor state the user needs to act on.
		if (stats.advisors.length > 1 || (stats.configured && !stats.active)) {
			let info = "";
			for (const a of stats.advisors) {
				const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
				const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
				const color =
					a.status === "running"
						? "success"
						: a.status === "quota_exhausted" || a.status === "error"
							? "error"
							: "dim";
				info += `\n${theme.fg(color, glyph)} ${theme.bold(a.name)} ${theme.fg("dim", `[${label}]`)}\n`;
				if (a.model) {
					info += `${theme.fg("dim", "Model:")} ${a.model.provider}/${a.model.id}\n`;
				}
				if (a.model && usageReports) {
					const identity = resolveActiveAdvisorAccount(a.model.provider, a.sessionId);
					const quota = formatCompactQuota(
						a.model.provider,
						collapseSharedUsageReports(usageReports),
						nowMs,
						(report, limit) => !identity || limitMatchesActiveAccount(report, limit, identity),
					);
					if (quota) info += `${theme.fg("dim", quota)}\n`;
				}
				if (a.status === "running" || a.status === "quota_exhausted") {
					const ctx =
						a.contextWindow > 0
							? `${a.contextTokens.toLocaleString()} / ${a.contextWindow.toLocaleString()} (${Math.round((a.contextTokens / a.contextWindow) * 100)}%)`
							: `${a.contextTokens.toLocaleString()}`;
					info += `${theme.fg("dim", "Context:")} ${ctx}\n`;
					info += `${theme.fg("dim", "Messages:")} ${a.messages.total.toLocaleString()}\n`;
					info += `${theme.fg("dim", "Spend:")} ${a.tokens.input.toLocaleString()} in / ${a.tokens.output.toLocaleString()} out`;
					if (a.cost > 0) info += `, $${a.cost.toFixed(4)}`;
					info += "\n";
				}
			}
			if (stats.active) {
				info += `\n${theme.bold("Totals")}\n`;
				info += `${theme.fg("dim", "Tokens:")} ${stats.tokens.total.toLocaleString()}\n`;
				if (stats.cost > 0) info += `${theme.fg("dim", "Cost:")} $${stats.cost.toFixed(4)}\n`;
			}
			this.showCommandReport({
				title: `Advisor Status (${stats.advisors.length} advisors)`,
				body: new Text(info.trim(), 0, 0),
			});
			return;
		}
		// Single active advisor — detailed view.
		const model = stats.model;
		let info = "";
		if (stats.advisors.length === 1) {
			const a = stats.advisors[0];
			const glyph = CommandController.#advisorStatusGlyph[a.status] ?? "?";
			const label = CommandController.#advisorStatusLabel[a.status] ?? a.status;
			info += `${theme.fg(a.status === "running" ? "success" : "error", glyph)} ${a.name} ${theme.fg("dim", `[${label}]`)}\n\n`;
		}
		if (model) {
			info += `${theme.bold("Provider")}\n`;
			info += `${theme.fg("dim", "Model:")} ${model.provider}/${model.id}\n`;
		}
		if (model && usageReports) {
			const identity = resolveActiveAdvisorAccount(model.provider, stats.advisors[0]?.sessionId);
			const quota = formatCompactQuota(
				model.provider,
				collapseSharedUsageReports(usageReports),
				nowMs,
				(report, limit) => !identity || limitMatchesActiveAccount(report, limit, identity),
			);
			if (quota) {
				info += `\n${theme.bold("Quota")}\n`;
				info += `${theme.fg("dim", quota)}\n`;
			}
		}
		info += `\n${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.messages.user.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.messages.assistant.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.messages.total.toLocaleString()}\n`;
		info += `\n${theme.bold("Context")}\n`;
		if (stats.contextWindow > 0) {
			const percent = Math.round((stats.contextTokens / stats.contextWindow) * 100);
			info += `${theme.fg("dim", "Tokens:")} ${stats.contextTokens.toLocaleString()} / ${stats.contextWindow.toLocaleString()} (${percent}%)\n`;
		} else {
			info += `${theme.fg("dim", "Tokens:")} ${stats.contextTokens.toLocaleString()}\n`;
		}
		info += `\n${theme.bold("Spend")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.cost > 0) info += `${theme.fg("dim", "Cost:")} $${stats.cost.toFixed(4)}\n`;
		this.showCommandReport({ title: "Advisor Status", body: new Text(info.trim(), 0, 0) });
	}

	/**
	 * `/jobs`: natively the live jobs sheet the jobs pill opens (inspect and
	 * cancel included); `/jobs full`, and text mode, a report of the running
	 * and recent jobs (see {@link showCommandReport}).
	 */
	async handleJobsCommand(options?: { full?: boolean }): Promise<void> {
		const full = options?.full === true;
		const snapshot = this.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
		if (!snapshot) {
			this.ctx.showWarning("Async background jobs are unavailable in this session.");
			return;
		}
		if (isNativeRendering() && !full) {
			this.ctx.showJobsSheet();
			return;
		}

		const now = Date.now();
		const columns = this.ctx.ui.terminal.columns ?? 100;
		const lineWidth = Math.max(24, columns - 24);
		let info = `${theme.fg("dim", "Running:")} ${snapshot.running.length}\n`;
		if (snapshot.running.length === 0 && snapshot.recent.length === 0) {
			info += `\n${theme.fg("dim", "No async jobs yet.")}`;
			this.showCommandReport({ title: "Background Jobs", body: new Text(info, 0, 0) });
			return;
		}

		// Full mode wraps here so every line, including heredoc lines and wrap
		// continuations, keeps the two-column indent under its job row inside the
		// report box.
		const commandWidth = Math.max(1, columns - 6);
		const describe = (job: AsyncJobSnapshotItem): string => {
			if (!full) return `  ${theme.fg("dim", truncateJobLabel(job.label, lineWidth))}`;
			const command = replaceTabs(sanitizeText(job.command ?? job.label));
			return wrapTextWithAnsi(command, commandWidth)
				.map(line => `  ${theme.fg("dim", line)}`)
				.join("\n");
		};

		if (snapshot.running.length > 0) {
			info += `\n${theme.bold("Running Jobs")}\n`;
			for (const job of snapshot.running) {
				info += `${renderJobLine(job, now)}\n`;
				info += `${describe(job)}\n`;
			}
		}

		if (snapshot.recent.length > 0) {
			info += `\n${theme.bold("Recent Jobs")}\n`;
			for (const job of snapshot.recent) {
				info += `${renderJobLine(job, now)}\n`;
				info += `${describe(job)}\n`;
			}
		}

		this.showCommandReport({ title: "Background Jobs", body: new Text(info.trimEnd(), 0, 0) });
	}
	async handleAccountCommand(reports?: UsageReport[] | null): Promise<void> {
		let usageReports = reports ?? [];
		let fetchFailed = false;
		if (reports === undefined || reports === null) {
			const provider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
			if (provider.fetchUsageReports) {
				try {
					usageReports = (await provider.fetchUsageReports()) ?? [];
				} catch {
					fetchFailed = true;
				}
			}
		}

		const authStorage = this.ctx.session.modelRegistry.authStorage;
		try {
			await authStorage.credentials.revalidate();
		} catch {
			// Stale identities beat omitting an account.
		}
		const accounts = collectStoredUsageAccounts(authStorage);
		let disabled: DisabledCredentialSummary[] = [];
		try {
			disabled = await authStorage.credentials.listDisabled();
		} catch {
			// A broker predating tombstone listing still returns active accounts.
		}
		this.ctx.showAccountDashboard(usageReports, accounts, disabled, fetchFailed);
	}

	async handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		let usageReports = reports ?? null;
		if (!usageReports) {
			const provider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
			if (!provider.fetchUsageReports) {
				this.ctx.showWarning("Usage reporting is not configured for this session.");
				return;
			}
			try {
				usageReports = await provider.fetchUsageReports();
			} catch (error) {
				this.ctx.showError(`Failed to fetch usage data: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		this.ctx.showUsageDashboard(usageReports ?? []);
	}

	async handleChangelogCommand(args = ""): Promise<void> {
		const view = parseChangelogView(args);
		if ("error" in view) {
			this.ctx.showWarning(view.error);
			return;
		}
		const changelogPath = getChangelogPath();
		const allEntries = await parseChangelog(changelogPath);
		const entriesToShow = selectChangelogEntries(allEntries, view);
		const changelogMarkdown =
			entriesToShow.length > 0 ? renderChangelogEntries(entriesToShow).markdown : "No changelog entries found.";
		const shown = entriesToShow.length;
		const titleCount = shown > 0 ? shown : view.kind === "last" ? view.count : shown;
		const title =
			view.kind === "full"
				? "Full Changelog"
				: view.kind === "last"
					? titleCount === 1
						? "Last Release"
						: `Last ${titleCount} Releases`
					: "Recent Changes";
		const hint =
			view.kind === "full"
				? ""
				: `\n\n${theme.fg("dim", "Use")} ${theme.bold("/changelog full")} ${theme.fg("dim", "to view the complete changelog.")}`;

		this.#showMarkdownPanel(title, changelogMarkdown + hint);
	}

	handleHotkeysCommand(): void {
		const bindings = { keybindings: this.ctx.keybindings };
		if (isNativeRendering()) {
			// A native terminal gets a dismissable sheet with keycaps instead of a markdown table.
			const sheet = new HotkeysSheetComponent(bindings, () => {
				handle.hide();
				this.ctx.ui.setFocus(this.ctx.editorContainer.children[0] ?? this.ctx.editor);
				this.ctx.ui.requestRender();
			});
			const handle = this.ctx.ui.showOverlay(sheet, { anchor: "center", width: "90%", maxHeight: "90%" });
			this.ctx.ui.setFocus(sheet);
			this.ctx.ui.requestRender();
			return;
		}
		this.#showMarkdownPanel("Keyboard Shortcuts", buildHotkeysMarkdown(bindings));
	}

	handleToolsCommand(): void {
		const tools = buildToolsMarkdown({
			tools: this.ctx.session.agent.state.tools,
			xdevTools: this.ctx.session.getXdevToolEntries(),
		});
		this.#showMarkdownPanel("Available Tools", tools);
	}

	handleContextCommand(): void {
		const breakdown = computeSessionContextBreakdown(this.ctx.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			this.ctx.showWarning("Context usage is unavailable: no model is selected for this session.");
			return;
		}
		// Natively the body is `/context`'s own card (meters, legend, compaction mark).
		this.showCommandReport({
			title: "Context Usage",
			head: contextUsageHead(breakdown),
			body: new ContextUsageView(breakdown, theme),
		});
	}

	async handleMemoryCommand(text: string): Promise<void> {
		const argumentText = text.slice(7).trim();
		const action = argumentText.split(/\s+/, 1)[0]?.toLowerCase() || "view";
		const agentDir = this.ctx.settings.getAgentDir();
		const backend = await resolveMemoryBackend(this.ctx.settings);

		if (action === "view") {
			const payload = await backend.buildDeveloperInstructions(agentDir, this.ctx.settings, this.ctx.session);
			if (!payload) {
				this.ctx.showWarning("Memory payload is empty (memory backend off, disabled, or no memory available).");
				return;
			}
			this.#showMarkdownPanel("Memory Injection Payload", payload);
			return;
		}

		if (action === "reset" || action === "clear") {
			try {
				await backend.clear(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				await this.ctx.session.refreshBaseSystemPrompt();
				this.ctx.showStatus("Memory data cleared and system prompt refreshed.");
			} catch (error) {
				this.ctx.showError(`Memory clear failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "enqueue" || action === "rebuild") {
			try {
				await backend.enqueue(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				this.ctx.showStatus("Memory consolidation enqueued.");
			} catch (error) {
				this.ctx.showError(`Memory enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}
		if (action === "queue") {
			try {
				const payload = await backend.queuePreview?.({
					agentDir,
					cwd: this.ctx.sessionManager.getCwd(),
					session: this.ctx.session,
				});
				if (!payload) {
					this.ctx.showWarning(`Memory queue is not available for the ${backend.id} backend.`);
					return;
				}
				this.#showMarkdownPanel("Memory Queue", payload);
			} catch (error) {
				this.ctx.showError(`Memory queue failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "sync") {
			try {
				await backend.enqueue(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				this.ctx.showStatus("Memory consolidation ran.");
			} catch (error) {
				this.ctx.showError(`Memory sync failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "stats" || action === "diagnose") {
			const hook = action === "stats" ? backend.stats : backend.diagnose;
			try {
				const payload = await hook?.(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				if (!payload) {
					this.ctx.showWarning(memoryStatsUnavailableMessage(backend.id, action));
					return;
				}
				this.#showMarkdownPanel(`Memory ${action === "stats" ? "Stats" : "Diagnostics"}`, payload);
			} catch (error) {
				this.ctx.showError(`Memory ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "mm") {
			await this.#handleMentalModelsSubcommand(argumentText);
			return;
		}

		this.ctx.showError("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|queue|sync|mm ...>");
	}

	async #handleMentalModelsSubcommand(argumentText: string): Promise<void> {
		// Parse: "mm <verb> [arg]"
		const parts = argumentText.split(/\s+/).slice(1);
		const verb = parts[0]?.toLowerCase() ?? "list";
		const arg = parts[1];

		const state = this.ctx.session.getHindsightSessionState();
		const primary = state && !state.aliasOf ? state : undefined;
		if (!primary) {
			this.ctx.showError("Hindsight backend is not active for this session.");
			return;
		}
		if (!primary.config.mentalModelsEnabled) {
			this.ctx.showError("Mental models are disabled (hindsight.mentalModelsEnabled = false).");
			return;
		}

		switch (verb) {
			case "list":
				await this.#mmList(primary);
				return;
			case "show":
				if (!arg) return this.ctx.showError("Usage: /memory mm show <id>");
				await this.#mmShow(primary, arg);
				return;
			case "refresh":
				await this.#mmRefresh(primary, arg);
				return;
			case "history":
				if (!arg) return this.ctx.showError("Usage: /memory mm history <id>");
				await this.#mmHistory(primary, arg);
				return;
			case "seed":
				await this.#mmSeed(primary);
				return;
			case "reload":
				await this.#mmReload(primary);
				return;
			case "delete":
			case "remove":
				if (!arg) return this.ctx.showError("Usage: /memory mm delete <id>");
				await this.#mmDelete(primary, arg);
				return;
			default:
				this.ctx.showError("Usage: /memory mm <list|show|refresh|history|seed|reload|delete>");
		}
	}

	async #mmList(state: HindsightSessionState): Promise<void> {
		const client: HindsightApi = state.client;
		try {
			const response = await client.listMentalModels(state.bankId, { detail: "metadata" });
			const items = response.items ?? [];
			if (items.length === 0) {
				this.ctx.showStatus(`No mental models on bank ${state.bankId}.`);
				return;
			}
			const lines = items
				.slice()
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(summarizeMentalModel);
			this.#showMarkdownPanel(`Mental Models — ${state.bankId}`, lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`mm list failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmShow(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const model = await state.client.getMentalModel(state.bankId, id, { detail: "content" });
			if (!model) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			const tags = model.tags && model.tags.length > 0 ? `\n_tags: ${model.tags.join(", ")}_` : "";
			const refreshed = model.last_refreshed_at ? `\n_last refreshed: ${model.last_refreshed_at}_` : "";
			const sourceQuery = model.source_query ? `\n\n**Source query:** ${model.source_query}` : "";
			const content = (model.content ?? "_(empty — background reflect may still be running)_").trim();
			this.#showMarkdownPanel(model.name, `**id:** \`${model.id}\`${tags}${refreshed}${sourceQuery}\n\n${content}`);
		} catch (error) {
			this.ctx.showError(`mm show failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmRefresh(state: HindsightSessionState, id: string | undefined): Promise<void> {
		try {
			if (id) {
				// Single-model refresh is explicit operator intent: bypass the
				// auto-refresh filter so curated/manual models can still be
				// refreshed on demand.
				await state.client.refreshMentalModel(state.bankId, id);
				this.ctx.showStatus(`Refresh queued for mental model ${id}.`);
			} else {
				// Bulk refresh: only touch models that opted into automatic
				// refresh via `trigger.refresh_after_consolidation`. Curated
				// models are reviewed before publishing and must not be
				// silently regenerated by a bank-wide refresh sweep. Reading
				// `detail: "content"` here is required because the trigger
				// field is excluded from `detail: "metadata"`.
				const list = await state.client.listMentalModels(state.bankId, { detail: "content" });
				const items = list.items ?? [];
				if (items.length === 0) {
					this.ctx.showStatus(`No mental models on bank ${state.bankId}.`);
					return;
				}
				const targets = items.filter(m => m.trigger?.refresh_after_consolidation === true);
				const skipped = items.length - targets.length;
				if (targets.length === 0) {
					this.ctx.showStatus(
						`No mental models opted into auto-refresh; ${skipped} curated model(s) left untouched. Pass an explicit id to refresh one of them.`,
					);
					return;
				}
				let queued = 0;
				for (const item of targets) {
					try {
						await state.client.refreshMentalModel(state.bankId, item.id);
						queued++;
					} catch (error) {
						this.ctx.showWarning(
							`Refresh failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				const skippedSuffix = skipped > 0 ? `; skipped ${skipped} curated model(s)` : "";
				this.ctx.showStatus(
					`Refresh queued for ${queued}/${targets.length} auto-refresh model(s)${skippedSuffix}.`,
				);
			}
			// Reload the cache after a brief grace so the new content (if the refresh
			// completes synchronously on the server) flows into the system prompt.
			await Bun.sleep(500);
			await reloadMentalModelsForSession(state.session);
		} catch (error) {
			this.ctx.showError(`mm refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmHistory(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const [model, history] = await Promise.all([
				state.client.getMentalModel(state.bankId, id, { detail: "content" }),
				state.client.getMentalModelHistory(state.bankId, id),
			]);
			if (!model) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			if (history.length === 0) {
				this.ctx.showStatus(`No history recorded for ${id}.`);
				return;
			}
			// History is most-recent first. Each entry stores the content BEFORE that
			// change. To diff "what changed at entry N", compare entry N's
			// previous_content (= state before that change) with entry N-1's
			// previous_content (= state after that change, which was state before
			// the next change). For the most recent change, compare against the
			// model's CURRENT content.
			const sections: string[] = [];
			for (let i = 0; i < history.length; i++) {
				const before = history[i].previous_content ?? "";
				const after = i === 0 ? (model.content ?? "") : (history[i - 1].previous_content ?? "");
				const diff = diffMentalModelContent(before, after);
				sections.push(`### ${history[i].changed_at}\n\n\`\`\`diff\n${diff}\n\`\`\``);
			}
			this.#showMarkdownPanel(`History — ${model.name}`, sections.join("\n\n"));
		} catch (error) {
			this.ctx.showError(`mm history failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmSeed(state: HindsightSessionState): Promise<void> {
		try {
			const config = loadHindsightConfig(this.ctx.settings);
			const seeds = resolveSeedsForScope(
				{
					bankId: state.bankId,
					retainTags: state.retainTags,
					recallTags: state.recallTags,
					recallTagsMatch: state.recallTagsMatch,
				},
				config.scoping,
			);
			if (seeds.length === 0) {
				this.ctx.showStatus(`No built-in seeds apply to scoping=${config.scoping}.`);
				return;
			}
			const list = await state.client.listMentalModels(state.bankId, { detail: "metadata" });
			const existing = list.items ?? [];
			let created = 0;
			let skipped = 0;
			for (const seed of seeds) {
				if (seedAlreadyExists(seed, existing)) {
					skipped++;
					continue;
				}
				try {
					await state.client.createMentalModel(state.bankId, seed.name, seed.sourceQuery, {
						id: seed.id,
						tags: seed.tags.length > 0 ? seed.tags : undefined,
						maxTokens: seed.maxTokens,
						trigger: seed.trigger,
					});
					created++;
				} catch (error) {
					this.ctx.showWarning(
						`Seed failed for ${seed.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			this.ctx.showStatus(`Seeded ${created} new mental model(s); ${skipped} already present.`);
		} catch (error) {
			this.ctx.showError(`mm seed failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmReload(state: HindsightSessionState): Promise<void> {
		const ok = await reloadMentalModelsForSession(state.session);
		if (ok) {
			this.ctx.showStatus("Mental-model cache reloaded.");
		} else {
			this.ctx.showError("Reload failed (Hindsight backend not active or mental models disabled).");
		}
	}

	async #mmDelete(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const removed = await state.client.deleteMentalModel(state.bankId, id);
			if (!removed) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			// Drop the cached snippet so the closing tag does not silently keep
			// stale content in the system prompt until the next agent_end TTL.
			await reloadMentalModelsForSession(state.session);
			this.ctx.showStatus(`Deleted mental model ${id} from bank ${state.bankId}.`);
		} catch (error) {
			this.ctx.showError(`mm delete failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #runNewSessionFlow(options?: NewSessionOptions, label: string = "New session started"): Promise<void> {
		this.ctx.clearTransientSessionUi();

		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		if (!(await this.ctx.session.newSession(options))) return;
		// A focused subagent view keeps its own history: return to the main session
		// first so the transcript below cannot rebuild from the subagent's surviving
		// conversation, then drop any turn-scoped anchors (coalescing timers,
		// in-flight dispatches) the session boundary orphaned.
		if (this.ctx.focusedAgentId) await this.ctx.unfocusSession();
		this.ctx.eventController.resetTranscriptAnchors();
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

		this.ctx.statusLine.invalidate();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();

		this.ctx.present([new Spacer(1), new Text(`${theme.fg("accent", `${theme.status.success} ${label}`)}`, 1, 1)]);
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleClearCommand(): Promise<void> {
		await this.#runNewSessionFlow();
	}

	async handleFreshCommand(): Promise<void> {
		const result = this.ctx.session.freshSession();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before refreshing provider state.");
			return;
		}
		const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(`Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`);
	}

	async handleResetContextCommand(): Promise<void> {
		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		const result = await this.ctx.session.resetSessionContext();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before resetting the context.");
			return;
		}
		// Drop the rendered transcript so the UI matches the now-empty model
		// context (mirrors #runNewSessionFlow's teardown, minus the new session —
		// the session id, title, and transcript file all survive).
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorBorderColor();
		const noun = result.droppedCount === 1 ? "message" : "messages";
		this.ctx.present([
			new Spacer(1),
			new Text(
				`${theme.fg("accent", `${theme.status.success} Context reset — ${result.droppedCount} ${noun} dropped; session continues.`)}`,
				1,
				1,
			),
		]);
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	async handleDeleteCommand(): Promise<void> {
		if (!this.ctx.sessionManager.getSessionFile()) {
			this.ctx.showError("Nothing to delete (in-memory session)");
			return;
		}
		await this.#runNewSessionFlow({ drop: true }, "Session deleted");
	}

	async handleForkCommand(): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before forking.");
			return;
		}
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		// After a `/fork`, the current session ID is changed to the forked one,
		// so the session ID before the fork is the one we want to show in the hint.
		const previousSessionId = this.ctx.sessionManager.isSessionOnDisk()
			? this.ctx.sessionManager.getSessionId()
			: undefined;

		const success = await this.ctx.session.fork();
		if (!success) {
			this.ctx.showError("Fork failed (session not persisted or cancelled)");
			return;
		}

		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();

		this.ctx.present([
			new Spacer(1),
			new Text(
				theme.fg(
					"accent",
					previousSessionId
						? `${theme.status.success} Session forked · return to original: ${resumeCommand(previousSessionId)} or /resume ${previousSessionId}`
						: `${theme.status.success} Session forked`,
				),
				1,
				1,
			),
		]);
	}

	/**
	 * `/move` — relocate the current session to a different directory.
	 *
	 * With no `targetPath` (TUI only), opens an autocomplete overlay so the user
	 * can pick or type a directory. With a `targetPath`, resolves it directly.
	 * If the target directory does not exist, the user is asked whether to create
	 * it. The active session file and artifacts are moved into the target
	 * directory's session bucket so `/resume` from that directory can find it.
	 */
	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before moving.");
			return;
		}

		let input: string | undefined = targetPath?.trim() || undefined;

		// No argument in TUI mode: open the path autocomplete overlay.
		if (!input) {
			const result = await this.ctx.showHookCustom<MoveOverlayResult | undefined>(
				(_tui, _theme, _keybindings, done) =>
					new MoveOverlay(this.ctx.sessionManager.getCwd(), done, moveDirectorySource),
				{ overlay: true },
			);
			if (!result) return; // cancelled
			input = result.directory;
		}

		const unquoted = stripOuterDoubleQuotes(input);
		if (!unquoted) {
			this.ctx.showError("Usage: /move <path>");
			return;
		}

		const cwd = this.ctx.sessionManager.getCwd();
		const resolvedPath = resolveToCwd(unquoted, cwd);

		// If the directory doesn't exist, offer to create it.
		let isDirectory: boolean;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}

		if (!isDirectory) {
			const parentDir = path.dirname(resolvedPath);
			let parentExists = false;
			try {
				parentExists = (await fs.stat(parentDir)).isDirectory();
			} catch {
				parentExists = false;
			}
			if (!parentExists) {
				this.ctx.showError(`Cannot create "${path.basename(resolvedPath)}": parent directory does not exist`);
				return;
			}
		}
		const moved = await this.#withSessionMove(async () => {
			if (!isDirectory) {
				const confirmed = await this.ctx.showHookConfirm(
					"Create directory?",
					`"${path.basename(resolvedPath)}" does not exist. Create it?`,
				);
				if (!confirmed) return false;
				try {
					await fs.mkdir(resolvedPath, { recursive: true });
				} catch (err) {
					this.ctx.showError(`Failed to create directory: ${err instanceof Error ? err.message : String(err)}`);
					return false;
				}
			}
			return this.#relocateSession(resolvedPath);
		});
		if (moved) {
			this.ctx.present([
				new Spacer(1),
				new Text(`${theme.fg("accent", `${theme.status.success} Moved to ${resolvedPath}`)}`, 1, 1),
			]);
		}
	}

	/**
	 * `/wt [<branch>]` — fork the checkout into a new linked git worktree on
	 * `branch` (default `wt/<timestamp>`), carrying uncommitted changes along,
	 * then relocate the session there like `/move`.
	 */
	async handleWorktreeCommand(branch?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before creating a worktree.");
			return;
		}
		await this.#withSessionMove(async () => {
			const branchName = branch?.trim() || defaultSessionWorktreeBranch();
			const cwd = this.ctx.sessionManager.getCwd();
			this.ctx.statusContainer.disposeChildren();
			const loader = new Loader(
				this.ctx.ui,
				spinner => theme.fg("accent", spinner),
				text => theme.fg("muted", text),
				`Creating worktree on ${branchName}…`,
				getSymbolTheme().spinnerFrames,
			);
			this.ctx.statusContainer.addChild(loader);
			this.ctx.ui.requestRender();
			let worktree: SessionWorktree;
			try {
				worktree = await createSessionWorktree(cwd, this.ctx.settings, branchName);
			} catch (err) {
				this.ctx.showError(`Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			} finally {
				loader.stop();
				this.ctx.statusContainer.disposeChildren();
			}
			if (worktree.cloneError) {
				logger.warn("worktree clone fell back to plain checkout", {
					path: worktree.path,
					error: worktree.cloneError,
				});
			}
			if (!(await this.#relocateSession(worktree.path))) return false;
			const cleanup = await cleanSourceCheckoutIfConfigured(cwd, this.ctx.settings);
			if (cleanup.errorMessage !== undefined) {
				this.ctx.showWarning(`Worktree created, but cleaning source checkout failed: ${cleanup.errorMessage}`);
			}
			this.ctx.present([
				new Spacer(1),
				new Text(
					`${theme.fg("accent", `${theme.status.success} ${formatSessionWorktreeSummary(worktree, cleanup.cleaned)}`)}`,
					1,
					1,
				),
			]);
			return true;
		});
	}

	/** Save source settings before acquiring the gate for a complete relocation operation. */
	async #withSessionMove(operation: () => Promise<boolean>): Promise<boolean> {
		try {
			await this.ctx.settings.flush();
		} catch (err) {
			this.ctx.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}

		return this.ctx.withBtwSessionMove(operation);
	}

	/** Relocate only while #withSessionMove holds the BTW gate; false means no successful move. */
	async #relocateSession(resolvedPath: string): Promise<boolean> {
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return false;

		const previousState = this.ctx.sessionManager.captureState();
		try {
			await this.ctx.session.moveSession(resolvedPath);
		} catch (err) {
			this.ctx.showError(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		let applied = false;
		try {
			applied = await this.ctx.applyCwdChange(resolvedPath);
		} catch (error) {
			await this.#restoreAfterMoveFailure(previousState, error);
			return false;
		}
		if (!applied) {
			await this.#restoreAfterMoveFailure(previousState);
			return false;
		}

		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
		this.ctx.ui.requestRender();
		return true;
	}

	async handleRenameCommand(title: string): Promise<void> {
		const session = this.ctx.session;
		const sessionManager = this.ctx.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const signal = session.titleGenerationSignal;
		let titleRevision = sessionManager.titleRevision;
		const isCurrent = () =>
			this.ctx.session === session &&
			this.ctx.sessionManager === sessionManager &&
			!signal.aborted &&
			sessionManager.getSessionId() === sessionId &&
			sessionManager.titleRevision === titleRevision;
		try {
			const persistence = sessionManager.setSessionName(title, "user");
			titleRevision = sessionManager.titleRevision;
			const stored = await persistence;
			if (!isCurrent()) return;
			if (!stored) {
				this.ctx.showError("Session name cannot be empty.");
				return;
			}
			const name = sessionManager.getSessionName()!;
			this.ctx.showStatus(`Session renamed to "${name}".`);
		} catch (err) {
			if (!isCurrent()) return;
			this.ctx.showError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		const shouldPersistCwd = isPersistentShellCdCommand(command);
		if (isDeferred && shouldPersistCwd) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before changing directories.");
			return;
		}

		if (shouldPersistCwd) {
			await this.#withSessionMove(() => this.#executeBashCommand(command, excludeFromContext, isDeferred, true));
		} else {
			await this.#executeBashCommand(command, excludeFromContext, isDeferred, false);
		}
	}

	/** Returns whether shell execution committed a cwd relocation, not whether the shell command succeeded. */
	async #executeBashCommand(
		command: string,
		excludeFromContext: boolean,
		isDeferred: boolean,
		shouldPersistCwd: boolean,
	): Promise<boolean> {
		this.ctx.bashComponent = new BashExecutionComponent(command, this.ctx.ui, excludeFromContext);

		if (isDeferred) {
			this.ctx.pendingMessagesContainer.addChild(this.ctx.bashComponent);
			this.ctx.pendingBashComponents.push(this.ctx.bashComponent);
		} else {
			this.ctx.present(this.ctx.bashComponent);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executeBash(
				command,
				chunk => {
					if (this.ctx.bashComponent) {
						this.ctx.bashComponent.appendOutput(chunk);
					}
				},
				{
					excludeFromContext,
					useUserShell: true,
					// User-shell zsh/fish `!` commands run on a headless PTY; raw
					// bytes render through the component's vterm replay (color-safe).
					pty: {
						...bashPtyViewport(this.ctx.ui),
						onChunk: chunk => this.ctx.bashComponent?.appendPtyChunk(chunk),
					},
				},
			);
			if (this.ctx.bashComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.bashComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
					artifactError: meta?.artifactError,
					images: result.images,
					showImages: cfgTerminalShowImages.get(this.ctx.settings),
				});
			}
			try {
				if (shouldPersistCwd) return await this.#applyBashResultCwd(result);
			} catch (error) {
				this.ctx.showError(
					`Bash command completed, but OMP failed to update its working directory: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			if (this.ctx.bashComponent) {
				this.ctx.bashComponent.setComplete(undefined, false);
			}
			this.ctx.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		} finally {
			this.ctx.bashComponent = undefined;
			this.ctx.ui.requestRender();
		}
		return false;
	}

	async #applyBashResultCwd(result: BashResult): Promise<boolean> {
		if (result.cancelled || result.exitCode !== 0 || !result.workingDir) return false;
		if (!path.isAbsolute(result.workingDir)) return false;

		const resolvedPath = path.resolve(result.workingDir);
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return false;

		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) return false;

		return this.#relocateSession(resolvedPath);
	}

	async handlePythonCommand(code: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		this.ctx.pythonComponent = new EvalExecutionComponent(code, this.ctx.ui, excludeFromContext);

		if (isDeferred) {
			this.ctx.pendingMessagesContainer.addChild(this.ctx.pythonComponent);
			this.ctx.pendingPythonComponents.push(this.ctx.pythonComponent);
		} else {
			this.ctx.present(this.ctx.pythonComponent);
		}
		this.ctx.ui.requestRender();

		try {
			const result = await this.ctx.session.executePython(
				code,
				chunk => {
					if (this.ctx.pythonComponent) {
						this.ctx.pythonComponent.appendOutput(chunk);
					}
				},
				{ excludeFromContext },
			);

			if (this.ctx.pythonComponent) {
				const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
				this.ctx.pythonComponent.setComplete(result.exitCode, result.cancelled, {
					output: result.output,
					truncation: meta?.truncation,
					artifactError: meta?.artifactError,
				});
			}
		} catch (error) {
			if (this.ctx.pythonComponent) {
				this.ctx.pythonComponent.setComplete(undefined, false);
			}
			this.ctx.showError(`Python execution failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.ctx.pythonComponent = undefined;
		this.ctx.ui.requestRender();
	}

	async handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to compact (no messages yet)");
			return "ok";
		}

		// `internalGuidance` is a private summarizer directive (plan-mode
		// "Approve and compact context") that MUST stay off the public
		// `customInstructions` channel of the `session_before_compact` extension
		// hook — extensions treat that field as user focus and would otherwise
		// bias the summary toward the plan boilerplate (issue #4359). Ride it
		// through as a CompactOptions field instead. That caller also dispatches
		// the execution turn itself, so the compaction must not resume the
		// plan-approval turn it aborted.
		if (internalGuidance) {
			return this.executeCompaction(
				{ internalGuidance, suppressContinuation: true, ...(mode ? { mode } : {}) },
				false,
				beforeFlush,
				mode,
			);
		}
		return this.executeCompaction(customInstructions, false, beforeFlush, mode);
	}

	/**
	 * TUI handler for `/shake`. `elide` drops heavy structural content,
	 * `images` strips image blocks, and `thinking` drops all thinking blocks.
	 * Rebuilds the chat and reports counts.
	 */
	async handleShakeCommand(mode: ShakeMode): Promise<void> {
		let result: ShakeResult;
		try {
			result = await this.ctx.session.shake(mode);
		} catch (error) {
			this.ctx.showError(`Shake failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const dropped =
			result.toolResultsDropped +
			result.blocksDropped +
			(result.imagesDropped ?? 0) +
			(result.thinkingBlocksDropped ?? 0);
		if (dropped === 0) {
			this.ctx.showStatus("Nothing to shake.");
			return;
		}
		this.ctx.rebuildChatFromMessages();
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
		this.ctx.showStatus(formatShakeSummary(result));
	}

	async executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto = false,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		mode?: CompactMode,
	): Promise<CompactionOutcome> {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const cancelHint = `(${appKey(this.ctx.keybindings, "app.interrupt")} to cancel)`;
		const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
		const compactingLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			label,
			getSymbolTheme().spinnerFrames,
		);
		const compactionStartMs = Date.now();
		compactingLoader.setWorkingRow(
			() => ({
				label: isAuto ? "Auto-compacting context…" : "Compacting context…",
				startedAt: compactionStartMs,
				variant: { kind: "compaction" },
				interruptKey: this.ctx.maintenanceInterruptKey(),
			}),
			() => this.ctx.interruptFromPointer(),
		);
		this.ctx.statusContainer.addChild(compactingLoader);
		this.ctx.ui.requestRender();

		let outcome: CompactionOutcome = "ok";
		try {
			const instructions = typeof customInstructionsOrOptions === "string" ? customInstructionsOrOptions : undefined;
			const baseOptions =
				customInstructionsOrOptions && typeof customInstructionsOrOptions === "object"
					? customInstructionsOrOptions
					: undefined;
			// The slash path passes `mode` positionally; the extension path carries
			// it inside the options object. Either source wins over no mode.
			const effectiveMode = mode ?? baseOptions?.mode;
			const options =
				baseOptions || effectiveMode
					? { ...baseOptions, ...(effectiveMode ? { mode: effectiveMode } : {}) }
					: undefined;
			await this.ctx.session.compact(instructions, options);

			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
			this.ctx.rebuildChatFromMessages({ reuseSettledComponents: true });

			this.ctx.statusLine.invalidate();
			// Same pairing as the auto-compaction arm in event-controller: the
			// rebuild clears the container's emission ledger, so every block
			// re-emits on this frame while the previous copy is still in native
			// scrollback — without a clear the collapse-disabled path appends a
			// duplicate transcript, exactly as `/compact` reproduced (#12140).
			this.ctx.ui.requestRender(true, { clearScrollback: true });
		} catch (error) {
			if (error instanceof CompactionCancelledError) {
				outcome = "cancelled";
				this.ctx.showError("Compaction cancelled");
			} else {
				outcome = "failed";
				const message = error instanceof Error ? error.message : String(error);
				this.ctx.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.ctx.statusContainer.disposeChildren();
		}
		// Run the caller's pre-flush hook (e.g. the plan-approval model transition)
		// before queued user input is dispatched, so any turn queued during
		// compaction executes on the post-compaction model rather than the model
		// compaction itself ran on.
		if (beforeFlush) await beforeFlush(outcome);
		await this.ctx.flushCompactionQueue({ willRetry: false });
		return outcome;
	}

	async handleHandoffCommand(customInstructions?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before handing off.");
			return;
		}
		if (this.ctx.session.isCompacting) {
			this.ctx.showWarning("Wait for context compaction to finish or cancel it before handing off.");
			return;
		}

		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to hand off (no messages yet)");
			return;
		}

		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		this.ctx.statusContainer.disposeChildren();

		const handoffLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`Generating handoff… (${appKey(this.ctx.keybindings, "app.interrupt")} to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(handoffLoader);
		this.ctx.ui.requestRender();

		try {
			// Handoff generation runs as a oneshot request; the document is then
			// committed as a compaction entry on this session.
			const result = await this.ctx.session.handoff(customInstructions);

			if (!result) {
				this.ctx.showError("Handoff cancelled");
				return;
			}

			// Rebuild chat from the session, which now shows the handoff compaction divider.
			this.ctx.clearTransientSessionUi();
			await this.ctx.renderInitialMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			await this.ctx.reloadTodos();

			this.ctx.present([
				new Spacer(1),
				new Text(
					`${theme.fg("accent", `${theme.status.success} Context handed off and compacted in place`)}`,
					1,
					1,
				),
			]);
			if (result.savedPath) {
				this.ctx.showStatus(`Handoff document saved to: ${result.savedPath}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// `session.handoff()` normalizes genuine cancellations to this exact message; a
			// provider error (even one named AbortError) is re-thrown verbatim so it surfaces
			// as a real failure instead of a false "cancelled".
			if (message === "Handoff cancelled") {
				this.ctx.showError("Handoff cancelled");
			} else {
				// Persist the real failure so it is debuggable after the transient
				// TUI error clears (#7993).
				logger.error("Handoff failed", { error: message });
				this.ctx.showError(`Handoff failed: ${message}`);
			}
		} finally {
			this.#finishHandoffUi(handoffLoader);
			await this.ctx.flushCompactionQueue({ willRetry: false });
		}
		this.ctx.ui.requestRender(true, { clearScrollback: true });
	}

	#finishHandoffUi(handoffLoader: Loader): void {
		handoffLoader.stop();
		// A retry/compaction event may replace the handoff overlay while transcript
		// replay yields. Preserve it only while it still owns the status row; a
		// reference to a loader disposed earlier must not retain the handoff overlay.
		const maintenanceLoader = this.ctx.autoCompactionLoader ?? this.ctx.retryLoader;
		if (maintenanceLoader && this.ctx.statusContainer.children.includes(maintenanceLoader)) return;
		this.ctx.statusContainer.disposeChildren();
		// `disposeChildren()` disposed any working loader mounted by a delayed
		// `agent_start` during transcript replay, which stops its animation timer.
		// Drop the now-frozen reference so the reconciler below never reattaches it
		// (`ensureLoadingAnimation()` only re-adds an existing instance, never
		// restarts it).
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		if (this.ctx.session.isStreaming) {
			// A new turn won the race with handoff cleanup; mount a fresh, running
			// loader for it now that the stale reference is cleared.
			this.ctx.ensureLoadingAnimation();
		}
	}
}

function renderJobLine(job: AsyncJobSnapshotItem, now: number): string {
	const duration = formatDuration(Math.max(0, (job.endTime ?? now) - job.startTime));
	const status = formatJobStatus(job.status);
	return `${theme.fg("dim", job.id)} ${theme.fg("dim", `[${job.type}]`)} ${status} ${theme.fg("dim", `(${duration})`)}`;
}

function formatJobStatus(status: AsyncJobSnapshotItem["status"]): string {
	if (status === "running") return theme.fg("warning", "running");
	if (status === "completed") return theme.fg("success", "completed");
	if (status === "cancelled") return theme.fg("dim", "cancelled");
	return theme.fg("error", "failed");
}

function truncateJobLabel(label: string, maxWidth: number): string {
	if (visibleWidth(label) <= maxWidth) return label;
	if (maxWidth <= 1) return "…";

	let out = "";
	for (const char of label) {
		const next = `${out}${char}`;
		if (visibleWidth(`${next}…`) > maxWidth) break;
		out = next;
	}

	return `${out}…`;
}

function resolveProviderAuthMode(authStorage: AuthStorage, provider: string): string {
	if (authStorage.credentials.hasOAuth(provider)) {
		return "oauth";
	}
	if (authStorage.credentials.has(provider)) {
		return "api key";
	}
	if (getEnvApiKey(provider)) {
		return "env api key";
	}
	if (authStorage.keys.source(provider) !== undefined) {
		return "runtime/fallback";
	}
	return "unknown";
}

export function renderProviderSection(details: ProviderDetails, uiTheme: Pick<Theme, "fg">): string {
	const lines: string[] = [];
	lines.push(`${uiTheme.fg("dim", "Name:")} ${details.provider}`);
	for (const field of details.fields) {
		lines.push(`${uiTheme.fg("dim", `${field.label}:`)} ${field.value}`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * TUI `/usage` detail renderer (feeds the fullscreen usage dashboard): a
 * per-account breakdown — one section per credential, each limit drawn with a
 * bar, reset time, and plan metadata — with the session's active account
 * marked and the provider's reporting models listed. Shares its layout with
 * `omp usage` via {@link formatUsageBreakdown}; only the color styler differs.
 */
export function renderUsageReports(
	reports: UsageReport[],
	uiTheme: Theme,
	nowMs: number,
	availableWidth: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
	usageModelSelectors: readonly string[] = [],
	unavailableAccounts: readonly UnavailableUsageAccount[] = [],
): string {
	const styler: UsageStyler = {
		bold: text => uiTheme.bold(text),
		dim: text => uiTheme.fg("dim", text),
		accent: text => uiTheme.fg("accent", text),
		boldAccent: text => uiTheme.bold(uiTheme.fg("accent", text)),
		status: (status, text) =>
			uiTheme.fg(
				status === "exhausted" ? "error" : status === "warning" ? "warning" : status === "ok" ? "success" : "dim",
				text,
			),
	};
	return formatUsageBreakdown(reports, [], nowMs, undefined, [], {
		styler,
		resolveActiveAccount,
		resolveModelSelectors: provider => usageModelSelectors.filter(selector => selector.startsWith(`${provider}/`)),
		unavailableAccounts,
		maxWidth: availableWidth,
	});
}
