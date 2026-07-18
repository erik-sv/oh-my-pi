import { expect, it, vi } from "bun:test";
import { playAudioFile } from "@oh-my-pi/pi-coding-agent/tts/player";
import { StreamingAudioPlayer } from "@oh-my-pi/pi-coding-agent/tts/streaming-player";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

interface SpawnOptions {
	env?: Record<string, string | undefined>;
}

it("preserves audio session env but strips ambient secrets from player children", async () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	const poisoned = {
		DISPLAY: ":88",
		XDG_RUNTIME_DIR: "/tmp/omp-audio-runtime",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/omp-audio-bus",
		PULSE_SERVER: "unix:/tmp/omp-audio-pulse",
		ANTHROPIC_API_KEY: "ambient-provider-secret",
		DATABASE_URL: "postgres://ambient-storage-secret",
		AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
		JWT_SECRET: "ambient-jwt-secret",
		GENERIC_SERVICE_SECRET: "ambient-generic-secret",
	};
	const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
	Object.assign(process.env, poisoned);
	vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "paplay" ? "/usr/bin/paplay" : null));
	let spawnOptions: SpawnOptions | undefined;
	vi.spyOn(Bun, "spawn").mockImplementation(((_cmd: string[], options?: SpawnOptions) => {
		spawnOptions = options;
		return {
			pid: 12345,
			stderr: new Response("").body,
			exitCode: 0,
			exited: Promise.resolve(0),
			kill: () => true,
		} as unknown as Subprocess;
	}) as typeof Bun.spawn);

	try {
		await playAudioFile("/tmp/omp-audio-env.wav");
		expect(spawnOptions?.env).toEqual(
			expect.objectContaining({
				DISPLAY: ":88",
				XDG_RUNTIME_DIR: "/tmp/omp-audio-runtime",
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/omp-audio-bus",
				PULSE_SERVER: "unix:/tmp/omp-audio-pulse",
			}),
		);
		expect(spawnOptions?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(spawnOptions?.env).not.toHaveProperty("DATABASE_URL");
		expect(spawnOptions?.env).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
		expect(spawnOptions?.env).not.toHaveProperty("JWT_SECRET");
		expect(spawnOptions?.env).not.toHaveProperty("GENERIC_SERVICE_SECRET");
	} finally {
		vi.restoreAllMocks();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

it("preserves audio session env but strips ambient secrets from streaming player children", () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	const poisoned = {
		DISPLAY: ":91",
		XDG_RUNTIME_DIR: "/tmp/omp-stream-audio-runtime",
		DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/omp-stream-audio-bus",
		PULSE_SERVER: "unix:/tmp/omp-stream-audio-pulse",
		ANTHROPIC_API_KEY: "ambient-provider-secret",
		DATABASE_URL: "postgres://ambient-storage-secret",
		AGENTDESK_CONTROL_TOKEN: "ambient-control-secret",
		JWT_SECRET: "ambient-jwt-secret",
		GENERIC_SERVICE_SECRET: "ambient-generic-secret",
	};
	const saved = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
	Object.assign(process.env, poisoned);
	vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "paplay" ? "/usr/bin/paplay" : null));
	let spawnOptions: SpawnOptions | undefined;
	vi.spyOn(Bun, "spawn").mockImplementation(((_cmd: string[], options?: SpawnOptions) => {
		spawnOptions = options;
		return {
			pid: 12345,
			stdin: { write: () => 0, end: () => Promise.resolve() },
			exited: new Promise<number>(() => {}),
			kill: () => true,
		} as unknown as Subprocess;
	}) as typeof Bun.spawn);

	try {
		const player = new StreamingAudioPlayer();
		player.start(24_000);
		player.stop();
		expect(spawnOptions?.env).toEqual(
			expect.objectContaining({
				DISPLAY: ":91",
				XDG_RUNTIME_DIR: "/tmp/omp-stream-audio-runtime",
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/omp-stream-audio-bus",
				PULSE_SERVER: "unix:/tmp/omp-stream-audio-pulse",
			}),
		);
		expect(spawnOptions?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(spawnOptions?.env).not.toHaveProperty("DATABASE_URL");
		expect(spawnOptions?.env).not.toHaveProperty("AGENTDESK_CONTROL_TOKEN");
		expect(spawnOptions?.env).not.toHaveProperty("JWT_SECRET");
		expect(spawnOptions?.env).not.toHaveProperty("GENERIC_SERVICE_SECRET");
	} finally {
		vi.restoreAllMocks();
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
