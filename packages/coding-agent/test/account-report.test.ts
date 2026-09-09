import { describe, expect, it } from "bun:test";
import type { DisabledCredentialSummary, UsageReport } from "@oh-my-pi/pi-ai";
import { renderAccountReports } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";
import type { UsageAccountIdentity } from "@oh-my-pi/pi-coding-agent/usage-accounts";

const HOUR = 3_600_000;

function limit(
	provider: string,
	id: string,
	label: string,
	window: string,
	usedFraction: number,
	resetsAt: number,
): UsageReport["limits"][number] {
	return {
		id,
		label,
		scope: { provider, windowId: window },
		window: { id: window, label: window, resetsAt },
		amount: { unit: "percent", usedFraction },
		status: usedFraction >= 0.8 ? "warning" : "ok",
	};
}

describe("renderAccountReports", () => {
	it("groups provider -> email -> every reported usage window with utilization, reset, and freshness", () => {
		const now = 1_800_000_000_000;
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: now - 30_000,
				metadata: { email: "zeta@example.test", planType: "Max" },
				limits: [
					limit("anthropic", "weekly", "Claude weekly", "7d", 0.4, now + 4 * 24 * HOUR),
					limit("anthropic", "five-hour", "Claude 5 hour", "5h", 0.82, now + 2 * HOUR),
				],
			},
			{
				provider: "anthropic",
				fetchedAt: now - 45_000,
				metadata: { email: "alpha@example.test", planType: "Pro" },
				limits: [limit("anthropic", "weekly", "Claude weekly", "7d", 0.1, now + 6 * 24 * HOUR)],
			},
		];

		const output = renderAccountReports(reports, [], [], now);
		const alpha = output.indexOf("alpha@example.test");
		const zeta = output.indexOf("zeta@example.test");
		expect(output).toContain("Accounts (checked 30s ago)");
		expect(output).toContain("Anthropic - 2 accounts");
		expect(alpha).toBeGreaterThan(-1);
		expect(zeta).toBeGreaterThan(alpha);
		expect(output.slice(zeta)).toContain("Claude 5 hour");
		expect(output.slice(zeta)).toContain("82.0% used · warning");
		expect(output.slice(zeta)).toContain("resets in 2h");
		expect(output.slice(zeta)).toContain("Claude weekly");
		expect(output.slice(zeta)).toContain("40.0% used · ok");
	});

	it("retains missing and failed accounts with safe labels when email is absent", () => {
		const now = 1_800_000_000_000;
		const accounts: UsageAccountIdentity[] = [{ provider: "xai-oauth", type: "oauth" }];
		const disabled: DisabledCredentialSummary[] = [
			{
				id: 42,
				provider: "anthropic",
				type: "oauth",
				cause: "oauth refresh failed: invalid_grant",
				disabledAtMs: now - 3 * HOUR,
			},
		];

		const output = renderAccountReports([], accounts, disabled, now, true);
		expect(output).toContain("Usage refresh failed; stored accounts are shown as unavailable.");
		expect(output).toContain("Xai Oauth - 1 account");
		expect(output).toContain("OAuth account - unavailable (no usage data)");
		expect(output).toContain("Anthropic - 1 account");
		expect(output).toContain("OAuth account - unavailable 3h ago: invalid_grant (re-login to restore)");
		expect(output).not.toContain("undefined");
	});

	it("keeps disabled sibling subscriptions and members visible until that identity is restored", () => {
		const active: UsageAccountIdentity = {
			provider: "anthropic",
			type: "oauth",
			email: "alice@example.test",
			accountId: "alice",
			orgId: "team",
		};
		const disabled: DisabledCredentialSummary[] = [
			{ id: 1, ...active, orgId: "personal", cause: "invalid_grant" },
			{ id: 2, ...active, email: "bob@example.test", accountId: "bob", cause: "invalid_grant" },
			{ id: 3, ...active, cause: "invalid_grant" },
		];
		const output = renderAccountReports([], [active], disabled, 1_800_000_000_000);
		expect(output).toContain("alice@example.test · personal - unavailable");
		expect(output).toContain("bob@example.test · team - unavailable");
		expect(output).not.toContain("alice@example.test · team - unavailable: invalid_grant");
	});
});
