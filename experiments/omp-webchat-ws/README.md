# OMP Web Chat WS

Minimal vanilla web chat for one live `omp --mode rpc --no-session` coding-agent session. `server.ts` starts a single OMP RPC child, bridges relevant JSONL session events over one bidirectional WebSocket, auto-cancels extension UI prompts safely, and serves a ChatGPT/Claude-style frontend with streaming assistant bubbles and Stop support.

## Run

```sh
bun run server.ts
```

Open http://localhost:8788/. Override the port with `PORT=9000 bun run server.ts`.
