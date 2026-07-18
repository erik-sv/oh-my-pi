import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseSqlSessionDbOptions, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getDefaultSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const STOP_AFTER_STORAGE_SETUP = "stop after SQL storage setup";

describe("OMP_SESSION_DB_OPTIONS SQL storage controls", () => {
	it("uses a pre-provisioned table without DDL and keeps createTable out of Bun.SQL options", async () => {
		using tempDir = TempDir.createSync("@omp-sql-env-");
		const databasePath = path.join(tempDir.path(), "sessions.sqlite");
		const seed = new SQL({ adapter: "sqlite", filename: databasePath });
		await seed.unsafe(
			"CREATE TABLE provisioned_chunks (path TEXT NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, PRIMARY KEY (path, seq))",
		);
		await seed.unsafe(
			"INSERT INTO provisioned_chunks (path, seq, content, mtime_ms, title, title_source, title_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["/sessions/existing.jsonl", 0, "preserved\n", 123, null, null, null],
		);
		// A view is readable by the storage API but CREATE TABLE IF NOT EXISTS on
		// the same name fails. It is therefore a DDL tripwire, not a query mock.
		await seed.unsafe("CREATE VIEW omp_session_chunks AS SELECT * FROM provisioned_chunks");
		await seed.end();

		const previousOptions = process.env.OMP_SESSION_DB_OPTIONS;
		const previousUrl = process.env.OMP_SESSION_DB_URL;
		const previousStorage = getDefaultSessionStorage();
		const optionsJson = JSON.stringify({
			adapter: "sqlite",
			filename: databasePath,
			createTable: false,
		});
		const splitOptions = parseSqlSessionDbOptions(optionsJson);
		expect(splitOptions).toEqual({
			connectionOptions: { adapter: "sqlite", filename: databasePath },
			createTable: false,
		});
		process.env.OMP_SESSION_DB_OPTIONS = optionsJson;
		delete process.env.OMP_SESSION_DB_URL;

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs(["--session-storage", "sql", "--no-session", "--print", "unused"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		let existingContent: string | undefined;
		let thrown: unknown;
		try {
			await runRootCommand(parsed, ["--session-storage", "sql", "--no-session", "--print", "unused"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async () => {
					existingContent = await getDefaultSessionStorage().readText("/sessions/existing.jsonl");
					throw new Error(STOP_AFTER_STORAGE_SETUP);
				},
			});
		} catch (error) {
			thrown = error;
		} finally {
			setDefaultSessionStorage(previousStorage);
			authStorage.close();
			if (previousOptions === undefined) delete process.env.OMP_SESSION_DB_OPTIONS;
			else process.env.OMP_SESSION_DB_OPTIONS = previousOptions;
			if (previousUrl === undefined) delete process.env.OMP_SESSION_DB_URL;
			else process.env.OMP_SESSION_DB_URL = previousUrl;
		}

		expect(thrown).toEqual(new Error(STOP_AFTER_STORAGE_SETUP));
		expect(existingContent).toBe("preserved\n");
	});
});
