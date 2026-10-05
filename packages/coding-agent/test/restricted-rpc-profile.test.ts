import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	AGENTDESK_RESTRICTED_RPC_PROFILE,
	applyRestrictedRpcHostProfile,
	assertRestrictedPromptSegments,
	buildRestrictedProfileReceipt,
	RESTRICTED_PROMPT_MANIFEST,
	RESTRICTED_PROMPT_MANIFEST_CANONICAL_JSON,
	RESTRICTED_PROMPT_MANIFEST_DIGEST,
	RESTRICTED_PROMPT_SEGMENT_BYTES,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/restricted-rpc-profile";
import { restrictedDatabaseCompiledDigestMaterial } from "@oh-my-pi/pi-coding-agent/session/restricted-turn-storage";

describe("agentdesk restricted RPC profile", () => {
	it("parses the one named CLI selector and rejects unknown profiles", () => {
		const parsed = parseArgs([
			"--mode",
			"rpc",
			"--rpc-host-profile",
			AGENTDESK_RESTRICTED_RPC_PROFILE,
			"--session-storage",
			"sql",
		]);
		expect(parsed.rpcHostProfile).toBe(AGENTDESK_RESTRICTED_RPC_PROFILE);
		expect(() => parseArgs(["--rpc-host-profile", "unrestricted"])).toThrow("Invalid --rpc-host-profile");
	});

	it("replaces malicious discovery and prompt inputs with exact empty values", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-restricted-profile-"));
		try {
			fs.writeFileSync(path.join(cwd, "AGENTS.md"), "MALICIOUS DISCOVERY INPUT");
			const applied = applyRestrictedRpcHostProfile({
				cwd,
				additionalDirectories: ["/tmp/escape"],
				toolNames: ["bash"],
				contextFiles: [{ path: "AGENTS.md", content: "malicious" }],
				promptTemplates: [{ name: "malicious", description: "", content: "inject", source: "project" }],
				disableExtensionDiscovery: false,
				enableMCP: true,
				enableLsp: true,
				enableIrc: true,
				restrictToolNames: false,
				allowRestrictedCustomTools: true,
				customSystemPrompt: "inject",
				appendSystemPrompt: "inject",
			});
			expect(applied.options).toMatchObject({
				restrictedRpcHostProfile: AGENTDESK_RESTRICTED_RPC_PROFILE,
				additionalDirectories: [],
				toolNames: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				skills: [],
				rules: [],
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				restrictToolNames: true,
				allowRestrictedCustomTools: false,
				customTools: [],
			});
			expect(applied.options.workspaceTree).toEqual({
				rootPath: fs.realpathSync.native(cwd),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			});
			expect(applied.options.customSystemPrompt).toBeUndefined();
			expect(applied.options.appendSystemPrompt).toBeUndefined();
			const receipt = buildRestrictedProfileReceipt({
				runtime: {
					...applied.runtime,
					databaseReceipt: {
						databaseInstanceUuid: "018f47f2-a397-7000-8000-000000000001",
						database: "agentdesk",
						currentUser: "agentdesk_engineering_omp",
						grantDigest: "a".repeat(64),
						contractName: "agentdesk_restricted_rpc",
						contractVersion: 1,
						contractDigest: "b".repeat(64),
						structuralValidatorDigest: "c".repeat(64),
					},
				},
				systemPrompt: RESTRICTED_PROMPT_SEGMENT_BYTES.map(segment => segment.content),
				tools: [],
				model: undefined,
			});
			expect(JSON.stringify(receipt)).not.toContain("MALICIOUS");
			expect(receipt.processStartEvidence).toEqual({
				mcp: false,
				extension: false,
				lsp: false,
				irc: false,
				advisor: false,
				watchdog: false,
				task: false,
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("freezes ordered prompt bytes and rejects mutation, insertion, and reordering", () => {
		const expected = RESTRICTED_PROMPT_SEGMENT_BYTES.map(segment => segment.content);
		expect(() => assertRestrictedPromptSegments(expected)).not.toThrow();
		expect(() => assertRestrictedPromptSegments([`${expected[0]} mutated`, expected[1] ?? ""])).toThrow(
			"does not match",
		);
		expect(() => assertRestrictedPromptSegments([...expected, "injected"])).toThrow("segment count");
		expect(() => assertRestrictedPromptSegments([...expected].reverse())).toThrow("does not match");
		expect(Bun.SHA256.hash(RESTRICTED_PROMPT_MANIFEST_CANONICAL_JSON, "hex")).toBe(RESTRICTED_PROMPT_MANIFEST_DIGEST);
		expect(RESTRICTED_PROMPT_MANIFEST.manifestDigest).toBe(RESTRICTED_PROMPT_MANIFEST_DIGEST);
	});

	it("matches the frozen AgentDesk database receipt golden vector", () => {
		const material = restrictedDatabaseCompiledDigestMaterial(16, "agentdesk_engineering_omp");
		expect(material.grantBytes).toBe(
			'[{"chunks_forbidden":false,"chunks_required":true,"contract_select":true,"identity_select":true,"role":"agentdesk_engineering_omp","turns_forbidden":false,"turns_required":true,"turns_update":true}]',
		);
		expect(material.grantDigest).toBe("3b8574f82a35261fee0ae2684b774da7205ad557d61916a0da99cc04ffefab6e");
		expect(material.structuralValidatorBytes).toHaveLength(4931);
		expect(material.structuralValidatorDigest).toBe(
			"c8788f8b07740b5fd5adc6b551097837a3a00da00b140af7ecb26233cd40f3a6",
		);
	});
});
