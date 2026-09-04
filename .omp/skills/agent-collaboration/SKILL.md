---
name: agent-collaboration
description: Choose between peer mode and sub mode for multi-agent work. Use when deciding whether to consult flat peer Pi agents through peer-coms or spawn hierarchical subagents/tasks.
---

# Agent Collaboration

Use two collaboration modes:

- **peer mode**: flat Pi-to-Pi agent-to-agent communication. Use `peer_list`, `peer_spawn`, `peer_send`, `peer_get`, `peer_await`, and `peer_shutdown` when peer-coms tools are available.
- **sub mode**: hierarchical delegation. Use the task/subagent mechanism when available to spawn bounded subagents.

## Choose Peer Mode

Use peer mode when the task benefits from multiple independent models or perspectives talking as equals.

Good fits:

- architecture debates
- adversarial review
- ambiguous product or design decisions
- comparing model-specific strengths
- asking a specialist peer to critique or refine an answer
- flat back-and-forth where no single agent should own the whole plan

Pros:

- independent perspectives reduce single-model blind spots
- natural for critique, debate, and synthesis
- peers can run different models or prompts
- no forced hierarchy

Cons:

- needs live peer sessions
- spawning a new peer may open another terminal/session
- higher latency if waiting for replies
- coordination can drift without a clear question
- state is distributed across sessions

## Choose Sub Mode

Use sub mode when the work can be split into bounded tasks with a clear owner and return artifact.

Good fits:

- search or codebase exploration
- independent implementation subtasks
- test writing
- focused review of a specific diff or file
- collecting facts for a primary agent to synthesize

Pros:

- clear parent/child control flow
- easier to bound scope and summarize outputs
- efficient for parallel research or implementation
- less coordination overhead

Cons:

- parent agent becomes the bottleneck
- subagents can inherit parent assumptions
- less useful for true debate
- model diversity depends on runtime support

## Decision Rule

Default to **sub mode** for narrow, decomposable work. Choose **peer mode** when the main value is independent judgment, critique, model diversity, or flat deliberation.

If both are useful, use peer mode first for high-level disagreement or strategy, then sub mode for execution.

If no suitable peer exists, use `peer_spawn` before `peer_send`. If the task is hierarchical, spawn a subagent/task directly instead of creating a peer.

If you spawned peers only for the current task, call `peer_shutdown` for those peers after their useful work is complete.

## Peer Mode Prompt Shape

When using `peer_send`, ask one crisp question and specify the desired artifact:

```text
Ask reviewer: Critique this plan for failure modes and missing tests. Return the top 5 risks and concrete mitigations.
```

Do not use `peer_send` to answer an inbound peer-coms message. Reply normally; peer-coms returns the final assistant response automatically.

## Sub Mode Prompt Shape

When spawning a subagent/task, give a bounded objective and expected return artifact:

```text
Explore the auth package and report the exact files and tests that need changes. Do not edit files.
```
