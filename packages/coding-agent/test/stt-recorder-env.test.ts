import { expect, it, vi } from "bun:test";
import { startRecording } from "@oh-my-pi/pi-coding-agent/stt/recorder";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

interface SpawnOptions {
	env?: Record<string, string | undefined>;
}

it("preserves audio session env but strips ambient secrets from recorder children", async () => {
	vi.useFakeTimers();
	const poisoned = {
		DISPLAY: ":92",
		XDG_RUNTIME_DIR: "/tmp/omp-recorder-runtime",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/omp-recorder-bus",
		PULSE_SERVER: "unix:/tmp/omp-recorder-pulse",
		ANTHROPIC_API_KEY: "ambient-provider-secret",
		DATABASE_URL: "postgres://ambient-storage-secret",
		AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
		JWT_SECRET: "ambient-jwt-secret",
		GENERIC_SERVICE_SECRET: "ambient-generic-secret",
	};
	const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
	Object.assign(process.env, poisoned);
	vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "sox" ? "/usr/bin/sox" : null));
	const exit = Promise.withResolvers<number>();
	let spawnOptions: SpawnOptions | undefined;
	vi.spyOn(Bun, "spawn").mockImplementation(((_cmd: string[], options?: SpawnOptions) => {
		spawnOptions = options;
		return {
			pid: 12345,
			stdout: new Response("").body,
			exited: exit.promise,
			kill: () => {
				exit.resolve(0);
				return true;
			},
		} as unknown as Subprocess;
	}) as typeof Bun.spawn);

	try {
		const starting = startRecording("/tmp/omp-recorder-env.wav");
		await Promise.resolve();
		vi.advanceTimersByTime(300);
		await Promise.resolve();
		vi.advanceTimersByTime(0);
		const recording = await starting;

		expect(spawnOptions?.env).toEqual(
			expect.objectContaining({
				DISPLAY: ":92",
				XDG_RUNTIME_DIR: "/tmp/omp-recorder-runtime",
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/omp-recorder-bus",
				PULSE_SERVER: "unix:/tmp/omp-recorder-pulse",
			}),
		);
		expect(spawnOptions?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(spawnOptions?.env).not.toHaveProperty("DATABASE_URL");
		expect(spawnOptions?.env).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
		expect(spawnOptions?.env).not.toHaveProperty("JWT_SECRET");
		expect(spawnOptions?.env).not.toHaveProperty("GENERIC_SERVICE_SECRET");
		await recording.stop();
	} finally {
		vi.useRealTimers();
		vi.restoreAllMocks();
		exit.resolve(0);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
