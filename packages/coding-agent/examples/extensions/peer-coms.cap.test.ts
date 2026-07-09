// Peer-cap counting tests. The scratch subnet dir is supplied via
// OMP_PEER_COMS_DIR in the test invocation so the extension module (which
// captures PEER_COMS_DIR at import time) and this test agree on one location
// without a dynamic import.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { countLiveOtherPeers } from "./peer-coms.ts";

const DIR = process.env.OMP_PEER_COMS_DIR;
if (!DIR) throw new Error("run with OMP_PEER_COMS_DIR set to a scratch dir");

function writeEntry(project: string, sessionId: string, pid: number): void {
	const agentsDir = path.join(DIR as string, "projects", project, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const now = new Date().toISOString();
	const entry = {
		session_id: sessionId,
		name: sessionId,
		model: "test",
		pid,
		endpoint: path.join(DIR as string, `${sessionId}.sock`),
		cwd: "/tmp",
		project,
		explicit: false,
		started_at: now,
		heartbeat_at: now,
		context_used_pct: null,
	};
	fs.writeFileSync(path.join(agentsDir, `${sessionId}.json`), JSON.stringify(entry));
}

test("counts live non-self peers, prunes dead pids, excludes own pid", () => {
	// pid 1 (init) is always alive and never this process's pid -> a live peer.
	writeEntry("agentdesk", "peer-a", 1);
	writeEntry("agentdesk", "peer-b", 1);
	// An impossible pid resolves not-alive -> pruned, never counted.
	writeEntry("agentdesk", "peer-dead", 2 ** 30);
	// An entry carrying our own pid is the caller -> excluded from "other".
	writeEntry("agentdesk", "self", process.pid);

	expect(countLiveOtherPeers("*", undefined)).toBe(2);
});
