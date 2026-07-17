import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const updateScript = path.join(repoRoot, "scripts", "update-fork-omp.sh");
const gitExecutable = Bun.which("git");
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-update-fork-"));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, ...args: string[]): string {
	if (!gitExecutable) throw new Error("git is required for this integration test");
	const result = spawnSync(gitExecutable, args, {
		cwd,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
	}
	return result.stdout.trim();
}

function gitRemoteUrl(cwd: string, remote: string): string | null {
	if (!gitExecutable) throw new Error("git is required for this integration test");
	const result = spawnSync(gitExecutable, ["remote", "get-url", remote], {
		cwd,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

function createBareFork(root: string, name: string, release: string): { bare: string; commit: string } {
	const work = path.join(root, `${name}-work`);
	const bare = path.join(root, `${name}.git`);
	fs.mkdirSync(path.join(work, "packages", "natives", "native"), { recursive: true });
	fs.mkdirSync(path.join(work, "packages", "coding-agent"), { recursive: true });
	fs.writeFileSync(path.join(work, "release.txt"), `${release}\n`);
	fs.writeFileSync(path.join(work, "packages", "natives", "package.json"), '{"version":"1.2.3"}\n');
	fs.writeFileSync(
		path.join(work, "packages", "natives", "native", "pi_natives.test-platform-test-arch.node"),
		"__piNativesV1_2_3\n",
	);
	fs.writeFileSync(path.join(work, "packages", "coding-agent", "package.json"), '{"version":"1.2.3"}\n');

	git(work, "init", "--initial-branch=main");
	git(work, "config", "user.name", "Updater Test");
	git(work, "config", "user.email", "updater-test@example.invalid");
	git(work, "add", ".");
	git(work, "commit", "-m", release);
	const commit = git(work, "rev-parse", "HEAD");
	git(root, "clone", "--bare", work, bare);
	return { bare, commit };
}

function writeToolStubs(root: string): string {
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	const bun = path.join(bin, "bun");
	fs.writeFileSync(
		bun,
		[
			"#!/bin/sh",
			'if [ "$1" = "-e" ]; then',
			"  printf 'test-platform-test-arch'",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
	fs.chmodSync(bun, 0o755);
	const omp = path.join(bin, "omp");
	fs.writeFileSync(omp, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(omp, 0o755);
	return bin;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("scripts/update-fork-omp.sh", () => {
	it("updates from FORK_URL through omp-fork without rewriting an unrelated origin", () => {
		if (!gitExecutable) throw new Error("git is required for this integration test");
		const root = makeTempDir();
		const stale = createBareFork(root, "stale-origin", "stale release");
		const desired = createBareFork(root, "requested-fork", "desired release");
		const checkout = path.join(root, "checkout");
		git(root, "clone", stale.bare, checkout);
		const originalOrigin = git(checkout, "remote", "get-url", "origin");
		const stubBin = writeToolStubs(root);
		const home = path.join(root, "home");
		const xdgData = path.join(root, "xdg-data");
		fs.mkdirSync(home);
		fs.mkdirSync(xdgData);

		const result = spawnSync("/bin/bash", [updateScript], {
			cwd: root,
			env: {
				PATH: [stubBin, path.dirname(gitExecutable), "/usr/bin", "/bin"].join(path.delimiter),
				HOME: home,
				XDG_DATA_HOME: xdgData,
				FORK_DIR: checkout,
				FORK_URL: desired.bare,
				OMP_PRIVATE_SKILLS: "0",
				OMP_SKILLS_DIR: path.join(root, "private-skills"),
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				LC_ALL: "C",
			},
			encoding: "utf8",
		});

		expect(result.status, result.stderr).toBe(0);
		expect({
			head: git(checkout, "rev-parse", "HEAD"),
			origin: gitRemoteUrl(checkout, "origin"),
			ompFork: gitRemoteUrl(checkout, "omp-fork"),
		}).toEqual({
			head: desired.commit,
			origin: originalOrigin,
			ompFork: desired.bare,
		});
	});
});
