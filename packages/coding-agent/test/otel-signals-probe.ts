/**
 * Positive-path probe for the OTLP log + metric exporters, run as a subprocess
 * by telemetry-export.test.ts. Keeping it out-of-process means the global
 * LoggerProvider / MeterProvider singletons that initTelemetryExport() registers
 * never leak into the test runner.
 *
 * Stands up a loopback OTLP/proto receiver, points the standard env vars at it,
 * registers the providers, drives a log record through the bridged
 * `@oh-my-pi/pi-utils` logger and metric instruments through the agent
 * telemetry hooks, flushes, and exits 0 only if the receiver got a non-empty
 * protobuf POST at both /v1/logs and /v1/metrics.
 */

import type { AgentRunCoverage, AgentRunSummary, ChatUsageEvent } from "@oh-my-pi/pi-agent-core";
import { emptyAgentRunCoverage, emptyAgentRunSummary } from "@oh-my-pi/pi-agent-core";
import {
	createTelemetryExportConfig,
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger } from "@oh-my-pi/pi-utils";

const seen = new Set<string>();
const metricPayloads: Uint8Array[] = [];

interface ProtobufField {
	readonly number: number;
	readonly wireType: number;
	readonly bytes?: Uint8Array;
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
	let value = 0;
	let shift = 0;
	while (offset < bytes.length) {
		const byte = bytes[offset++];
		value += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) return [value, offset];
		shift += 7;
	}
	throw new Error("Truncated protobuf varint");
}

function protobufFields(bytes: Uint8Array): ProtobufField[] {
	const fields: ProtobufField[] = [];
	for (let offset = 0; offset < bytes.length;) {
		const [tag, nextOffset] = readVarint(bytes, offset);
		offset = nextOffset;
		const wireType = tag & 7;
		const number = tag >>> 3;
		if (wireType === 0) {
			[, offset] = readVarint(bytes, offset);
			fields.push({ number, wireType });
		} else if (wireType === 1) {
			const end = offset + 8;
			if (end > bytes.length) throw new Error("Truncated protobuf fixed64 field");
			fields.push({ number, wireType, bytes: bytes.slice(offset, end) });
			offset = end;
		} else if (wireType === 2) {
			const [length, valueOffset] = readVarint(bytes, offset);
			offset = valueOffset;
			const end = offset + length;
			if (end > bytes.length) throw new Error("Truncated protobuf field");
			fields.push({ number, wireType, bytes: bytes.slice(offset, end) });
			offset = end;
		} else if (wireType === 5) {
			offset += 4;
			fields.push({ number, wireType });
		} else {
			throw new Error(`Unsupported protobuf wire type ${wireType}`);
		}
	}
	return fields;
}

function pointCountForMetric(bytes: Uint8Array, metricName: string): number | undefined {
	const fields = protobufFields(bytes);
	const isMetric = fields.some(
		field => field.number === 1 && field.bytes && new TextDecoder().decode(field.bytes) === metricName,
	);
	if (isMetric) {
		const aggregation = fields.find(field => field.number === 7 || field.number === 9)?.bytes;
		if (!aggregation) return undefined;
		return protobufFields(aggregation).filter(field => field.number === 1).length;
	}
	for (const field of fields) {
		if (!field.bytes) continue;
		try {
			const count = pointCountForMetric(field.bytes, metricName);
			if (count !== undefined) return count;
		} catch {
			// This length-delimited field is a scalar string or bytes value, not a nested message.
		}
	}
	return undefined;
}

function assertSingleMetricPoint(metricName: string): void {
	const counts = metricPayloads.map(payload => pointCountForMetric(payload, metricName));
	if (!counts.includes(1)) {
		throw new Error(`${metricName} expected one dimensioned point, got ${counts.join(",")}`);
	}
}

function histogramObservationForMetric(
	bytes: Uint8Array,
	metricName: string,
): { points: number; count: number; sum: number } | undefined {
	const fields = protobufFields(bytes);
	const isMetric = fields.some(
		field =>
			field.number === 1 &&
			field.wireType === 2 &&
			field.bytes &&
			new TextDecoder().decode(field.bytes) === metricName,
	);
	if (isMetric) {
		const histogram = fields.find(field => field.number === 9 && field.wireType === 2)?.bytes;
		if (!histogram) return undefined;
		const points = protobufFields(histogram).filter(
			field => field.number === 1 && field.wireType === 2 && field.bytes,
		);
		let count = 0;
		let sum = 0;
		for (const point of points) {
			const pointFields = protobufFields(point.bytes!);
			const countBytes = pointFields.find(field => field.number === 4 && field.wireType === 1)?.bytes;
			const sumBytes = pointFields.find(field => field.number === 5 && field.wireType === 1)?.bytes;
			if (countBytes) {
				const view = new DataView(countBytes.buffer, countBytes.byteOffset, countBytes.byteLength);
				count += view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32;
			}
			if (sumBytes) {
				sum += new DataView(sumBytes.buffer, sumBytes.byteOffset, sumBytes.byteLength).getFloat64(0, true);
			}
		}
		return { points: points.length, count, sum };
	}
	for (const field of fields) {
		if (field.wireType !== 2 || !field.bytes) continue;
		try {
			const observation = histogramObservationForMetric(field.bytes, metricName);
			if (observation) return observation;
		} catch {
			// Scalar string/bytes field, not a nested protobuf message.
		}
	}
	return undefined;
}

function assertIndividualToolDurations(metricName: string): void {
	const observations = metricPayloads
		.map(payload => histogramObservationForMetric(payload, metricName))
		.filter((value): value is { points: number; count: number; sum: number } => value !== undefined);
	if (!observations.some(value => value.points === 1 && value.count === 2 && value.sum === 100)) {
		throw new Error(
			`${metricName} expected two individual observations summing to 100ms: ${JSON.stringify(observations)}`,
		);
	}
}

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && req.headers.get("content-type")?.startsWith("application/x-protobuf")) {
			const body = await req.arrayBuffer();
			if (path.endsWith("/v1/metrics")) metricPayloads.push(new Uint8Array(body));
			if (body.byteLength > 0) {
				if (path.endsWith("/v1/logs")) seen.add("logs");
				if (path.endsWith("/v1/metrics")) seen.add("metrics");
			}
		}
		return new Response('{"partialSuccess":{}}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	},
});

const base = `http://localhost:${server.port}`;
process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${base}/v1/logs`;
process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${base}/v1/metrics`;
process.env.OTEL_SERVICE_NAME = "oh-my-pi-signals-probe";
// Force a short metric export interval so the periodic reader flushes fast.
process.env.OTEL_METRIC_EXPORT_INTERVAL = "500";

await initTelemetryExport();
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: providers did not register");
	await server.stop(true);
	process.exit(2);
}

const config = createTelemetryExportConfig(undefined);
if (!config) {
	console.error("PROBE: export config not produced");
	await server.stop(true);
	process.exit(2);
}

// Bridged utility logger -> OTel log record.
logger.error("probe error", { code: "probe" });

// Metric instruments via the agent telemetry hooks.
const usage: ChatUsageEvent = {
	span: undefined as never,
	agent: { id: "main", name: "Main" },
	conversationId: "probe-session",
	stepNumber: 0,
	model: "claude-haiku-4-5",
	provider: "anthropic",
	serviceTier: undefined,
	usage: {
		inputTokens: 1000,
		outputTokens: 200,
		totalTokens: 1200,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		reasoningOutputTokens: 0,
	},
	cost: { usd: 0.01 },
	attributes: undefined,
	headers: undefined,
};
await config.onChatUsage?.(usage);

const summary: AgentRunSummary = {
	...emptyAgentRunSummary(),
	chats: { total: 1, byStopReason: { end_turn: 1 }, totalLatencyMs: 1500 },
	tools: {
		total: 2,
		ok: 2,
		error: 0,
		skipped: 0,
		blocked: 0,
		timeout: 0,
		aborted: 0,
		totalLatencyMs: 100,
		byName: {
			read: { total: 2, ok: 2, error: 0, skipped: 0, blocked: 0, timeout: 0, aborted: 0, totalLatencyMs: 100 },
		},
	},
	stepCount: 1,
};
const coverage: AgentRunCoverage = {
	...emptyAgentRunCoverage(),
	toolsAvailable: ["read", "write"],
	toolsInvoked: ["read"],
	toolsUnused: ["write"],
	modelsUsed: ["claude-haiku-4-5"],
	providersUsed: ["anthropic"],
};
config.onToolUsage?.({ toolName: "read", status: "ok", durationMs: 42, errorType: undefined });
config.onToolUsage?.({ toolName: "read", status: "ok", durationMs: 58, errorType: undefined });
config.onToolUsage?.({ toolName: "read", status: "skipped", durationMs: 999, errorType: "tool_skipped" });
config.onRunEnd?.(summary, coverage);

await flushTelemetryExport();
// The metric reader exports on its own interval; wait one cycle then flush.
await Bun.sleep(700);
await flushTelemetryExport();
assertSingleMetricPoint("pi.omp.agent.chat.calls");
assertSingleMetricPoint("pi.omp.agent.tool.calls");
assertIndividualToolDurations("pi.omp.agent.tool.duration");
await server.stop(true);

const ok = seen.has("logs") && seen.has("metrics");
console.log(ok ? "PROBE: RECEIVED" : `PROBE: MISSING ${["logs", "metrics"].filter(s => !seen.has(s)).join(",")}`);
process.exit(ok ? 0 : 1);
