import {
	resolveUsedFraction,
	type DisabledCredentialSummary,
	type UsageLimit,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import {
	collectStoredUsageAccounts,
	collectUnreportedAccounts,
	disabledUsageAccountLabel,
	isActionableUsageDisable,
	shortUsageDisableCause,
	type UsageAccountIdentity,
	usageAccountLabel,
} from "../../usage-accounts";
import type { SlashCommandRuntime } from "../types";
import { reportMatchesActiveAccount } from "./active-oauth-account";
import { formatDuration, formatProviderName, renderAsciiBar } from "./format";

function formatWindowSuffix(label: string, windowLabel: string | undefined): string {
	if (!windowLabel) return "";
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "quota window" || normalizedLabel.includes(normalizedWindow)) return "";
	return ` — ${windowLabel}`;
}

function formatUsageAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const used = amount.used ?? (amount.usedFraction !== undefined ? amount.usedFraction * 100 : undefined);
	const remainingFraction =
		amount.remainingFraction ??
		(amount.usedFraction !== undefined ? Math.max(0, 1 - amount.usedFraction) : undefined);
	const unit = amount.unit === "percent" ? "%" : ` ${amount.unit}`;
	const usedText = used === undefined ? "unknown used" : `${used.toFixed(2)}${unit} used`;
	const remainingText = remainingFraction === undefined ? "" : ` (${(remainingFraction * 100).toFixed(1)}% left)`;
	return `${usedText}${remainingText}`;
}

function formatUsageReportAccount(report: UsageReport, limit: UsageLimit, index: number): string {
	const metaOrgName = report.metadata?.orgName;
	const metaOrgId = report.metadata?.orgId;
	const org =
		typeof metaOrgName === "string" && metaOrgName
			? metaOrgName
			: typeof metaOrgId === "string" && metaOrgId
				? metaOrgId
				: undefined;
	// Two subscriptions (orgs) can share one email — suffix the org so the rows
	// are tellable apart.
	const email = report.metadata?.email;
	if (typeof email === "string" && email) return org ? `${email} (${org})` : email;
	// Guard metadata values for truthiness before using, then fall back to scope.
	// ?? won't help here: empty string is not null/undefined, so it would suppress
	// a valid scoped fallback (e.g. metadata.accountId="" hides limit.scope.accountId).
	const metaAccountId = report.metadata?.accountId;
	const accountId = typeof metaAccountId === "string" && metaAccountId ? metaAccountId : limit.scope.accountId;
	if (typeof accountId === "string" && accountId) {
		return org && org !== accountId ? `${accountId} (${org})` : accountId;
	}
	const metaProjectId = report.metadata?.projectId;
	const projectId = typeof metaProjectId === "string" && metaProjectId ? metaProjectId : limit.scope.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	return `account ${index + 1}`;
}

function renderUsageReports(
	reports: UsageReport[],
	nowMs: number,
	resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined,
	usageModelSelectors: readonly string[] = [],
): string {
	const latestFetchedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
	const lines = [`Usage${latestFetchedAt ? ` (${formatDuration(nowMs - latestFetchedAt)} ago)` : ""}`];
	const grouped = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const providerReports = grouped.get(report.provider) ?? [];
		providerReports.push(report);
		grouped.set(report.provider, providerReports);
	}

	for (const [provider, providerReports] of [...grouped.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		lines.push("", formatProviderName(provider));
		const reportingModels = usageModelSelectors.filter(selector => selector.startsWith(`${provider}/`));
		if (reportingModels.length > 0) {
			lines.push("  Models with usage data");
			for (const selector of reportingModels) lines.push(`    ${sanitizeText(selector)}`);
		}
		const activeAccount = resolveActiveAccount?.(provider);
		// Provider-wide disclaimers render once per provider, not per limit.
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		for (const note of providerNotes)
			lines.push(`  ${sanitizeText(note.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))}`);
		for (const report of providerReports) {
			const inUse = reportMatchesActiveAccount(report, activeAccount);
			const savedResets = report.resetCredits?.availableCount ?? 0;
			if (savedResets > 0) {
				const resetLabel =
					typeof report.metadata?.email === "string"
						? report.metadata.email
						: typeof report.metadata?.accountId === "string"
							? report.metadata.accountId
							: "account";
				lines.push(
					`- ${resetLabel}: ${savedResets} saved rate-limit reset${savedResets === 1 ? "" : "s"} available — /usage reset to spend`,
				);
				const credits = report.resetCredits?.credits;
				if (credits) {
					for (const credit of credits) {
						if (credit.expiresAt) {
							const expiryMs = Date.parse(credit.expiresAt);
							if (!Number.isNaN(expiryMs)) {
								const remaining = expiryMs - nowMs;
								if (remaining > 0) {
									lines.push(`  expires in ${formatDuration(remaining)} (${credit.expiresAt.slice(0, 10)})`);
								} else {
									lines.push(`  expired (${credit.expiresAt.slice(0, 10)})`);
								}
							}
						}
					}
				}
			}
			if (report.limits.length === 0) {
				const email = typeof report.metadata?.email === "string" ? report.metadata.email : "account";
				lines.push(`- ${email}: no limits reported`);
				continue;
			}
			for (let index = 0; index < report.limits.length; index++) {
				const limit = report.limits[index]!;
				const window = limit.window?.label ?? limit.scope.windowId;
				// Skip the tier suffix when the label already names it (e.g. Anthropic's
				// "Claude 7 Day (Fable)" with scope.tier "fable") — mirrors limitTitle in usage-cli.
				const tier =
					limit.scope.tier && !limit.label.toLowerCase().includes(limit.scope.tier.toLowerCase())
						? ` (${limit.scope.tier})`
						: "";
				lines.push(`- ${limit.label}${tier}${formatWindowSuffix(limit.label, window)}`);
				lines.push(
					`  ${formatUsageReportAccount(report, limit, index)}: ${formatUsageAmount(limit)}${inUse ? "  ← in use by this session" : ""}`,
				);
				lines.push(`  ${renderAsciiBar(limit.amount.usedFraction)}`);
				if (limit.window?.resetsAt && limit.window.resetsAt > nowMs) {
					lines.push(
						`  ${limit.window.resetLabel ?? "resets"} in ${formatDuration(limit.window.resetsAt - nowMs)}`,
					);
				}
				if (limit.notes && limit.notes.length > 0)
					lines.push(
						`  ${limit.notes.map(n => sanitizeText(n.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "))).join(" • ")}`,
					);
			}
		}
	}
	return ["```", ...lines, "```"].join("\n");
}

function sanitizeAccountText(value: string): string {
	return sanitizeText(value.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "));
}

function reportIdentityLabel(report: UsageReport, index: number): string {
	const meta = report.metadata ?? {};
	const email = typeof meta.email === "string" && meta.email ? meta.email : undefined;
	const accountId = typeof meta.accountId === "string" && meta.accountId ? meta.accountId : undefined;
	const projectId = typeof meta.projectId === "string" && meta.projectId ? meta.projectId : undefined;
	const scopedAccount = report.limits.find(limit => limit.scope.accountId)?.scope.accountId;
	const scopedProject = report.limits.find(limit => limit.scope.projectId)?.scope.projectId;
	const base = email ?? accountId ?? projectId ?? scopedAccount ?? scopedProject ?? `account ${index + 1}`;
	const orgName = typeof meta.orgName === "string" && meta.orgName ? meta.orgName : undefined;
	const orgId = typeof meta.orgId === "string" && meta.orgId ? meta.orgId : undefined;
	const org = orgName ?? orgId;
	const label = !org || org === base ? base : `${base} (${org})`;
	return sanitizeAccountText(label);
}

function formatAccountAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const value = (input: number): string => {
		if (amount.unit === "usd") return `$${input.toFixed(2)}`;
		if (amount.unit === "percent") return `${input.toFixed(1)}%`;
		return `${input.toLocaleString()}${amount.unit === "unknown" ? "" : ` ${amount.unit}`}`;
	};
	const parts: string[] = [];
	if (amount.used !== undefined && amount.limit !== undefined) {
		parts.push(`${value(amount.used)} / ${value(amount.limit)}`);
	} else if (amount.used !== undefined) {
		parts.push(`${value(amount.used)} used`);
	}
	if (amount.remaining !== undefined) parts.push(`${value(amount.remaining)} left`);
	const usedFraction = resolveUsedFraction(limit);
	const fractionAlreadyShown = amount.unit === "percent" && amount.used !== undefined;
	if (usedFraction !== undefined && !fractionAlreadyShown) {
		parts.push(`${(usedFraction * 100).toFixed(1)}% used`);
	} else if (amount.remainingFraction !== undefined && !fractionAlreadyShown) {
		parts.push(`${(amount.remainingFraction * 100).toFixed(1)}% left`);
	}
	return parts.length > 0 ? parts.join(" · ") : "usage unknown";
}

/**
 * Provider -> account -> reported-window view shared by `/account` ACP and TUI
 * surfaces. Stored accounts without reports and actionable disabled accounts
 * remain visible under safe identity labels.
 */
export function renderAccountReports(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
	disabled: DisabledCredentialSummary[],
	nowMs: number,
	fetchFailed = false,
): string {
	const reportsByProvider = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const providerReports = reportsByProvider.get(report.provider) ?? [];
		providerReports.push(report);
		reportsByProvider.set(report.provider, providerReports);
	}
	const missingByProvider = new Map<string, UsageAccountIdentity[]>();
	for (const account of collectUnreportedAccounts(reports, accounts)) {
		const providerAccounts = missingByProvider.get(account.provider) ?? [];
		providerAccounts.push(account);
		missingByProvider.set(account.provider, providerAccounts);
	}
	const disabledByProvider = new Map<string, DisabledCredentialSummary[]>();
	for (const summary of disabled) {
		if (!isActionableUsageDisable(summary, accounts)) continue;
		const providerAccounts = disabledByProvider.get(summary.provider) ?? [];
		providerAccounts.push(summary);
		disabledByProvider.set(summary.provider, providerAccounts);
	}
	const providers = [
		...new Set([...reportsByProvider.keys(), ...missingByProvider.keys(), ...disabledByProvider.keys()]),
	].sort((left, right) => left.localeCompare(right));
	const latestFetchedAt = Math.max(0, ...reports.map(report => report.fetchedAt ?? 0));
	const freshness = latestFetchedAt ? ` (checked ${formatDuration(Math.max(0, nowMs - latestFetchedAt))} ago)` : "";
	const lines = [`Accounts${freshness}`];
	if (fetchFailed) lines.push("Usage refresh failed; stored accounts are shown as unavailable.");

	for (const provider of providers) {
		const providerReports = reportsByProvider.get(provider) ?? [];
		const missing = missingByProvider.get(provider) ?? [];
		const disabledAccounts = disabledByProvider.get(provider) ?? [];
		const count = providerReports.length + missing.length + disabledAccounts.length;
		lines.push(
			"",
			`${sanitizeAccountText(formatProviderName(provider))} - ${count} ${count === 1 ? "account" : "accounts"}`,
		);
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		for (const note of providerNotes) lines.push(`  ${sanitizeAccountText(note)}`);

		const orderedReports = [...providerReports].sort((left, right) =>
			reportIdentityLabel(left, 0).localeCompare(reportIdentityLabel(right, 0)),
		);
		for (const [index, report] of orderedReports.entries()) {
			const label = reportIdentityLabel(report, index);
			const plan =
				typeof report.metadata?.planType === "string" && report.metadata.planType
					? sanitizeAccountText(report.metadata.planType)
					: undefined;
			const age = report.fetchedAt ? ` - checked ${formatDuration(Math.max(0, nowMs - report.fetchedAt))} ago` : "";
			lines.push(`  ${label}${plan ? ` (${plan})` : ""}${age}`);
			if (report.limits.length === 0) {
				lines.push("    no limits reported");
				continue;
			}
			for (const limit of report.limits) {
				const tier =
					limit.scope.tier && !limit.label.toLowerCase().includes(limit.scope.tier.toLowerCase())
						? ` (${limit.scope.tier})`
						: "";
				const fraction = resolveUsedFraction(limit);
				const status =
					limit.status && limit.status !== "unknown"
						? limit.status
						: fraction === undefined
							? "unknown"
							: fraction >= 1
								? "exhausted"
								: fraction >= 0.8
									? "warning"
									: "ok";
				const window = limit.window?.label ?? limit.scope.windowId;
				const title = sanitizeAccountText(`${limit.label}${tier}${formatWindowSuffix(limit.label, window)}`);
				lines.push(`    ${title}`);
				lines.push(`      ${formatAccountAmount(limit)} · ${status}`);
				if (limit.window?.resetsAt !== undefined && Number.isFinite(limit.window.resetsAt)) {
					const resetAt = limit.window.resetsAt;
					const reset =
						resetAt > nowMs
							? `${limit.window.resetLabel ?? "resets"} in ${formatDuration(resetAt - nowMs)}`
							: `${limit.window.resetLabel ?? "reset"} at ${new Date(resetAt).toISOString()}`;
					lines.push(`      ${sanitizeAccountText(reset)}`);
				}
				if (limit.notes && limit.notes.length > 0) {
					lines.push(`      ${limit.notes.map(sanitizeAccountText).join(" · ")}`);
				}
			}
		}
		for (const account of [...missing].sort((left, right) =>
			usageAccountLabel(left).localeCompare(usageAccountLabel(right)),
		)) {
			const label = sanitizeAccountText(usageAccountLabel(account));
			lines.push(`  ${label} - unavailable (no usage data)`);
		}
		for (const summary of [...disabledAccounts].sort((left, right) =>
			disabledUsageAccountLabel(left).localeCompare(disabledUsageAccountLabel(right)),
		)) {
			const age =
				summary.disabledAtMs !== undefined
					? ` ${formatDuration(Math.max(0, nowMs - summary.disabledAtMs))} ago`
					: "";
			const label = sanitizeAccountText(disabledUsageAccountLabel(summary));
			const cause = sanitizeAccountText(shortUsageDisableCause(summary.cause));
			lines.push(`  ${label} - unavailable${age}: ${cause} (re-login to restore)`);
		}
	}

	if (providers.length === 0) lines.push("", "No authenticated provider accounts found. Use /login to add one.");
	return lines.join("\n");
}

/** Build the `/account` ACP-mode account subscription report. */
export async function buildAccountReportText(runtime: SlashCommandRuntime): Promise<string> {
	const provider = runtime.session as SlashCommandRuntime["session"] & {
		fetchUsageReports?: () => Promise<UsageReport[] | null>;
	};
	let reports: UsageReport[] = [];
	let fetchFailed = false;
	if (provider.fetchUsageReports) {
		try {
			reports = (await provider.fetchUsageReports()) ?? [];
		} catch {
			fetchFailed = true;
		}
	}
	const authStorage = runtime.session.modelRegistry.authStorage;
	try {
		await authStorage.revalidateCredentials();
	} catch {
		// Stale identities beat omitting an account.
	}
	const accounts = collectStoredUsageAccounts(authStorage);
	let disabled: DisabledCredentialSummary[] = [];
	try {
		disabled = await authStorage.listDisabledCredentials();
	} catch {
		// A broker predating tombstone listing still returns active accounts.
	}
	return ["```", renderAccountReports(reports, accounts, disabled, Date.now(), fetchFailed), "```"].join("\n");
}

/**
 * Build the `/usage` ACP-mode text. Prefers provider-reported limits when the
 * session exposes `fetchUsageReports`; otherwise falls back to the local
 * session-manager tallies.
 */
export async function buildUsageReportText(runtime: SlashCommandRuntime): Promise<string> {
	const provider = runtime.session as SlashCommandRuntime["session"] & {
		fetchUsageReports?: () => Promise<UsageReport[] | null>;
		getUsageReportingModelSelectors?: (reports: readonly UsageReport[]) => string[];
	};
	if (provider.fetchUsageReports) {
		const reports = await provider.fetchUsageReports();
		if (reports && reports.length > 0) {
			const currentProvider = runtime.session.model?.provider;
			const activeAccount = currentProvider
				? runtime.session.modelRegistry.authStorage.getOAuthAccountIdentity(
						currentProvider,
						runtime.session.sessionId,
					)
				: undefined;
			const usageModelSelectors = provider.getUsageReportingModelSelectors?.(reports) ?? [];
			return renderUsageReports(
				reports,
				Date.now(),
				providerId => (providerId === currentProvider ? activeAccount : undefined),
				usageModelSelectors,
			);
		}
	}

	const stats = runtime.session.sessionManager.getUsageStatistics();
	const orchestrationTokens = stats.orchestrationInput + stats.orchestrationOutput + stats.orchestrationCacheRead;
	return [
		"Usage",
		`Input tokens: ${stats.input}`,
		`Output tokens: ${stats.output}`,
		`Cache read tokens: ${stats.cacheRead}`,
		`Cache write tokens: ${stats.cacheWrite}`,
		`Total tokens: ${stats.totalTokens}`,
		...(orchestrationTokens > 0 ? [`Orchestration tokens: ${orchestrationTokens}`] : []),
		`Premium requests: ${stats.premiumRequests}`,
		`Cost: $${stats.cost.toFixed(6)}`,
	].join("\n");
}
