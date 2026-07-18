import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { createShellCompleter, parsePwdOutput, runShellCommand } from "../src/cli/shell-cli";

const STANDARD_DENIED_ENV = {
	OPENAI_API_KEY: "ambient-openai-secret",
	ANTHROPIC_API_KEY: "ambient-anthropic-secret",
	DATABASE_URL: "postgres://ambient-database-secret",
	OMP_SESSION_DB_URL: "postgres://ambient-session-secret",
	OMP_SESSION_DB_PASSWORD: "ambient-session-password",
	JWT_SECRET: "ambient-jwt-secret",
	JWT_SIGNING_KEY: "ambient-jwt-signing-key",
	AGENTDESK_API_KEY: "ambient-agentdesk-secret",
	AGENTDESK_CONTROL_TOKEN: "ambient-agentdesk-control-secret",
	NPM_TOKEN: "ambient-npm-secret",
	CUSTOM_CREDENTIAL: "ambient-custom-credential",
	INTERNAL_SERVICE_SECRET: "ambient-service-secret",
} as const;

function envPresenceCommand(keys: readonly string[]): string {
	const checks: string[] = [];
	for (const key of keys) checks.push(`printf '%s=%s\\n' '${key}' "\${${key}+x}"`);
	checks.push("printf '%s\\n' '__OMP_ENV_PROBE_DONE__'");
	return checks.join("; ");
}

function parseEnvPresence(output: string): Record<string, boolean> {
	const presence: Record<string, boolean> = {};
	for (const line of output.split(/\r?\n/)) {
		const match = /^([A-Z][A-Z0-9_]*)=(x?)$/.exec(line.trim());
		if (match) presence[match[1]] = match[2] === "x";
	}
	return presence;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

async function runInteractiveShellProbe(cwd: string, command: string): Promise<string> {
	const input = new PassThrough() as PassThrough & { isTTY: boolean };
	const output = new PassThrough() as PassThrough & { columns: number; isTTY: boolean; rows: number };
	const errors = new PassThrough() as PassThrough & { columns: number; isTTY: boolean; rows: number };
	input.isTTY = true;
	Object.assign(output, { columns: 1000, isTTY: true, rows: 40 });
	Object.assign(errors, { columns: 1000, isTTY: true, rows: 40 });

	const streamDescriptors = {
		stdin: Object.getOwnPropertyDescriptor(process, "stdin"),
		stdout: Object.getOwnPropertyDescriptor(process, "stdout"),
		stderr: Object.getOwnPropertyDescriptor(process, "stderr"),
	};
	Object.defineProperties(process, {
		stdin: { configurable: true, value: input },
		stdout: { configurable: true, value: output },
		stderr: { configurable: true, value: errors },
	});

	let transcript = "";
	let promptCount = 0;
	const nextPrompt = Promise.withResolvers<void>();
	output.on("data", chunk => {
		transcript += chunk.toString();
		promptCount = transcript.split("shell> ").length - 1;
		const probeFinished = transcript.split(/\r?\n/).some(line => line.trim() === "__OMP_ENV_PROBE_DONE__");
		if (probeFinished && promptCount >= 2) nextPrompt.resolve();
	});

	try {
		const run = runShellCommand({ cwd, noSnapshot: true });
		input.write(`${command}\n`);
		await nextPrompt.promise;
		input.write(".exit\n");
		await run;
		return transcript;
	} finally {
		input.end();
		output.end();
		errors.end();
		for (const [name, descriptor] of Object.entries(streamDescriptors)) {
			if (descriptor) Object.defineProperty(process, name, descriptor);
		}
	}
}

describe("shell CLI autocomplete", () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shell-complete-"));
		fs.mkdirSync(path.join(baseDir, "docs"));
		fs.mkdirSync(path.join(baseDir, "downloads"));
		fs.mkdirSync(path.join(baseDir, "work notes"));
		fs.writeFileSync(path.join(baseDir, "draft.txt"), "draft\n");
	});

	afterEach(() => {
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it("completes cd arguments from the current shell directory", () => {
		const complete = createShellCompleter(() => baseDir);

		const [matches, prefix] = complete("cd do");

		expect(prefix).toBe("do");
		expect(matches).toEqual(["docs/", "downloads/"]);
	});

	it("escapes spaces in unquoted directory completions", () => {
		const complete = createShellCompleter(() => baseDir);

		const [matches, prefix] = complete("cd work");

		expect(prefix).toBe("work");
		expect(matches).toEqual(["work\\ notes/"]);
	});

	it("completes special shell console commands", () => {
		const complete = createShellCompleter(() => baseDir);

		const [matches, prefix] = complete(".h");

		expect(prefix).toBe(".h");
		expect(matches).toEqual([".help "]);
	});

	it("uses the latest shell cwd callback value", () => {
		const nextDir = path.join(baseDir, "docs");
		fs.mkdirSync(path.join(nextDir, "api"));
		let shellCwd = baseDir;
		const complete = createShellCompleter(() => shellCwd);

		shellCwd = nextDir;
		const [matches] = complete("cd a");

		expect(matches).toEqual(["api/"]);
	});

	it("limits cd completion to directories", () => {
		const complete = createShellCompleter(() => baseDir);

		const [matches] = complete("cd dr");

		expect(matches).toEqual([]);
	});

	it("updates completion cwd from shell pwd output", () => {
		expect(parsePwdOutput("/tmp/example\n")).toBe("/tmp/example");
		expect(parsePwdOutput("\n/var/tmp/project\n\n")).toBe("/var/tmp/project");
		expect(parsePwdOutput("\n")).toBeNull();
	});
});

describe("shell CLI child environment", () => {
	it("retains user runtime variables without exposing ambient service secrets", async () => {
		if (process.platform === "win32") return;

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-shell-cli-env-"));
		const testEnv = {
			HOME: tempDir,
			OMP_TEST_SAFE_VARIABLE: "ambient-safe-value",
			...STANDARD_DENIED_ENV,
		};
		const saved = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
		Object.assign(process.env, testEnv);
		resetSettingsForTest();

		try {
			const keys = ["PATH", "HOME", "OMP_TEST_SAFE_VARIABLE", ...Object.keys(STANDARD_DENIED_ENV)];
			const transcript = await runInteractiveShellProbe(tempDir, envPresenceCommand(keys));
			const presence = parseEnvPresence(transcript);

			expect(presence.PATH).toBe(true);
			expect(presence.HOME).toBe(true);
			expect(presence.OMP_TEST_SAFE_VARIABLE).toBe(true);
			expect(
				Object.keys(STANDARD_DENIED_ENV).filter(key => presence[key]),
				"shell CLI children must not inherit provider, database, identity, or generic credential secrets",
			).toEqual([]);
		} finally {
			restoreEnv(saved);
			resetSettingsForTest();
			removeSyncWithRetries(tempDir);
		}
	});
});
