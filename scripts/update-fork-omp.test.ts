import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const updateScript = path.join(repoRoot, "scripts", "update-fork-omp.sh");
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
	fs.writeFileSync(
		path.join(nativeDir, `.source-fingerprint-${process.platform}-${process.arch}.node`),
		`${fingerprint}\n`,
	);

	makeExecutable(
		path.join(shimDir, "git"),
		[
			'case "$1 $2 $3" in',
			'  "remote get-url origin") echo "$FORK_URL" ;;',
			'  "rev-parse --short HEAD") echo abc1234 ;;',
			'  "rev-parse HEAD:crates"*) echo native-source-tree ;;',
			"  *) exit 0 ;;",
			"esac",
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
			"  esac",
			"fi",
			'if [ "$1" = "--cwd=packages/natives" ] && [ "$2" = "run" ] && [ "$3" = "build" ]; then',
			'  echo built >> "$TEST_BUILD_LOG"',
			"  exit 0",
			"fi",
			"exit 0",
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
