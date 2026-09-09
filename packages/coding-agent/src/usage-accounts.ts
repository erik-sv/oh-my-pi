import type { AuthStorage, DisabledCredentialSummary, UsageReport } from "@oh-my-pi/pi-ai";

/** Identity slice of a stored credential used to keep every account visible in usage surfaces. */
export interface UsageAccountIdentity {
	provider: string;
	type: "api_key" | "oauth";
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
	/** Epoch ms of the interactive login that minted the OAuth grant. */
	authorizedAt?: number;
}

/** Read only account identity fields from the credential pool. Secret values never leave AuthStorage. */
export function collectStoredUsageAccounts(authStorage: AuthStorage): UsageAccountIdentity[] {
	const accounts: UsageAccountIdentity[] = [];
	const all = authStorage.getAll();
	for (const provider in all) {
		const entry = all[provider];
		const credentials = Array.isArray(entry) ? entry : [entry];
		for (const credential of credentials) {
			if (credential.type === "oauth") {
				accounts.push({
					provider,
					type: "oauth",
					email: credential.email,
					accountId: credential.accountId,
					projectId: credential.projectId,
					enterpriseUrl: credential.enterpriseUrl,
					orgId: credential.orgId,
					orgName: credential.orgName,
					authorizedAt: credential.authorizedAt,
				});
			} else {
				accounts.push({ provider, type: "api_key" });
			}
		}
	}
	return accounts;
}

/**
 * Keep accounts whose provider can report usage. An explicit provider bypasses
 * the cull so operators can inspect a stored credential even without a usage adapter.
 */
export function selectReportableAccounts(
	accounts: UsageAccountIdentity[],
	hasUsageProvider: (provider: string) => boolean,
	explicitProvider?: string,
): UsageAccountIdentity[] {
	if (explicitProvider) return accounts;
	return accounts.filter(account => hasUsageProvider(account.provider));
}

/** Lowercased identity strings a report can be attributed to. */
function reportIdentifiers(report: UsageReport): Set<string> {
	const ids = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === "string" && value) ids.add(value.toLowerCase());
	};
	const meta = report.metadata ?? {};
	add(meta.email);
	add(meta.accountId);
	add(meta.projectId);
	add(meta.orgId);
	for (const limit of report.limits) {
		add(limit.scope.accountId);
		add(limit.scope.projectId);
		add(limit.scope.orgId);
	}
	return ids;
}

/**
 * Stored credentials that no usage report could be attributed to.
 *
 * Conservative on purpose: when a provider's reports carry no identity at all
 * (or the credential is an API key alongside existing reports), attribution is
 * impossible, so the account is not falsely marked missing.
 */
export function collectUnreportedAccounts(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
): UsageAccountIdentity[] {
	const byProvider = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = byProvider.get(report.provider) ?? [];
		list.push(report);
		byProvider.set(report.provider, list);
	}
	return accounts.filter(account => {
		const providerReports = byProvider.get(account.provider) ?? [];
		if (providerReports.length === 0) return true;
		if (account.type === "api_key") return false;

		// Organization identity is decisive when either side carries it. Two
		// subscriptions can share an email, while two members can share an org,
		// so same-org coverage must still match the member's base identity.
		const accountOrg = account.orgId?.toLowerCase();
		const ids = [account.email, account.accountId, account.projectId]
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map(value => value.toLowerCase());
		const sameOrgReports: UsageReport[] = [];
		let sawReportOrg = false;
		for (const report of providerReports) {
			const metaOrg = report.metadata?.orgId;
			if (typeof metaOrg === "string" && metaOrg) {
				sawReportOrg = true;
				if (accountOrg !== undefined && metaOrg.toLowerCase() === accountOrg) sameOrgReports.push(report);
			}
		}
		if (accountOrg || sawReportOrg) {
			const candidates = accountOrg
				? sameOrgReports
				: providerReports.filter(report => {
						const metaOrg = report.metadata?.orgId;
						return !(typeof metaOrg === "string" && metaOrg);
					});
			if (candidates.length === 0) return true;
			if (ids.length === 0) return false;
			return !candidates.some(report => {
				const identifiers = reportIdentifiers(report);
				return ids.some(id => identifiers.has(id));
			});
		}
		if (ids.length === 0) return false;
		const reported = new Set<string>();
		let anyIdentified = false;
		for (const report of providerReports) {
			const identifiers = reportIdentifiers(report);
			if (identifiers.size > 0) anyIdentified = true;
			for (const id of identifiers) reported.add(id);
		}
		if (!anyIdentified) return false;
		return !ids.some(id => reported.has(id));
	});
}

/** Auto-disabled OAuth credentials worth retaining in account and usage output. */
export function isActionableUsageDisable(
	summary: DisabledCredentialSummary,
	activeAccounts: UsageAccountIdentity[] = [],
): boolean {
	if (summary.type !== "oauth") return false;
	if (/^(replaced by|deleted by user)/i.test(summary.cause)) return false;

	const summaryEmail = summary.email?.toLowerCase();
	const summaryAccountId = summary.accountId?.toLowerCase();
	const summaryOrgId = summary.orgId?.toLowerCase();
	const matchesActive = activeAccounts.some(account => {
		if (account.provider !== summary.provider || account.type !== "oauth") return false;
		const accountEmail = account.email?.toLowerCase();
		const accountAccountId = account.accountId?.toLowerCase();
		const accountOrgId = account.orgId?.toLowerCase();
		// A live sibling subscription or org member does not restore this grant.
		if (summaryOrgId !== accountOrgId) return false;
		if (summaryAccountId && accountAccountId) return summaryAccountId === accountAccountId;
		if (summaryEmail && accountEmail) return summaryEmail === accountEmail;
		return !!summaryOrgId && !summaryEmail && !summaryAccountId && !accountEmail && !accountAccountId;
	});
	return !matchesActive;
}

/** Account label composed only from non-secret identity fields. */
export function usageAccountLabel(account: UsageAccountIdentity): string {
	if (account.type === "api_key") return "API key";
	const base = account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl ?? "OAuth account";
	const org = account.orgName ?? account.orgId;
	return !org || org === base ? base : `${base} · ${org}`;
}

/** Disabled account label composed only from non-secret tombstone identity fields. */
export function disabledUsageAccountLabel(summary: DisabledCredentialSummary): string {
	const base = summary.email ?? summary.accountId ?? "OAuth account";
	const org = summary.orgName ?? summary.orgId;
	return !org || org === base ? base : `${base} · ${org}`;
}

/** Human-sized disable cause: embedded upstream error_description, else the first clause. */
export function shortUsageDisableCause(cause: string): string {
	const description = cause.match(/\\?"error_description\\?"\s*:\s*\\?"([^"\\]+)/)?.[1];
	if (description) return description;
	const stripped = cause.replace(/^oauth refresh failed:\s*/i, "");
	const clause = stripped.split(/[;\n]/, 1)[0] ?? stripped;
	return clause.length > 80 ? `${clause.slice(0, 77)}…` : clause;
}
