import type { ServerWebSocket } from "bun";

interface SocketData {
  id: string;
}

type ChatSocket = ServerWebSocket<SocketData>;

type RpcFrame = {
  type?: unknown;
  [key: string]: unknown;
};

const DEFAULT_PORT = 8788;
const port = parsePort(Bun.env.PORT);
const indexFile = new URL("./public/index.html", import.meta.url);
const stdoutDecoder = new TextDecoder();
const stderrDecoder = new TextDecoder();

const sockets = new Set<ChatSocket>();
const forwardedEventTypes = new Set([
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
const passiveUiMethods = new Set([
  "setStatus",
  "setWidget",
  "setTitle",
  "notify",
  "set_editor_text",
]);
const cancellableUiMethods = new Set(["select", "input", "editor", "open_url"]);

let stdoutBuffer = "";
let isStreaming = false;
let childReady = false;
let childExited = false;
let shuttingDown = false;

const omp = Bun.spawn(["omp", "--mode", "rpc", "--no-session"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const server = Bun.serve<SocketData>({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/ws") {
      if (server.upgrade(req, { data: { id: crypto.randomUUID() } })) {
        return undefined;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(Bun.file(indexFile), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    idleTimeout: 120,
    open(ws) {
      sockets.add(ws);
      sendSocket(ws, {
        type: "server_ready",
        childReady,
        isStreaming,
      });
    },
    message(ws, payload) {
      handleSocketMessage(ws, payload);
    },
    close(ws) {
      sockets.delete(ws);
    },
  },
});

const heartbeat = setInterval(() => {
  broadcast({ type: "heartbeat", time: Date.now(), isStreaming });
}, 15_000);

void readStdout();
void readStderr();
void omp.exited.then((exitCode) => {
  childExited = true;
  childReady = false;
  isStreaming = false;
  broadcast({ type: "server_status", status: "omp_exit", exitCode });
  if (!shuttingDown) {
    console.error(`omp rpc exited with code ${exitCode}`);
  }
});

console.log(`omp webchat listening on http://localhost:${server.port}`);

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    return DEFAULT_PORT;
  }

  return parsed;
}

async function readStdout(): Promise<void> {
  try {
    for await (const chunk of omp.stdout) {
      stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
      drainStdoutLines();
    }

    const tail = stdoutDecoder.decode();
    if (tail) {
      stdoutBuffer += tail;
    }
    drainStdoutLines(true);
  } catch (error) {
    if (!shuttingDown) {
      console.error("failed to read omp stdout", error);
      broadcast({ type: "server_error", message: "Lost stdout from omp rpc child." });
    }
  }
}

async function readStderr(): Promise<void> {
  try {
    for await (const chunk of omp.stderr) {
      const text = stderrDecoder.decode(chunk, { stream: true });
      if (text.trim()) {
        console.error(text.trimEnd());
      }
    }
  } catch (error) {
    if (!shuttingDown) {
      console.error("failed to read omp stderr", error);
    }
  }
}

function drainStdoutLines(final = false): void {
  let newlineIndex = stdoutBuffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    handleStdoutLine(line);
    newlineIndex = stdoutBuffer.indexOf("\n");
  }

  if (final && stdoutBuffer.trim()) {
    handleStdoutLine(stdoutBuffer.trim());
    stdoutBuffer = "";
  }
}

function handleStdoutLine(line: string): void {
  if (!line) {
    return;
  }

  let frame: RpcFrame;
  try {
    frame = JSON.parse(line) as RpcFrame;
  } catch (error) {
    console.error("invalid JSON from omp rpc", error, line);
    return;
  }

  handleRpcFrame(frame);
}

function handleRpcFrame(frame: RpcFrame): void {
  const frameType = typeof frame.type === "string" ? frame.type : "";

  if (frameType === "ready") {
    childReady = true;
    broadcast({ type: "server_status", status: "omp_ready" });
    return;
  }

  if (frameType === "response") {
    return;
  }

  if (frameType === "extension_ui_request") {
    handleExtensionUiRequest(frame);
    return;
  }

  if (frameType === "agent_start") {
    isStreaming = true;
    broadcast(frame);
    return;
  }

  if (frameType === "agent_end") {
    isStreaming = false;
    broadcast(frame);
    return;
  }

  if (forwardedEventTypes.has(frameType)) {
    broadcast(frame);
  }
}

function handleExtensionUiRequest(frame: RpcFrame): void {
  const method = typeof frame.method === "string" ? frame.method : "";
  const id = frame.id;

  if (passiveUiMethods.has(method) || method === "cancel") {
    return;
  }

  if (id === undefined || id === null) {
    return;
  }

  if (method === "confirm") {
    writeRpc({ type: "extension_ui_response", id, confirmed: false });
    return;
  }

  if (cancellableUiMethods.has(method) || method === "") {
    writeRpc({ type: "extension_ui_response", id, cancelled: true });
    return;
  }

  writeRpc({ type: "extension_ui_response", id, cancelled: true });
}

function handleSocketMessage(ws: ChatSocket, payload: string | Buffer): void {
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  let command: RpcFrame;

  try {
    command = JSON.parse(text) as RpcFrame;
  } catch {
    sendSocket(ws, { type: "server_error", message: "Client message was not valid JSON." });
    return;
  }

  if (command.type === "prompt") {
    const message = typeof command.message === "string" ? command.message : "";
    if (!message.trim()) {
      sendSocket(ws, { type: "server_error", message: "Prompt message is empty." });
      return;
    }

    const promptCommand: RpcFrame = { type: "prompt", message };
    if (isStreaming) {
      promptCommand.streamingBehavior = "followUp";
    }
    writeRpc(promptCommand, ws);
    return;
  }

  if (command.type === "abort") {
    writeRpc({ type: "abort" }, ws);
    return;
  }

  sendSocket(ws, { type: "server_error", message: "Unsupported client command." });
}

function writeRpc(command: RpcFrame, ws?: ChatSocket): boolean {
  if (childExited) {
    const message = "omp rpc child is not running.";
    if (ws) {
      sendSocket(ws, { type: "server_error", message });
    } else {
      broadcast({ type: "server_error", message });
    }
    return false;
  }

  try {
    omp.stdin.write(`${JSON.stringify(command)}\n`);
    void Promise.resolve(omp.stdin.flush()).catch((error) => {
      console.error("failed to flush command to omp rpc", error);
      if (ws) {
        sendSocket(ws, { type: "server_error", message: "Failed to flush command to omp rpc." });
      }
    });
    return true;
  } catch (error) {
    console.error("failed to write command to omp rpc", error);
    if (ws) {
      sendSocket(ws, { type: "server_error", message: "Failed to write command to omp rpc." });
    }
    return false;
  }
}

function broadcast(frame: RpcFrame): void {
  const text = JSON.stringify(frame);
  for (const ws of sockets) {
    try {
      ws.send(text);
    } catch {
      sockets.delete(ws);
    }
  }
}

function sendSocket(ws: ChatSocket, frame: RpcFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    sockets.delete(ws);
  }
}

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(heartbeat);
  broadcast({ type: "server_status", status: "shutdown", signal });

  for (const ws of sockets) {
    try {
      ws.close(1001, "server shutting down");
    } catch {
      // Socket is already gone.
    }
  }
  sockets.clear();

  try {
    omp.stdin.end();
  } catch {
    // Stdin may already be closed.
  }

  try {
    omp.kill();
  } catch {
    // Child may already be dead.
  }

  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  if (!childExited) {
    try {
      omp.kill();
    } catch {
      // Best effort only during process exit.
    }
  }
});
