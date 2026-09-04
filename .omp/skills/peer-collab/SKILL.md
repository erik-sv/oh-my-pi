---
name: peer-collab
description: Spin up an ISOLATED subnet of peer OMP agents (often different models, or deliberately adversarial perspectives) for real-time horizontal collaboration — debate, critique, cross-examination, model-diversity second opinions. Use when the host agent wants to consult or argue with peers as equals rather than delegate bounded work. Triggers — "spawn a peer", "ask another model", "get a second opinion", "red-team / steelman this", "have agents debate this", "consult a reviewer/architect peer", "set up a panel". The subnet is private so unrelated OMP sessions (other tasks, AgentDesk backends) are never seen or interrupted.
argument-hint: "[task-id] [what perspectives/peers you want]"
allowed-tools: Read, Write, Edit, Bash
---

# Peer Collaboration (isolated subnet)

Provision a **private peer-coms subnet** the host agent owns, spawn one or more
peers into it (different models and/or deliberately different stances), and
collaborate in real time via `peer_send` / `peer_await`. Peers are independent OMP
sessions — equals, not subagents. When done, tear the subnet down.

Helper (canonical, version-controlled, ships with OMP):
`${CLAUDE_SKILL_DIR}/scripts/peer-subnet.sh`
(= `<oh-my-pi>/.omp/skills/peer-collab/scripts/peer-subnet.sh`). It self-resolves
the peer-coms extension from the installed `omp` binary (override with
`PEER_COMS_EXT`).

## The isolation problem this solves (read this first)

peer-coms discovers peers through a shared registry dir (`OMP_PEER_COMS_DIR`,
default `~/.omp/agent/peer-coms`) plus a `--peer-project` namespace. If the
extension is loaded globally / on the default network, **every** OMP process —
including unrelated tasks and AgentDesk's rpc backends — becomes a visible,
interruptible peer. That is the failure mode to avoid.

**Fix: one private subnet per task.** This skill gives the host a dedicated
`OMP_PEER_COMS_DIR` under `~/.omp/agent/peer-subnets/<task>/registry/`. Membership
is bounded by that dir — a hard boundary, verified: an OMP session on any other
registry sees `NONE` of this subnet's peers, even with the extension loaded.
Peers inherit the dir + project + a parent-process lease, so they self-terminate
when the host exits. Nothing leaks onto the default network.

## Peers vs subagents (when to reach for this)

Use **peer-collab** when the value is *independent judgment / friction*:
- architecture or product trade-off debates
- adversarial review: red-team a plan/diff, steelman the opposite choice
- comparing how *different models* answer the same hard question
- a specialist "second mind" that can push back, not just execute

Use **native `task` subagents** when one agent owns the work and delegates bounded,
returnable units (exploration, edits, test writing, fact-collection). Default to
subagents for narrow work; spawn peers only when disagreement/model-diversity is
worth a full extra process (~hundreds of MiB RSS + provider load each).

Common combo: peers to challenge the plan → subagents to execute → a reviewer peer
to check the final diff.

## Prerequisite: the host must load peer-coms in the subnet

The peer tools (`peer_list/spawn/send/get/await/shutdown`) only exist when the
host OMP session is launched with the extension AND pointed at the subnet dir.
They are NOT auto-loaded (deliberately — see isolation problem). Two cases:

- **You (the host) are already running with peer tools + on this subnet** → just
  use `peer_send` etc. Check with `peer_list`.
- **You do NOT have peer tools** (typical) → you cannot join a subnet mid-session.
  Provision the subnet and spawn peers with the helper (below); then either relaunch
  the host with the printed `host-env`, OR drive the whole exchange through a short
  detached host the helper-spawned peers answer. For most uses, the simplest path is:
  spawn the peers, then ask them via a one-shot host invocation (see Recipe B).

## Recipe A — host already has peer tools

```
peer_list({})                                  # who's already in my subnet?
peer_spawn({ name:"reviewer", purpose:"red-team this plan; find failure modes",
             model:"anthropic/claude-opus-4-8", agent:"reviewer" })
peer_send({ target:"reviewer", prompt:"Critique this migration plan. Top 5 risks + mitigations." })
peer_await({ msg_id:"<from peer_send>", timeout_ms:120000 })
# ... synthesize; spawn a second peer with a DIFFERENT model for contrast if useful ...
peer_shutdown({ target:"reviewer", reason:"done" })
```
`peer_spawn` children inherit your subnet dir + project, so they stay private.
Give each peer a sharp `purpose` — that is what it acts on. For adversarial setups,
encode the stance in the purpose ("argue AGAINST this design; assume it will fail").

## Recipe B — provision a subnet + peers from the shell (host lacks peer tools)

```bash
S="${CLAUDE_SKILL_DIR}/scripts/peer-subnet.sh"

# 1) create the private subnet
bash "$S" new --task migration-debate --project review

# 2) spawn peers (different models / stances) into it
bash "$S" spawn --task migration-debate --name optimist \
  --purpose "argue FOR the chunked-storage migration; defend it" \
  --model anthropic/claude-sonnet-4-6 --project review
bash "$S" spawn --task migration-debate --name skeptic \
  --purpose "argue AGAINST it; assume it fails in prod; list how" \
  --model anthropic/claude-opus-4-8 --project review

# 3) ask them (one-shot host bound to the SAME subnet); peers answer normally
eval "$(bash "$S" host-env --task migration-debate)"   # exports OMP_PEER_COMS_DIR, PEER_COMS_EXT
omp -e "$PEER_COMS_EXT" --peer-project review --peer-name host -p \
  --model anthropic/claude-sonnet-4-6 \
  "peer_send to skeptic: 'Give the 3 most likely production failures of an append-only
   chunk-row session store and the early-warning signal for each.' Then peer_await
   (90000ms) and report the answer."

# 4) tear it ALL down (kills peers, removes the subnet dir)
bash "$S" shutdown --task migration-debate
```

### Helper subcommands

| Command | Purpose |
|---|---|
| `new --task ID [--project P]` | create the private subnet; print host env |
| `host-env --task ID` | `eval`-able exports so a host joins ONLY this subnet |
| `spawn --task ID --name N --purpose P [--model M] [--agent A] [--prompt FILE] [--project P]` | launch a detached peer into the subnet |
| `list --task ID [--project P]` | show registered peers |
| `shutdown --task ID` | kill all peers + delete the subnet |

`--agent` may name a peer agent definition (e.g. `reviewer`, `oracle`, `plan`) from
`.omp/agents`; pair model + stance to manufacture genuine perspective diversity.

## Setting up adversarial vs cooperative dynamics

The host controls the dynamic purely through each peer's `--purpose`/prompt:
- **Adversarial / red-team:** give two peers opposing mandates ("defend X" vs "destroy
  X"), collect both, then you adjudicate. Best for high-stakes/irreversible decisions.
- **Panel / diversity:** same question to peers on different models; compare reasoning,
  surface where they diverge.
- **Specialist consult:** one peer with a deep, narrow purpose ("security review only").
Always ask ONE crisp question per `peer_send` and state the artifact you want back.

## Constraints

- **Always use a private subnet** (`new`/`host-env`), never the default network. The
  default `~/.omp/agent/peer-coms` is shared by all sessions — joining it lets you see
  and interrupt unrelated work. Verified: a session on a different `OMP_PEER_COMS_DIR`
  sees `NONE` of your peers.
- **Provider-qualified models** (`anthropic/...`) — bare names risk Bedrock misresolution.
- **One inbound message per peer at a time** — a peer busy answering returns a busy
  rejection. Sequence, or spawn more peers.
- **Reply rule:** a peer answers an inbound message with a NORMAL assistant reply;
  peer-coms returns that text automatically. Do not `peer_send` back just to answer.
  (Peers MAY `peer_send` a *third* peer to consult — hop-limited.)
- **Always `shutdown`** (or `peer_shutdown` each peer) when the collaboration ends.
  Peers also self-exit if the host dies (parent lease) and after an idle timeout, but
  clean up explicitly so you don't pay for idle sessions.
- **Cost:** each peer is a full OMP process. Spawn the few that add perspective, not many.
- **Resource note:** AgentDesk launches OMP with `--peer-*` identity flags but does NOT
  load the extension, so AgentDesk sessions are not peers by default — good (they stay
  private). To make a specific deployment peer-capable, load the extension for that launch
  on a dedicated subnet dir, never the default one.
