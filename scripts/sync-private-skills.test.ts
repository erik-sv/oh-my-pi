import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const bootstrapScript = path.join(repoRoot, "scripts", "sync-private-skills.sh");
const tempDirs: string[] = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-private-skills-"));
	tempDirs.push(dir);
	fs.mkdirSync(path.join(dir, "home"));
	fs.mkdirSync(path.join(dir, "xdg-config"));
	return dir;
}

function isolatedEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = {
		...process.env,
		HOME: path.join(root, "home"),
		XDG_CONFIG_HOME: path.join(root, "xdg-config"),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ALLOW_PROTOCOL: "file",
		...extra,
	};
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	return env;
}

function runGit(root: string, args: string[], cwd = root) {
	const result = spawnSync("git", args, {
		cwd,
		env: isolatedEnv(root),
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.status}):\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function createPrivateRemote(root: string, name: string) {
	const remote = path.join(root, `${name}.git`);
	const seed = path.join(root, `${name}-seed`);

	runGit(root, ["init", "--bare", remote]);
	runGit(root, ["init", seed]);
	runGit(root, ["config", "user.name", "Bootstrap Test"], seed);
	runGit(root, ["config", "user.email", "bootstrap-test@example.invalid"], seed);

	const scriptsDir = path.join(seed, "scripts");
	fs.mkdirSync(scriptsDir);
	const syncScript = path.join(scriptsDir, "sync-skills.sh");
	fs.writeFileSync(
		syncScript,
		[
			"#!/bin/sh",
			"set -eu",
			': "${SYNC_STUB_LOG:?SYNC_STUB_LOG is required}"',
			'printf \'%s\\n\' "$@" > "$SYNC_STUB_LOG"',
			'if [ -n "${SYNC_STUB_ERROR_TEXT:-}" ]; then',
			'  printf \'%s\\n\' "$SYNC_STUB_ERROR_TEXT" >&2',
			"fi",
			'exit "${SYNC_STUB_EXIT:-0}"',
			"",
		].join("\n"),
	);
	fs.chmodSync(syncScript, 0o755);

	runGit(root, ["add", "scripts/sync-skills.sh"], seed);
	runGit(root, ["commit", "-m", "Add sync stub"], seed);
	runGit(root, ["branch", "-M", "main"], seed);
	runGit(root, ["remote", "add", "origin", remote], seed);
	runGit(root, ["push", "-u", "origin", "main"], seed);
	runGit(root, ["symbolic-ref", "HEAD", "refs/heads/main"], remote);

	return remote;
}

function cloneCheckout(root: string, remote: string, checkout: string) {
	runGit(root, ["clone", remote, checkout]);
}

function runBootstrap(
	root: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
) {
	return spawnSync("sh", [bootstrapScript, ...args], {
		cwd: root,
		env: isolatedEnv(root, extraEnv),
		encoding: "utf8",
	});
}

function readDelegatedArgs(log: string) {
	return fs.readFileSync(log, "utf8").trimEnd().split("\n");
}

function expectTargetDelegation(args: string[], target: string) {
	const targetFlag = args.indexOf("--target");
	expect(targetFlag).toBeGreaterThanOrEqual(0);
	expect(args[targetFlag + 1]).toBe(target);
	expect(args.filter((arg) => arg === "--target")).toHaveLength(1);
}

beforeAll(() => {
	if (!fs.existsSync(bootstrapScript)) {
		throw new Error(`production bootstrap script is absent: ${bootstrapScript}`);
	}
});

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("scripts/sync-private-skills.sh", () => {
	it("clones a missing checkout and runs its private sync script", () => {
		const root = makeTempDir();
		const remote = createPrivateRemote(root, "private-skills");
		const checkout = path.join(root, "checkout");
		const target = path.join(root, "skill-target");
		const log = path.join(root, "delegated-args.log");

		const result = runBootstrap(
			root,
			["--repo", remote, "--dir", checkout, "--target", target],
			{ SYNC_STUB_LOG: log },
		);

		expect(result.status).toBe(0);
		expect(runGit(root, ["rev-parse", "--is-inside-work-tree"], checkout)).toBe("true");
		expect(runGit(root, ["remote", "get-url", "origin"], checkout)).toBe(remote);
		expectTargetDelegation(readDelegatedArgs(log), target);
	});

	it("delegates an existing checkout with the requested target", () => {
		const root = makeTempDir();
		const remote = createPrivateRemote(root, "private-skills");
		const checkout = path.join(root, "checkout");
		const target = path.join(root, "requested-target");
		const log = path.join(root, "delegated-args.log");
		cloneCheckout(root, remote, checkout);

		const result = runBootstrap(
			root,
			["--repo", remote, "--dir", checkout, "--target", target],
			{ SYNC_STUB_LOG: log },
		);

		expect(result.status).toBe(0);
		expectTargetDelegation(readDelegatedArgs(log), target);
	});

	it("refuses an existing checkout whose origin does not match the requested repository", () => {
		const root = makeTempDir();
		const actualRemote = createPrivateRemote(root, "actual-private-skills");
		const requestedRemote = createPrivateRemote(root, "requested-private-skills");
		const checkout = path.join(root, "checkout");
		const target = path.join(root, "skill-target");
		const log = path.join(root, "delegated-args.log");
		cloneCheckout(root, actualRemote, checkout);

		const result = runBootstrap(
			root,
			["--repo", requestedRemote, "--dir", checkout, "--target", target],
			{ SYNC_STUB_LOG: log },
		);

		expect(result.status).not.toBe(0);
		expect(fs.existsSync(log)).toBe(false);
		expect(runGit(root, ["remote", "get-url", "origin"], checkout)).toBe(actualRemote);
	});

	it("uses the existing checkout offline without contacting its unavailable origin", () => {
		const root = makeTempDir();
		const remote = createPrivateRemote(root, "private-skills");
		const checkout = path.join(root, "checkout");
		const target = path.join(root, "offline-target");
		const log = path.join(root, "delegated-args.log");
		cloneCheckout(root, remote, checkout);
		fs.rmSync(remote, { recursive: true, force: true });

		const result = runBootstrap(
			root,
			["--repo", remote, "--dir", checkout, "--target", target, "--offline"],
			{ SYNC_STUB_LOG: log },
		);

		expect(result.status).toBe(0);
		const delegatedArgs = readDelegatedArgs(log);
		expectTargetDelegation(delegatedArgs, target);
		expect(delegatedArgs.filter((arg) => arg === "--no-pull")).toHaveLength(1);
	});

	it("fails safely offline when the checkout is absent", () => {
		const root = makeTempDir();
		const missingRemote = path.join(root, "unavailable-private-skills.git");
		const checkout = path.join(root, "missing-checkout");
		const target = path.join(root, "skill-target");
		const log = path.join(root, "delegated-args.log");

		const result = runBootstrap(
			root,
			["--repo", missingRemote, "--dir", checkout, "--target", target, "--offline"],
			{ SYNC_STUB_LOG: log },
		);

		expect(result.status).not.toBe(0);
		expect(fs.existsSync(checkout)).toBe(false);
		expect(fs.existsSync(log)).toBe(false);
	});

	it("propagates a delegated private sync failure", () => {
		const root = makeTempDir();
		const remote = createPrivateRemote(root, "private-skills");
		const checkout = path.join(root, "checkout");
		const target = path.join(root, "skill-target");
		const log = path.join(root, "delegated-args.log");
		cloneCheckout(root, remote, checkout);

		const result = runBootstrap(
			root,
			["--repo", remote, "--dir", checkout, "--target", target],
			{
				SYNC_STUB_LOG: log,
				SYNC_STUB_EXIT: "37",
				SYNC_STUB_ERROR_TEXT: "delegated sync failed",
			},
		);

		expect(result.status).toBe(37);
		expect(result.stderr).toContain("delegated sync failed");
		expectTargetDelegation(readDelegatedArgs(log), target);
	});
});
