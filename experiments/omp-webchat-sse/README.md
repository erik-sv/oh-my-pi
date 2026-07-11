# OMP Webchat SSE

Minimal single-session web chat for a live `omp --mode rpc --no-session` coding-agent process. The Bun server starts one shared OMP RPC child, converts relevant JSONL session events to Server-Sent Events, accepts prompts over `POST /prompt`, and serves a vanilla HTML/CSS/JS chat UI with streaming assistant bubbles and a Stop button.

## Run

```sh
cd /home/developer/src/oh-my-pi/experiments/omp-webchat-sse
bun run server.ts
```

Open http://localhost:8787. Override the port with `PORT=9000 bun run server.ts`.
