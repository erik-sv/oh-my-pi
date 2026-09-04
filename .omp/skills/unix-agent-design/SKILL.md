---
name: unix-agent-design
description: Audit tool/MCP interfaces, HTTP route handlers, CLIs, and agent spawn configs against 10 Unix agent design criteria (navigation errors, overflow mode, binary guards, metadata footers, composability, and more), producing a scored findings table. Use when reviewing or designing agent-facing tool surfaces, MCP servers, or agent harnesses. TRIGGER when the user says "unix agent design", "audit this tool interface", "agent ergonomics review", or asks whether a tool/MCP surface is well designed for agents.
---

# Unix Agent Design Audit

When invoked, audit the tool/MCP interface(s) in the codebase against the 10 Unix agent design criteria below. If a specific file or project is named, audit that. Otherwise discover tool definitions automatically.

---

## Discovery Scope

Search for these patterns to find auditable surfaces:

- **MCP servers**: `server.js`, `*-mcp/`, `setRequestHandler`, `CallToolRequestSchema`, `ListToolsRequestSchema`
- **HTTP route handlers**: `app.get`, `app.post`, `app.put`, `router.get`, `router.post`, `res.json()` — check 404/400/500 responses for navigation hints
- **Agent spawn configs / system prompts** — do prompts give navigation hints to the spawned agent?
- **CLI interfaces** that agents invoke
- **Tool handler functions**: `tools/`, `handlers/`, `function handle*`

**Harness shortcut**: if a handler uses `wrapHandler` from `agent-harness/`, criteria 2, 3, 4, 7, and 8 auto-pass. Note this in findings and move on to the remaining criteria.

---

## The 10 Audit Criteria

| # | Criterion | PASS | PARTIAL | FAIL |
|---|---|---|---|---|
| 1 | **Navigation errors** | Every error contains concrete next action (tool name + example call) | Some errors have hints, some don't | Bare error messages with no next step |
| 2 | **Overflow mode** | Large output → truncate + save to temp file + path + navigation hints | Truncation exists but no temp file or no hints | Hard reject OR full blob returned to LLM |
| 3 | **Binary guard** | Null-byte / encoding / control-char check before content reaches LLM + typed redirect | Detection exists but redirect message is unhelpful | Raw bytes returned, or no detection at all |
| 4 | **Metadata footer** | `[exit:N | Xms]` or `[OK|ERROR | Xms]` on EVERY response path (success AND error) | Footer on success paths but missing on some error paths | No footer at all |
| 5 | **Progressive help L1** | No-arg or missing-required-arg call → usage string with subcommands/params | Returns error mentioning usage but not full syntax | Returns error with no usage hint whatsoever |
| 6 | **Progressive help L0** | Tool description dynamically enumerates available commands with one-line summaries | Static description mentions some capabilities | Opaque description or no command enumeration |
| 7 | **Stderr attachment** | Failure responses include stderr content; never silently dropped | Sometimes attached, depends on code path | Stderr silently dropped when stdout is non-empty |
| 8 | **Two-layer separation** | Presentation logic (truncation, footer, binary guard) is in a separate module/wrapper, not woven into business logic | Some separation (shared helper functions) but not fully modular | Layer 2 logic duplicated inside every handler |
| 9 | **Tool surface area** | ≤5 tools OR a unified run-style tool with command dispatch | 6-9 tools, or some consolidation attempted | 10+ fragmented tools with different schemas |
| 10 | **Chain composition** | `|`, `&&`, `||`, `;` supported — commands can be composed in one call | Partial support (e.g., only pipe) | Each call fully isolated, no composition |

---

## Steps

1. **Discover tools** — find MCP server files, HTTP route handlers, function schemas, tool handler functions, agent spawn configs, and CLI interfaces in the codebase using the discovery scope above.

2. **Check for harness shortcut** — if handlers use `wrapHandler` from `agent-harness/`, mark criteria 2/3/4/7/8 as auto-PASS and note it.

3. **Audit each tool** against all 10 criteria. For each criterion, find the specific line(s) that pass, partially pass, or fail. Quote the actual code with `file:line`.

4. **Score** — mark each cell PASS, PARTIAL, or FAIL.

5. **Audit HTTP handlers** — if Express/Fastify routes are found, apply the same 10 criteria to error responses (404, 400, 500).

6. **Produce the report** in the output format below.

---

## Output Format

```
## Unix Agent Design Audit: [project/file]

### Summary
[1-2 sentences on overall health — direct about worst problems]

### Tool Inventory
| Tool | Nav Errors | Overflow | Binary Guard | Footer | Help L1 | Help L0 | Stderr | Two-Layer | Surface | Chains |
|---|---|---|---|---|---|---|---|---|---|---|
| tool_name | PASS/PARTIAL/FAIL | ... | ... | ... | ... | ... | ... | ... | ... | ... |

### Findings by Tool

#### [tool_name]
**1. Navigation errors** [PASS/PARTIAL/FAIL]
- [specific finding with file:line — quote the code]
- [what to change if FAIL/PARTIAL]

**2. Overflow mode** [PASS/PARTIAL/FAIL]
- [specific finding with file:line]
- [what to change if FAIL/PARTIAL]

**3. Binary guard** [PASS/PARTIAL/FAIL]
- [specific finding with file:line]
- [what to change if FAIL/PARTIAL]

**4. Metadata footer** [PASS/PARTIAL/FAIL]
- [specific finding with file:line]
- [what to change if FAIL/PARTIAL]

**5. Progressive help L1** [PASS/PARTIAL/FAIL]
- [specific finding with file:line]
- [what to change if FAIL/PARTIAL]

**6. Progressive help L0** [PASS/PARTIAL/FAIL]
- [specific finding with file:line]
- [what to change if FAIL/PARTIAL]

**7. Stderr attachment** [PASS/PARTIAL/FAIL]
- [specific finding with file:line]
- [what to change if FAIL/PARTIAL]

**8. Two-layer separation** [PASS/PARTIAL/FAIL]
- [specific finding with file:line]
- [what to change if FAIL/PARTIAL]

**9. Tool surface area** [PASS/PARTIAL/FAIL]
- [total tool count and organization]
- [what to change if FAIL/PARTIAL]

**10. Chain composition** [PASS/PARTIAL/FAIL]
- [specific finding with file:line]
- [what to change if FAIL/PARTIAL]

### API Response Audit (if HTTP handlers found)
[Same 10 criteria applied to Express/Fastify route handlers — focus on 404/400/500 error responses]

### Priority Improvements
1. [Most impactful — specific file:line with exact change needed]
2. ...
3. ...

### Patterns from Production
[Pick the 2-3 war stories most relevant to what was found — see reference stories below]
```

---

## Scoring Guidance

- **Navigation errors PASS**: error message contains a concrete next action (tool name + example call or direction to use)
- **Overflow PASS**: there is a truncation path that writes to a temp file, returns the path, AND gives navigation hints
- **Binary guard PASS**: explicit null-byte check OR encoding catch that produces a clean redirect (not just "binary file" with no next step)
- **Footer PASS**: every return path (success AND error) ends with a timing+status token
- **Help L1 PASS**: the no-argument or missing-required-arg path returns a usage string with syntax, not just an error
- **Help L0 PASS**: the tool's description (as seen by the LLM in the tool list) enumerates commands with one-liners
- **Stderr PASS**: failure path includes stderr content in the returned text; no code path silently discards it
- **Two-layer PASS**: presentation logic is in a dedicated module/wrapper (e.g., `agent-harness/layer2.js`), not repeated in each handler
- **Surface area PASS**: ≤5 tools, OR a unified `run(command)` style tool that dispatches to subcommands
- **Chains PASS**: the tool or command interface supports `|`, `&&`, `||`, `;` for composing multiple operations

---

## Patterns from Production

Reference these war stories when findings match. Include the 2-3 most relevant in the report.

**Story 1: PNG cat → 20 iterations of thrashing** (criterion 3 — binary guard)
An agent was asked to describe an image. It called `read_file("photo.png")`, got back raw bytes as garbled tokens, and spent 20 iterations trying to "parse" the output — retrying, changing encodings, asking for help — before the conversation hit the context limit. Fix: an `isBinary()` guard that checks for null bytes before returning content, redirecting with `"Binary file detected. Use: see photo.png"`.

**Story 2: pip install stderr dropped → 10 blind retries** (criterion 7 — stderr attachment)
An agent ran `pip install` which failed. The tool returned an empty stdout (pip writes errors to stderr). The agent saw a blank response, assumed a transient failure, and retried the exact same command 10 times. Fix: always attach stderr on non-zero exit, even when stdout is non-empty.

**Story 3: 5000-line log → context overwhelmed** (criterion 2 — overflow mode)
An agent catted a 5000-line log file. The full content was returned into context, pushing out prior conversation and tool definitions. Response quality dropped sharply — the agent lost track of its task and began hallucinating. Fix: truncate at a configurable line limit, write the full output to a temp file, and return the path with grep/tail hints for navigation.
