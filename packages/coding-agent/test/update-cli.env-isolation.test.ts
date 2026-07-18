import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const SECRET_ENV = {
	OPENAI_API_KEY: "ambient-openai-secret",
	ANTHROPIC_API_KEY: "ambient-anthropic-secret",
	DATABASE_URL: "postgres://ambient-database-secret",
	OMP_SESSION_DB_URL: "postgres://ambient-session-secret",
	OMP_SESSION_DB_PASSWORD: "ambient-session-password",
	JWT_SECRET: "ambient-jwt-secret",
	JWT_SIGNING_KEY: "ambient-jwt-signing-key",
	AGENTDESK_API_KEY: "ambient-agentdesk-secret",
	AGENTDESK_CONTROL_TOKEN: "ambient-agentdesk-control-secret",
} as const;

interface ChildEnvCapture {
	command: string;
	args: string[];
	env: Record<string, string>;
}

describe("update CLI subprocess environments", () => {
	it("sanitizes package-manager discovery, install, cache, and version-check children through the shared update path", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-env-"));
		const capturePath = path.join(tempDir, "child-env.jsonl");
		const harnessPath = path.join(tempDir, "run-update.ts");
		const bunPath = path.join(tempDir, "bun");
		const ompPath = path.join(tempDir, "omp");
		const home = path.join(tempDir, "home");
		const miseDataDir = path.join(tempDir, "mise-data");
		const testEnv = {
			...process.env,
			PATH: tempDir,
			HOME: home,
			MISE_DATA_DIR: miseDataDir,
			...SECRET_ENV,
		};
		const appendCapture = `import { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ command: process.argv[1].split("/").at(-1), args, env: process.env }) + "\\n");\n`;

		await Bun.write(
			bunPath,
			`#!${process.execPath}\n${appendCapture}if (args.join(" ") === "pm bin -g") console.log(${JSON.stringify(tempDir)});\n`,
		);
		await Bun.write(ompPath, `#!${process.execPath}\n${appendCapture}console.log("omp/99.0.0");\n`);
		const updateModule = pathToFileURL(path.join(import.meta.dir, "..", "src", "cli", "update-cli.ts")).href;
		const settingsModule = pathToFileURL(path.join(import.meta.dir, "..", "src", "config", "settings.ts")).href;
		const themeModule = pathToFileURL(path.join(import.meta.dir, "..", "src", "modes", "theme", "theme.ts")).href;
		await Bun.write(
			harnessPath,
			`import { runUpdateCommand } from ${JSON.stringify(updateModule)};\nimport { resetSettingsForTest, Settings } from ${JSON.stringify(settingsModule)};\nimport { initTheme } from ${JSON.stringify(themeModule)};\nglobalThis.fetch = async () => new Response(JSON.stringify({ version: "99.0.0" }), { status: 200, headers: { "content-type": "application/json" } });\nconsole.log = () => {};\nresetSettingsForTest();\nawait Settings.init({ inMemory: true });\nawait initTheme(false, undefined, undefined, "dark", "light");\nawait runUpdateCommand({ force: false, check: false });\n`,
		);
		await Promise.all([fs.chmod(bunPath, 0o755), fs.chmod(ompPath, 0o755)]);

		try {
			const harness = Bun.spawn([process.execPath, harnessPath], { env: testEnv, stdout: "pipe", stderr: "pipe" });
			const [exitCode, stdout, stderr] = await Promise.all([
				harness.exited,
				new Response(harness.stdout).text(),
				new Response(harness.stderr).text(),
			]);
			expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
			const captures = (await fs.readFile(capturePath, "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as ChildEnvCapture);

			expect(captures.map(capture => [capture.command, ...capture.args])).toEqual([
				["bun", "pm", "bin", "-g"],
				[
					"bun",
					"install",
					"-g",
					"--no-cache",
					"--registry=https://registry.npmjs.org/",
					expect.any(String),
					expect.any(String),
					expect.any(String),
				],
				["omp", "--version"],
				["bun", "pm", "cache"],
			]);
			for (const capture of captures) {
				expect(capture.env.PATH, `${capture.command} ${capture.args.join(" ")} must retain PATH`).toBe(tempDir);
				expect(capture.env.HOME, `${capture.command} ${capture.args.join(" ")} must retain HOME`).toBe(home);
				expect(
					capture.env.MISE_DATA_DIR,
					`${capture.command} ${capture.args.join(" ")} must retain mise runtime config`,
				).toBe(miseDataDir);
				expect(
					Object.keys(SECRET_ENV).filter(key => capture.env[key] !== undefined),
					`${capture.command} ${capture.args.join(" ")} must not receive ambient provider, database, JWT, or AgentDesk secrets`,
				).toEqual([]);
			}
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
