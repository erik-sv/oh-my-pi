# Peer Coms

Peer Coms is a flat Pi-to-Pi agent communication extension. It lets multiple
running OMP sessions talk to each other as peers, usually with different models,
without creating an orchestrator/subagent hierarchy.

The implementation lives at:

- `packages/coding-agent/examples/extensions/peer-coms.ts`
- `.omp/skills/agent-collaboration/SKILL.md`
- `.omp/agents/*.md` for project-local hierarchical sub mode agents

## What It Provides

- per-agent identity flags (`--peer-name`, `--peer-purpose`, `--peer-project`, `--peer-explicit`)
- local same-machine peer discovery under `~/.omp/agent/peer-coms`
- Unix socket / Windows named pipe transport
- heartbeat and stale peer pruning
- a status/widget line showing visible peers
- tool surface:
  - `peer_list`
  - `peer_spawn`
  - `peer_send`
  - `peer_get`
  - `peer_await`
  - `peer_shutdown`
- inbound prompt delivery as a follow-up message
- automatic reply capture from the receiver's normal assistant response
- hop limits to prevent runaway peer chains
- session audit entries under `peer-coms-log`

## Launching Peers

Start two or more OMP sessions with the extension loaded. Each session can use a
different model. Peers can also be spawned by an existing peer with
`peer_spawn`.

```bash
omp -e packages/coding-agent/examples/extensions/peer-coms.ts \
  --peer-name planner \
  --peer-purpose "break down the task and propose options" \
  --peer-project my-work \
  --model gpt-5
```

```bash
omp -e packages/coding-agent/examples/extensions/peer-coms.ts \
  --peer-name reviewer \
  --peer-purpose "challenge assumptions and check risks" \
  --peer-project my-work \
  --model claude-sonnet-4-5
```

```bash
omp -e packages/coding-agent/examples/extensions/peer-coms.ts \
  --peer-name implementer \
  --peer-purpose "turn agreed plans into code changes" \
  --peer-project my-work \
  --model qwen3-coder
```

The agents are peers. Any one of them can call `peer_send` to any other one.

The included `agent-collaboration` skill gives the model a short decision rule
for when to use peer mode versus hierarchical sub mode.

## Peer Agents vs Subagents

OMP supports both patterns, but they solve different jobs.

Use peer agents when independent judgment matters more than bounded execution:

- architecture or product tradeoff review
- adversarial critique of a plan or diff
- comparing answers from different models
- flat back-and-forth where no agent should own the whole decision

Use subagents when one primary agent owns the work and can delegate bounded tasks:

- codebase exploration
- independent file or test updates
- focused review of a known diff
- fact collection for the primary agent to synthesize

Default to subagents for narrow work. Choose peers when the value is disagreement,
model diversity, or a second mind that can push back. A good pattern is:

1. Use peers to challenge the plan.
2. Use subagents to execute the agreed tasks.
3. Use a reviewer peer or review subagent to check the final diff.
4. Shut down spawned peers when the peer-mode work is done.

Resource note: spawned peers are full OMP sessions in separate processes. Budget
roughly one normal session's memory and provider/API load per peer. On a
developer machine that is commonly hundreds of MiB of RSS for each idle peer,
and more as session state, tool output, or browser/debug workers accumulate.
Subagents run in-process, so they avoid another OMP process but still consume
parent memory, tokens, and tool/runtime capacity. Prefer subagents for bounded
parallel work. Spawn peers only when independent judgment is worth the extra
process, and shut them down when done.

Example peer prompt:

```text
Ask reviewer: Critique this plan for failure modes and missing tests. Return the top 5 risks and concrete mitigations.
```

Example subagent prompt:

```text
Explore the auth package and report the exact files and tests that need changes. Do not edit files.
```

## Tool Flow

`peer_list` discovers peers:

```text
peer_list({ "project": "my-work" })
```

`peer_spawn` creates a new peer session when no suitable peer exists:

```text
peer_spawn({
  "name": "reviewer",
  "purpose": "challenge assumptions and find risks",
  "project": "my-work",
  "model": "claude-sonnet-4-5",
  "agent": "task",
})
```

On macOS, the default launch mode opens a Terminal session so the peer remains
interactive. On other platforms, the default detached launch mode requires an
OMP runtime that can stay alive without a TTY. Set `launch_mode` explicitly when
needed.

`peer_spawn` writes startup instructions to a temporary system-prompt file and
passes it with `--append-system-prompt`. The `initial_prompt` field is startup
guidance, not a first user task, so a spawned peer can stay idle and answer the
first peer-coms request. Registration is reported as observed only after the
spawned peer answers a local `ping` with `pong`.
Spawned peers also receive a parent-process lease and an idle timeout. If the
spawning OMP session exits, the child peer shuts itself down. If the child has no
active inbound peer prompt for `OMP_PEER_COMS_SPAWNED_IDLE_TIMEOUT_MS`, it exits
instead of lingering as a background agent.

Spawned peers are full work peers, not narrow responders. They keep normal tool
access, receive a dedicated peer-coms session directory, and may load a local
agent definition with `agent` from `.omp/agents`, `.pi/agents`, `agents`, or
`.claude/agents`.

For auth, `peer_spawn` prefers an installed `omp` launcher over the current
source entrypoint, inherits `PI_CODING_AGENT_DIR` and auth-related environment,
and starts a loopback auth broker for spawned peers when no broker is already
configured. This lets spawned peers use the same live credential store without
copying provider secrets into peer-coms messages.

`peer_send` starts a peer exchange:

```text
peer_send({
  "target": "reviewer",
  "prompt": "Please critique this migration plan. Focus on failure modes and missing tests."
})
```

The target peer receives the prompt as a follow-up message and answers normally.
At the end of that assistant turn, Peer Coms captures the final assistant text
and sends it back to the original sender.
A peer handles one inbound Peer Coms message at a time. If a second peer sends a
message while the receiver still has an unfulfilled inbound prompt, the receiver
returns a busy rejection instead of risking swapped replies.

The sender retrieves the answer with:

```text
peer_get({ "msg_id": "<id from peer_send>" })
```

or waits for it with:

```text
peer_await({ "msg_id": "<id from peer_send>", "timeout_ms": 120000 })
```
Completed replies are consumed by `peer_get` or `peer_await`. If they are never
read, Peer Coms keeps them for `OMP_PEER_COMS_REPLY_RESULT_TTL_MS` and then
drops them.

`peer_shutdown` asks a peer to exit gracefully when the peer-mode work is done:

```text
peer_shutdown({
  "target": "reviewer",
  "reason": "review complete"
})
```
The receiver acknowledges the shutdown request, removes its registry/socket state,
asks the OMP context to shut down, then schedules process exit. This keeps
Terminal-spawned peers from surviving as idle orphan sessions.
A session that spawned peers also asks those children to shut down during its own
shutdown path, so peer trees do not survive the parent session by default.

## Reply Rule

When a peer receives an inbound Peer Coms message, it should reply by writing a
normal assistant response. It should not call `peer_send` back to the sender just
to answer. The extension automatically returns the normal assistant response.

Peers may still call `peer_send` to consult a third peer. The extension tracks
hops and enforces `OMP_PEER_COMS_MAX_HOPS`.

## Environment Variables

- `OMP_PEER_COMS_DIR`: override the registry/socket root
- `OMP_PEER_COMS_MAX_HOPS`: default `5`
- `OMP_PEER_COMS_REPLY_TIMEOUT_MS`: default `1800000`
- `OMP_PEER_COMS_REPLY_RESULT_TTL_MS`: default `60000`
- `OMP_PEER_COMS_HEARTBEAT_MS`: default `10000`
- `OMP_PEER_COMS_STALE_MS`: default `45000`
- `OMP_PEER_COMS_FRAME_TIMEOUT_MS`: default `15000`
- `OMP_PEER_COMS_SPAWNED_IDLE_TIMEOUT_MS`: default `1800000`; set `0` to disable spawned-peer idle exit
- `OMP_PEER_COMS_PARENT_CHECK_MS`: default follows `OMP_PEER_COMS_HEARTBEAT_MS`; set `0` to disable parent liveness checks
- `OMP_PEER_COMS_PARENT_PID`: set by `peer_spawn`; child exits when this process disappears
- `OMP_PEER_COMS_SPAWN_CMD`: command to use for spawned peers; defaults to the current OMP entrypoint when detectable, then `omp`

## Scope

This extension is the local peer-to-peer substrate comparable to the original
`coms.ts` idea from `disler/pi-vs-claude-code`, updated for OMP's current
extension runtime and `.omp` filesystem layout.

For multi-machine communication, use this as the client/runtime model and add an
HTTP/SSE hub transport similar to `coms-net`.
