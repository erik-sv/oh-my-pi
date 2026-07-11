const DEFAULT_PORT = 8787;
const parsedPort = Number.parseInt(Bun.env.PORT ?? "", 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SESSION_EVENT_TYPES = new Set([
  "agent_start",
  "turn_start",
  "message_start",
  "message_update",
  "message_end",
  "turn_end",
  "agent_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

const PASSIVE_UI_METHODS = new Set([
  "setStatus",
  "setWidget",
  "setTitle",
  "notify",
  "set_editor_text",
]);

const VALUE_UI_METHODS = new Set(["select", "input", "editor"]);

interface JsonObject {
  [key: string]: unknown;
}

interface SseClient {
  id: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: Timer | undefined;
  closed: boolean;
}

const clients = new Set<SseClient>();
let nextClientId = 1;
let stdoutBuffer = "";
let isStreaming = false;
let shuttingDown = false;
let childExited = false;

const child = Bun.spawn(["omp", "--mode", "rpc", "--no-session"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  cwd: process.cwd(),
});

console.log(`Spawned omp rpc child pid=${child.pid}`);

function jsonResponse(status: number, body: JsonObject): Response {
  return Response.json(body, { status });
}

function sendCommand(command: JsonObject): boolean {
  if (shuttingDown || childExited) {
    return false;
  }

  try {
    child.stdin.write(`${JSON.stringify(command)}\n`);
    child.stdin.flush();
    return true;
  } catch (error) {
    console.error("Failed to write command to omp stdin", error);
    return false;
  }
}

function closeClient(client: SseClient): void {
  if (client.closed) {
    return;
  }

  client.closed = true;
  if (client.heartbeat !== undefined) {
    clearInterval(client.heartbeat);
  }
  clients.delete(client);

  try {
    client.controller.close();
  } catch {
    // The browser may already have closed the stream.
  }
}

function enqueueSse(client: SseClient, chunk: string): void {
  if (client.closed) {
    return;
  }

  try {
    client.controller.enqueue(encoder.encode(chunk));
  } catch {
    closeClient(client);
  }
}

function sendSse(client: SseClient, event: JsonObject): void {
  enqueueSse(client, `data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event: JsonObject): void {
  for (const client of clients) {
    sendSse(client, event);
  }
}

function handleExtensionUiRequest(frame: JsonObject): void {
  const method = typeof frame.method === "string" ? frame.method : "";
  const id = typeof frame.id === "string" ? frame.id : "";

  if (PASSIVE_UI_METHODS.has(method)) {
    return;
  }

  if (!id) {
    console.warn("Ignoring extension UI request without string id", frame);
    return;
  }

  if (method === "confirm") {
    sendCommand({ type: "extension_ui_response", id, confirmed: false });
    return;
  }

  if (VALUE_UI_METHODS.has(method)) {
    sendCommand({ type: "extension_ui_response", id, cancelled: true });
  }
}

function handleRpcFrame(frame: JsonObject): void {
  const type = typeof frame.type === "string" ? frame.type : "";

  if (type === "extension_ui_request") {
    handleExtensionUiRequest(frame);
    return;
  }

  if (type === "agent_start") {
    isStreaming = true;
    broadcast(frame);
    return;
  }

  if (type === "agent_end") {
    isStreaming = false;
    broadcast(frame);
    return;
  }

  if (SESSION_EVENT_TYPES.has(type)) {
    broadcast(frame);
  }
}

function handleRpcLine(line: string): void {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    console.error("Ignoring invalid JSON from omp stdout", { line, error });
    return;
  }

  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    return;
  }

  handleRpcFrame(frame as JsonObject);
}

function drainStdoutBuffer(flushFinalLine: boolean): void {
  while (true) {
    const newlineIndex = stdoutBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line) {
      handleRpcLine(line);
    }
  }

  if (flushFinalLine) {
    const line = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (line) {
      handleRpcLine(line);
    }
  }
}

async function readChildStdout(): Promise<void> {
  const reader = child.stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        stdoutBuffer += decoder.decode();
        drainStdoutBuffer(true);
        return;
      }

      stdoutBuffer += decoder.decode(value, { stream: true });
      drainStdoutBuffer(false);
    }
  } catch (error) {
    if (!shuttingDown) {
      console.error("omp stdout reader failed", error);
    }
  }
}

async function readChildStderr(): Promise<void> {
  const stderrDecoder = new TextDecoder();
  const reader = child.stderr.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }

      const text = stderrDecoder.decode(value, { stream: true });
      if (text.trim()) {
        console.error(text.trimEnd());
      }
    }
  } catch (error) {
    if (!shuttingDown) {
      console.error("omp stderr reader failed", error);
    }
  }
}

function createSseResponse(request: Request): Response {
  let client: SseClient | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = {
        id: nextClientId,
        controller,
        heartbeat: undefined,
        closed: false,
      };
      nextClientId += 1;
      clients.add(client);

      sendSse(client, { type: "ready" });
      client.heartbeat = setInterval(() => {
        if (client !== undefined) {
          enqueueSse(client, ":heartbeat\n\n");
        }
      }, 15_000);

      request.signal.addEventListener(
        "abort",
        () => {
          if (client !== undefined) {
            closeClient(client);
          }
        },
        { once: true },
      );
    },
    cancel() {
      if (client !== undefined) {
        closeClient(client);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function handlePrompt(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Expected JSON body" });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { ok: false, error: "Expected JSON object" });
  }

  const message = (body as JsonObject).message;
  if (typeof message !== "string" || message.trim().length === 0) {
    return jsonResponse(400, { ok: false, error: "Expected non-empty string message" });
  }

  const wasStreaming = isStreaming;
  const command: JsonObject = { type: "prompt", message };
  if (wasStreaming) {
    command.streamingBehavior = "followUp";
  }

  if (!sendCommand(command)) {
    return jsonResponse(503, { ok: false, error: "omp rpc child is not available" });
  }

  return jsonResponse(202, { ok: true, queued: wasStreaming });
}

async function handleAbort(): Promise<Response> {
  if (!sendCommand({ type: "abort" })) {
    return jsonResponse(503, { ok: false, error: "omp rpc child is not available" });
  }

  return jsonResponse(202, { ok: true });
}

function shutdown(reason: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Shutting down (${reason})`);

  for (const client of [...clients]) {
    closeClient(client);
  }

  try {
    child.kill();
  } catch {
    // The child may already be gone.
  }

  try {
    server.stop(true);
  } catch {
    // The server may already be stopped.
  }
}

void readChildStdout();
void readChildStderr();
void child.exited.then((exitCode) => {
  childExited = true;
  isStreaming = false;
  if (!shuttingDown) {
    console.error(`omp rpc child exited with code ${exitCode}`);
  }
});

const indexFile = Bun.file(new URL("./public/index.html", import.meta.url));

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(indexFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/events") {
      return createSseResponse(request);
    }

    if (request.method === "POST" && url.pathname === "/prompt") {
      return handlePrompt(request);
    }

    if (request.method === "POST" && url.pathname === "/abort") {
      return handleAbort();
    }

    return new Response("Not found", { status: 404 });
  },
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
  process.exit(0);
});

process.on("exit", () => {
  try {
    child.kill();
  } catch {
    // Best effort on process exit.
  }
});

console.log(`omp webchat SSE listening on http://localhost:${PORT}`);
