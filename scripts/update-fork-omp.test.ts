import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const updateScript = path.join(repoRoot, "scripts", "update-fork-omp.sh");
const gitExecutable = Bun.which("git");
const tempDirs: string[] = [];

function makeExecutable(file: string, body: string) {
	fs.writeFileSync(file, `#!/bin/sh\n${body}`);
	fs.chmodSync(file, 0o755);
}

function makeFixture(fingerprint = "native-source-tree:") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-update-"));
	tempDirs.push(dir);
	const checkout = path.join(dir, "checkout");
	const shimDir = path.join(dir, "bin");
	const nativeDir = path.join(checkout, "packages", "natives", "native");
	fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
	fs.mkdirSync(nativeDir, { recursive: true });
	fs.mkdirSync(path.join(checkout, "packages", "coding-agent"), { recursive: true });
	fs.mkdirSync(shimDir, { recursive: true });
	fs.writeFileSync(path.join(checkout, "packages", "natives", "package.json"), '{"version":"16.5.0"}\n');
	fs.writeFileSync(path.join(checkout, "packages", "coding-agent", "package.json"), '{"version":"16.5.0"}\n');
	const addon = path.join(nativeDir, `pi_natives.${process.platform}-${process.arch}.node`);
	fs.writeFileSync(addon, "binary payload __piNativesV16_5_0 without the new runtime export");
	const buildLog = path.join(dir, "build.log");
	fs.writeFileSync(path.join(nativeDir, `.source-fingerprint-${process.platform}-${process.arch}.node`), `${fingerprint}\n`);

	makeExecutable(
		path.join(shimDir, "git"),
		[
			'case "$1 $2 $3" in',
			'  "remote get-url origin") echo "$FORK_URL" ;;',
			'  "rev-parse --short HEAD") echo abc1234 ;;',
			'  "rev-parse HEAD:crates"*) echo native-source-tree ;;',
			'  *) exit 0 ;;',
			'esac',
			"",
		].join("\n"),
	);
	makeExecutable(
		path.join(shimDir, "bun"),
		[
			'if [ "$1" = "-e" ]; then',
			'  case "$2" in',
			'    *process.platform*) printf "%s" "$TEST_HOST_TAG"; exit 0 ;;',
			'    *) [ "$PI_REQUIRED_NATIVE_EXPORTS" = "__piNativesV16_5_0,snapcompactSupportedChars" ] || exit 91',
			'       [ "$TEST_EXPORTS_OK" = "1" ] || [ -f "$TEST_BUILD_LOG" ]; exit $? ;;',
			'  esac',
			'fi',
			'if [ "$1" = "--cwd=packages/natives" ] && [ "$2" = "run" ] && [ "$3" = "build" ]; then',
			'  echo built >> "$TEST_BUILD_LOG"',
			'  exit 0',
			'fi',
			'exit 0',
			"",
		].join("\n"),
	);
	makeExecutable(path.join(shimDir, "cargo"), "exit 0\n");

	return { checkout, shimDir, buildLog };
}

function runUpdater(fixture: { checkout: string; shimDir: string; buildLog: string }, exportsAvailable = false) {
	return spawnSync("bash", [updateScript], {
		env: {
			...process.env,
			FORK_DIR: fixture.checkout,
			FORK_URL: "https://example.invalid/fork.git",
			PATH: `${fixture.shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
			TEST_BUILD_LOG: fixture.buildLog,
			TEST_EXPORTS_OK: exportsAvailable ? "1" : "0",
			TEST_HOST_TAG: `${process.platform}-${process.arch}`,
		},
		encoding: "utf8",
	});
}

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
	fs.mkdirSync(path.join(work, "crates"), { recursive: true });
	fs.mkdirSync(path.join(work, "packages", "natives", "native"), { recursive: true });
	fs.mkdirSync(path.join(work, "packages", "natives", "scripts"), { recursive: true });
	fs.mkdirSync(path.join(work, "packages", "coding-agent"), { recursive: true });
	fs.writeFileSync(path.join(work, "release.txt"), `${release}\n`);
	fs.writeFileSync(path.join(work, "Cargo.toml"), "[workspace]\n");
	fs.writeFileSync(path.join(work, "Cargo.lock"), "# updater test fixture\n");
	fs.writeFileSync(path.join(work, "rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n');
	fs.writeFileSync(path.join(work, "crates", "fixture.txt"), `${release}\n`);
	fs.writeFileSync(path.join(work, "packages", "natives", "scripts", "fixture.ts"), `export default ${JSON.stringify(release)};\n`);
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
	makeExecutable(
		path.join(bin, "bun"),
		[
			'if [ "$1" = "-e" ]; then',
			"  printf 'test-platform-test-arch'",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
	makeExecutable(path.join(bin, "cargo"), "exit 0\n");
	makeExecutable(path.join(bin, "omp"), "exit 0\n");
	return bin;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("scripts/update-fork-omp.sh native freshness", () => {
	it("rebuilds a same-version addon that is missing a required runtime export", () => {
		const fixture = makeFixture();
		const result = runUpdater(fixture);

		expect(result.status, result.stderr).toBe(0);
		expect(fs.readFileSync(fixture.buildLog, "utf8")).toBe("built\n");
		expect(result.stdout).toContain("building native addon");
	});

	it("rebuilds when native build inputs change without a version bump", () => {
		const fixture = makeFixture("previous-source-tree:");
		const result = runUpdater(fixture, true);

		expect(result.status, result.stderr).toBe(0);
		expect(fs.readFileSync(fixture.buildLog, "utf8")).toBe("built\n");
	});

	it("skips a current addon only after the fresh-process export probe succeeds", () => {
		const fixture = makeFixture();
		const result = runUpdater(fixture, true);

		expect(result.status, result.stderr).toBe(0);
		expect(fs.existsSync(fixture.buildLog)).toBe(false);
		expect(result.stdout).toContain("matches pi-natives@16.5.0 source and required exports");
	});
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
