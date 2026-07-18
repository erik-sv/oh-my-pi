import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";

interface ReservedSqlClient extends SqlSessionStorageClient {
	release(): void;
}

interface WorkerResult {
	prefix: string;
	acknowledged: string[];
	subjectRole?: string;
	adminCredentialPresent: boolean;
	error?: string;
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

function safeErrorMessage(error: unknown, credential: string): string {
	let message = error instanceof Error ? error.message : String(error);
	message = message.replaceAll(credential, "[REDACTED POSTGRES URL]");
	try {
		const password = decodeURIComponent(new URL(credential).password);
		if (password) message = message.replaceAll(password, "[REDACTED POSTGRES PASSWORD]");
	} catch {}
	return message;
}

const url = requiredEnv("OMP_TEST_POSTGRES_RUNTIME_URL");
const table = requiredEnv("OMP_TEST_SQL_TABLE");
const sessionPath = requiredEnv("OMP_TEST_SESSION_PATH");
const prefix = requiredEnv("OMP_TEST_WRITER_PREFIX");
const count = Number.parseInt(requiredEnv("OMP_TEST_APPEND_COUNT"), 10);
const gateNamespace = Number.parseInt(requiredEnv("OMP_TEST_GATE_NAMESPACE"), 10);
const gateId = Number.parseInt(requiredEnv("OMP_TEST_GATE_ID"), 10);
const pool = new SQL(url);
let connection: ReservedSqlClient | undefined;
const result: WorkerResult = {
	prefix,
	acknowledged: [],
	adminCredentialPresent: Boolean(process.env.OMP_TEST_POSTGRES_ADMIN_URL),
};

try {
	connection = (await pool.reserve()) as ReservedSqlClient;
	const identityRows = (await connection.unsafe("SELECT current_user AS subject_role")) as Array<{
		subject_role: string;
	}>;
	result.subjectRole = identityRows[0]?.subject_role;
	const storage = await SqlSessionStorage.create({
		client: connection,
		adapter: "postgres",
		table,
		createTable: false,
	});
	const writer = storage.openWriter(sessionPath);

	await connection.unsafe("SELECT pg_advisory_lock_shared($1, $2)", [gateNamespace, gateId]);
	await connection.unsafe("SELECT pg_advisory_unlock_shared($1, $2)", [gateNamespace, gateId]);

	try {
		for (let index = 0; index < count; index++) {
			const line = `${JSON.stringify({ writer: prefix, index })}\n`;
			await writer.append(line);
			result.acknowledged.push(line);
		}
		await writer.close();
	} catch (error) {
		result.error = safeErrorMessage(error, url);
		process.exitCode = 1;
	}
} catch (error) {
	result.error = safeErrorMessage(error, url);
	process.exitCode = 1;
} finally {
	try {
		connection?.release();
		await pool.end();
	} catch (error) {
		result.error ??= safeErrorMessage(error, url);
		process.exitCode = 1;
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
