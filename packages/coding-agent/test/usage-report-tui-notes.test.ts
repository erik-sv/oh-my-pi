/**
 * Regression coverage for the interactive `/usage` renderer `renderUsageReports`
 * in `command-controller.ts`, which draws the per-account breakdown (shared with
 * `omp usage` via `formatUsageBreakdown`) using the TUI theme styler and feeds
 * the usage dashboard.
 *
 *  1. Provider-wide `UsageReport.notes` render ONCE per provider.
 *  2. The provider's reporting model selectors are listed.
 *  3. Organization suffixes distinguish accounts sharing an email address.
 *  4. The session's active account is marked, org-qualified when present.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

function limit(label: string, windowId: string, durationMs: number, frac: number, notes?: string[]) {
	return {
		id: windowId,
		label,
		scope: { provider: "github-copilot", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 0.8 ? "warning" : "ok",
		...(notes ? { notes } : {}),
	} satisfies UsageReport["limits"][number];
}

function report(provider: string, email: string, limits: UsageReport["limits"], notes?: string[]) {
	return {
		provider,
		fetchedAt: Date.now(),
		limits,
		...(notes ? { notes } : {}),
		metadata: { email },
	} satisfies UsageReport;
}

describe("renderUsageReports (#3268 per-account breakdown)", () => {
	it("renders provider-wide UsageReport.notes exactly once for multiple accounts", () => {
		const providerNote = "Usage data can be delayed by up to five minutes.";
		const reports: UsageReport[] = [
			report(
				"github-copilot",
				"acct-a@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3)],
				[providerNote],
			),
			report(
				"github-copilot",
				"acct-b@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.6)],
				[providerNote],
			),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(providerNote).length - 1;
		expect(occurrences).toBe(1);
	});

	it("lists every model mapped to the provider's live usage data", () => {
		const reports = [
			report("github-copilot", "acct@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.4)]),
		];
		const models = ["github-copilot/gpt-5.6", "github-copilot/claude-sonnet-4.6"];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120, undefined, models));
		expect(text).toContain("Models with usage data");
		expect(text).toContain(models[0]);
		expect(text).toContain(models[1]);
	});

	it("separates same-email accounts by their organization suffix", () => {
		const now = Date.now();
		const accountLimit = () => ({
			...limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3),
			window: {
				id: "rolling-5h",
				label: "5 Hour limit",
				durationMs: 5 * HOUR,
				resetsAt: now + 2.5 * HOUR,
			},
		});
		const reports: UsageReport[] = [
			{
				...report("anthropic", "rae@example.com", [accountLimit()]),
				metadata: { email: "rae@example.com", orgId: "team-org", orgName: "Team Org" },
			},
			report("anthropic", "rae@example.com", [accountLimit()]),
		];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, now, 160));

		expect(text).toContain("rae@example.com · Team Org");
	});
});

describe("renderUsageReports session marker (#5691 org-qualified identity)", () => {
	it("marks the active account and shows its organization", () => {
		const email = "dev@example.test";
		const reports: UsageReport[] = [
			{
				...report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
				metadata: { email, orgId: "uuid-A", orgName: "Team Org" },
			},
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email, orgId: "uuid-A", orgName: "Team Org" } : undefined,
			),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(email);
		expect(marker).toContain("Team Org");
	});

	it("marks the active account when neither side carries an org", () => {
		const email = "solo@example.test";
		const reports: UsageReport[] = [
			report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email } : undefined,
			),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(email);
		expect(marker).not.toContain(" · ");
	});
});
