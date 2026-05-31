---
name: peer-collab
description: Provision an ISOLATED peer-coms subnet and spawn peer agents (different models and/or deliberately adversarial stances) into it for real-time horizontal collaboration — debate, red-team/steelman, model-diversity second opinions. Use when a host agent wants to consult or argue with peers as equals rather than delegate bounded work. The subnet is private, so unrelated OMP sessions (other tasks, AgentDesk backends) are never seen or interrupted. Pairs with the agent-collaboration skill (which covers the peer-vs-sub decision rule).
---

# Peer Collaboration (isolated subnet)

Spin up a **private peer-coms subnet** the host owns, spawn peers into it
(different models / stances), collaborate in real time via `peer_send` /
`peer_await`, then tear it down. Peers are independent OMP sessions — equals, not
subagents.

Helper (version-controlled, ships with OMP):
`<oh-my-pi>/.omp/skills/peer-collab/scripts/peer-subnet.sh`. It self-resolves the
peer-coms extension from the installed `omp` binary, so it works wherever the repo
lives (override with `PEER_COMS_EXT`).

For the peer-mode-vs-sub-mode decision rule, see the `agent-collaboration` skill.
This skill is the operational "how" for the isolated-subnet pattern.

## The isolation guarantee (why subnets)

peer-coms scopes membership by the registry dir `OMP_PEER_COMS_DIR` (default
`~/.omp/agent/peer-coms`) plus a `--peer-project` namespace. Loading the extension
on that shared default network makes EVERY omp session — including unrelated tasks
and AgentDesk rpc backends — a visible, interruptible peer. Avoid that.

Each task instead gets a dedicated registry dir under
`~/.omp/agent/peer-subnets/<task>/registry/`. The dir is a hard boundary: a session
on any other `OMP_PEER_COMS_DIR` sees `NONE` of this subnet's peers, even with the
extension loaded. Spawned peers inherit the dir + project + a parent-process lease,
so they self-terminate when the host exits.

## Prerequisite

The peer tools (`peer_list/spawn/send/get/await/shutdown`) exist only when an OMP
session is launched WITH the extension AND pointed at the subnet dir — they are not
auto-loaded (deliberate, for isolation). If your current session lacks them, use the
helper to provision the subnet and peers, then drive the exchange via a short host
invocation bound to the same subnet (Recipe B).

## Recipe A — you already have peer tools, on this subnet

```
peer_list({})
peer_spawn({ name:"skeptic", purpose:"argue this WILL fail in prod; enumerate how",
             model:"anthropic/claude-opus-4-8", agent:"reviewer" })
peer_send({ target:"skeptic", prompt:"Top 5 failure modes of <X> + early-warning signals." })
peer_await({ msg_id:"<id>", timeout_ms:120000 })
peer_shutdown({ target:"skeptic", reason:"done" })
```
`peer_spawn` children inherit the subnet, staying private. Encode each peer's
stance in its `purpose` — that is what it acts on.

## Recipe B — provision from the shell (host lacks peer tools)

```bash
S="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/peer-subnet.sh"   # or absolute path to the helper
S=".omp/skills/peer-collab/scripts/peer-subnet.sh"

bash "$S" new --task design-debate --project review
bash "$S" spawn --task design-debate --name optimist \
  --purpose "defend the design; argue why it works" --model anthropic/claude-sonnet-4-6
bash "$S" spawn --task design-debate --name skeptic \
  --purpose "attack the design; assume prod failure; list how" --model anthropic/claude-opus-4-8

eval "$(bash "$S" host-env --task design-debate)"   # exports OMP_PEER_COMS_DIR, PEER_COMS_EXT, project
omp -e "$PEER_COMS_EXT" --peer-project "$PEER_COMS_PROJECT" --peer-name host -p \
  --model anthropic/claude-sonnet-4-6 \
  "peer_send to skeptic: '<one crisp question + desired artifact>'. Then peer_await (90000ms) and report the answer."

bash "$S" shutdown --task design-debate   # kills peers + removes the subnet
```

### Helper subcommands

| Command | Purpose |
|---|---|
| `new --task ID [--project P]` | create the private subnet; print host env |
| `host-env --task ID` | `eval`-able exports to bind a host to ONLY this subnet |
| `spawn --task ID --name N --purpose P [--model M] [--agent A] [--prompt FILE]` | launch a detached peer |
| `list --task ID [--project P]` | show registered peers |
| `shutdown --task ID` | kill all peers + delete the subnet |

`--agent` may name a peer agent definition (`reviewer`, `oracle`, `plan`, …) from
`.omp/agents`. Pair model + stance to manufacture genuine perspective diversity.

## Dynamics the host can set up

- **Adversarial / red-team:** two peers with opposing mandates ("defend X" vs
  "destroy X"); collect both, host adjudicates. Best for high-stakes/irreversible calls.
- **Panel / diversity:** same question to peers on different models; compare reasoning.
- **Specialist consult:** one peer, deep narrow purpose (e.g. "security review only").
Ask ONE crisp question per `peer_send` and state the artifact you want back.

## Constraints

- **Always a private subnet** — never the shared default `~/.omp/agent/peer-coms`.
- **Provider-qualified models** (`anthropic/...`) to avoid Bedrock misresolution.
- **One inbound message per peer at a time** (busy peers reject); sequence or add peers.
- **Reply rule:** a peer answers an inbound message with a NORMAL assistant reply
  (peer-coms returns it automatically); it does not `peer_send` back to answer.
- **Always `shutdown`** when done. Peers also self-exit on host death + idle timeout,
  but clean up so you don't pay for idle full OMP processes.
- **AgentDesk** passes `--peer-*` identity flags but does NOT load the extension, so its
  backends are not peers by default (good). Enable peers for a deployment only on a
  dedicated subnet dir, never the default network.
