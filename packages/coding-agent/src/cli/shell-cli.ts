/**
 * Shell CLI command handlers.
 *
 * Handles `omp shell` subcommand for testing the native brush-core shell.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Shell } from "@oh-my-pi/pi-natives";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { buildMinimizerOptions } from "../exec/bash-executor";
import { buildChildEnv, getDeniedChildEnvNames } from "../exec/child-env";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";

export interface ShellCommandArgs {
	cwd?: string;
	timeoutMs?: number;
	noSnapshot?: boolean;
}

export type ShellCompleter = (line: string) => [string[], string];

const COMPLETABLE_DIRECTORY_COMMANDS = new Set(["cd", "pushd"]);
const SPECIAL_COMMANDS = [".exit", ".help"] as const;

interface CompletionToken {
	command: string;
	token: string;
}

function findLastTokenStart(line: string): number {
	let tokenStart = 0;
	let quote: '"' | "'" | null = null;
	let escaped = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === " " || char === "\t") {
			tokenStart = i + 1;
		}
	}
	return tokenStart;
}

function parseCompletionToken(line: string): CompletionToken | null {
	const trimmedStart = line.trimStart();
	if (!trimmedStart) return null;
	const commandEnd = trimmedStart.search(/[ \t]/);
	if (commandEnd === -1) {
		return { command: trimmedStart, token: trimmedStart };
	}
	const command = trimmedStart.slice(0, commandEnd);
	const tokenStart = findLastTokenStart(line);
	return { command, token: line.slice(tokenStart) };
}

function stripOpeningQuote(token: string): { raw: string; quote: '"' | "'" | "" } {
	const quote = token[0];
	if (quote === '"' || quote === "'") {
		return { raw: token.slice(1), quote };
	}
	return { raw: token, quote: "" };
}

function expandHome(rawPath: string): string {
	if (rawPath === "~") return os.homedir();
	if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
	return rawPath;
}

function quoteAwareCompletionValue(rawValue: string, quote: '"' | "'" | ""): string {
	if (quote) return `${quote}${rawValue}`;
	if (!/[\s"'\\]/.test(rawValue)) return rawValue;
	return rawValue.replace(/([\\\s"'])/g, "\\$1");
}

function completeDirectories(currentCwd: string, token: string): string[] {
	const { raw, quote } = stripOpeningQuote(token);
	const expanded = expandHome(raw);
	const searchDir = raw === "" || raw.endsWith("/") ? expanded : path.dirname(expanded);
	const searchPrefix = raw === "" || raw.endsWith("/") ? "" : path.basename(expanded);
	const resolvedSearchDir = path.isAbsolute(searchDir) ? searchDir : path.resolve(currentCwd, searchDir);
	const displayDir = raw === "" || raw.endsWith("/") ? raw : path.dirname(raw);
	const displayPrefix = displayDir === "." ? "" : displayDir.endsWith("/") ? displayDir : `${displayDir}/`;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(resolvedSearchDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const matches: string[] = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(searchPrefix)) continue;
		let isDirectory = entry.isDirectory();
		if (!isDirectory && entry.isSymbolicLink()) {
			try {
				isDirectory = fs.statSync(path.join(resolvedSearchDir, entry.name)).isDirectory();
			} catch {
				continue;
			}
		}
		if (!isDirectory) continue;
		matches.push(quoteAwareCompletionValue(`${displayPrefix}${entry.name}/`, quote));
	}
	return matches.sort((a, b) => a.localeCompare(b));
}

export function createShellCompleter(getCwd: () => string): ShellCompleter {
	return (line: string) => {
		const token = parseCompletionToken(line);
		if (!token) return [SPECIAL_COMMANDS.map(command => `${command} `), line];
		if (token.command.startsWith(".") && !line.includes(" ")) {
			return [
				SPECIAL_COMMANDS.filter(command => command.startsWith(token.command)).map(command => `${command} `),
				line,
			];
		}
		if (!COMPLETABLE_DIRECTORY_COMMANDS.has(token.command)) {
			return [[], token.token];
		}
		return [completeDirectories(getCwd(), token.token), token.token];
	};
}

function quoteShellWord(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function parsePwdOutput(output: string): string | null {
	const lines = output.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i]?.trim();
		if (line && path.isAbsolute(line)) return line;
	}
	return null;
}

async function readShellCwd(shellSession: Shell, fallbackCwd: string): Promise<string> {
	let output = "";
	try {
		const result = await shellSession.run({ command: "pwd", timeoutMs: 1_000 }, (err, chunk) => {
			if (!err) output += chunk;
		});
		if (result.cancelled || result.timedOut || result.exitCode !== 0) return fallbackCwd;
		return parsePwdOutput(output) ?? fallbackCwd;
	} catch {
		return fallbackCwd;
	}
}

export function parseShellArgs(args: string[]): ShellCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "shell") {
		return undefined;
	}

	const result: ShellCommandArgs = {};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cwd" || arg === "-C") {
			result.cwd = args[++i];
		} else if (arg === "--timeout" || arg === "-t") {
			const parsed = Number.parseInt(args[++i], 10);
			if (Number.isFinite(parsed)) {
				result.timeoutMs = parsed;
			}
		} else if (arg === "--no-snapshot") {
			result.noSnapshot = true;
		}
	}

	return result;
}

export async function runShellCommand(cmd: ShellCommandArgs): Promise<void> {
	if (!process.stdin.isTTY) {
		process.stderr.write("Error: shell console requires an interactive TTY.\n");
		process.exit(1);
	}

	const cwd = cmd.cwd ? path.resolve(cmd.cwd) : getProjectDir();
	const settings = await Settings.init({ cwd });
	const { shell, env: shellEnv } = settings.getShellConfig();
	const parentEnv = { ...process.env, ...shellEnv };
	const sessionEnv = buildChildEnv("direct-user-shell", { parentEnv });
	const deniedNames = getDeniedChildEnvNames("direct-user-shell", parentEnv);
	const cleanupPrefix = deniedNames.length > 0 ? `unset ${deniedNames.map(quoteShellWord).join(" ")}; ` : "";
	const snapshotPath = cmd.noSnapshot || !shell.includes("bash") ? null : await getOrCreateSnapshot(shell, sessionEnv);
	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));
	const shellSession = new Shell({ sessionEnv, snapshotPath: snapshotPath ?? undefined, minimizer });

	let active = false;
	let lastChar: string | null = null;

	let shellCwd = cwd;
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
		completer: createShellCompleter(() => shellCwd),
	});
	const prompt = chalk.cyan(`${APP_NAME} shell> `);

	const printHelp = () => {
		process.stdout.write(
			`${chalk.bold("Shell Console Commands")}

` +
				`${chalk.bold("Special Commands:")}
  .help           Show this help
  .exit, exit     Exit the console

` +
				`${chalk.bold("Options:")}
  --cwd, -C <path>     Set working directory for commands
  --timeout, -t <ms>   Timeout per command in milliseconds
  --no-snapshot        Skip sourcing snapshot from user shell

` +
				`${chalk.bold("Notes:")}
  Runs in a persistent brush-core shell session.
  Variables and functions defined in one command persist for the next.
  Tab completes .help/.exit and cd/pushd directory arguments from the shell cwd.

`,
		);
	};

	const interruptHandler = () => {
		if (active) {
			void shellSession.abort();
			return;
		}
		rl.close();
		process.exit(0);
	};

	process.on("SIGINT", interruptHandler);
	process.stdout.write(chalk.dim("Type .help for commands.\n"));

	try {
		while (true) {
			const line = (await rl.question(prompt)).trim();
			if (!line) {
				continue;
			}
			if (line === ".help") {
				printHelp();
				continue;
			}
			if (line === ".exit" || line === "exit" || line === "quit") {
				break;
			}

			active = true;
			lastChar = null;
			try {
				const result = await shellSession.run(
					{
						command: `${cleanupPrefix}${line}`,
						cwd: shellCwd,
						timeoutMs: cmd.timeoutMs,
					},
					(err, chunk) => {
						if (err) {
							process.stderr.write(`${err.message}\n`);
							return;
						}
						if (chunk.length > 0) {
							lastChar = chunk[chunk.length - 1] ?? null;
						}
						process.stdout.write(chunk);
					},
				);

				if (lastChar && lastChar !== "\n") {
					process.stdout.write("\n");
				}

				if (result.timedOut) {
					process.stderr.write(chalk.yellow("Command timed out.\n"));
				} else if (result.cancelled) {
					process.stderr.write(chalk.yellow("Command cancelled.\n"));
				} else if (result.exitCode !== 0 && result.exitCode !== undefined) {
					process.stderr.write(chalk.yellow(`Exit code: ${result.exitCode}\n`));
				}

				if (!result.timedOut && !result.cancelled) {
					shellCwd = await readShellCwd(shellSession, shellCwd);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				process.stderr.write(chalk.red(`Error: ${message}\n`));
			} finally {
				active = false;
			}
		}
	} finally {
		process.off("SIGINT", interruptHandler);
		rl.close();
	}
}

export function printShellHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} shell`)} - Interactive shell console for testing

${chalk.bold("Usage:")}
  ${APP_NAME} shell [options]

${chalk.bold("Options:")}
  --cwd, -C <path>     Set working directory for commands
  --timeout, -t <ms>   Timeout per command in milliseconds
  --no-snapshot        Skip sourcing snapshot from user shell
  -h, --help           Show this help

${chalk.bold("Examples:")}
  ${APP_NAME} shell
  ${APP_NAME} shell --cwd ./tmp
  ${APP_NAME} shell --timeout 2000
`);
}
