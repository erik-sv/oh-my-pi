import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createShellCompleter, parsePwdOutput } from "../src/cli/shell-cli";

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
