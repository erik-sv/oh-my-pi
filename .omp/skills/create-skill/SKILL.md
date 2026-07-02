---
name: create-skill
description: Scaffold, write, verify, and land new OMP/Claude skills with correct structure, frontmatter, discoverability, and version control - optionally with a paired slash command or pinned-model agent definitions. Use when the user wants to create a new skill, slash command, or reusable prompt template - or says "make a skill for", "add a slash command", "create a command that", "I want a skill to", or asks why a skill is not being discovered.
argument-hint: "[skill-name] [brief purpose]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task
---

# Create Skill

Build a new skill that is discoverable, correct, and version-controlled. Follow
this process exactly. It encodes hard-won conventions: a skill that parses wrong
or lives in the wrong place silently disappears from every session.

## Discovery facts (why the rules below exist)

How OMP actually finds and uses skills:

- Skills are discovered ONE level under a skills root: `<root>/<name>/SKILL.md`.
  Nested dirs (`<root>/group/<name>/SKILL.md`) are silently invisible.
- The frontmatter fence must be exactly `---` on its own line, top and bottom.
  A corrupted fence (e.g. a bare `-`) does not error - the skill loads with an
  EMPTY description and the model can never match it. This exact corruption
  once blinded 9 skills on this machine.
- The `description` is the ONLY signal the model gets in its system prompt.
  No description = listed but never matched.
- `disable-model-invocation: true` hides the skill from the system-prompt list
  entirely. `/skill:<name>` still works - but ONLY in the interactive TUI.
  RPC-hosted sessions (AgentDesk) never see it. A hidden skill that must stay
  user-only therefore needs a file-based COMMAND wrapper to be reachable
  everywhere (see Step 4).
- Name collisions resolve first-wins by provider precedence (project `.omp`
  beats user `~/.claude`); identical files via symlink are realpath-deduped.
  Never create a second copy of an existing skill - fix the original.
- OMP honors: `name`, `description`, `globs`, `alwaysApply`, `hide`,
  `disable-model-invocation`. Fields like `argument-hint`, `allowed-tools`,
  `model`, `effort` are Claude Code conventions - harmless, kept as metadata.
  Claude Code fields OMP ignores functionally: `user-invocable`,
  `context: fork`, `agent`.

## Step 1 - Gather requirements

Parse `$ARGUMENTS` for a name and purpose. Ask only for what is missing:

1. **Name** - lowercase, hyphens, action-oriented: `review-pr`, `audit-deps`.
2. **Purpose** - one sentence: what it does, when it triggers.
3. **Home** - where the canonical file lives (see table). Default: the
   version-controlled library.
4. **Invocation** - both (default) | user-only (`disable-model-invocation:
   true` for side-effect skills: deploy, commit, send - MUST pair with a
   command wrapper, Step 4) | model-only (`hide: true`).
5. **Arguments** - if accepted, define `argument-hint` placeholders.
6. **Companions** - does it need a `/name` slash command? Subagents pinned to
   a specific model?

### Home decision table

| Skill is... | Canonical home | Live discovery |
|---|---|---|
| General-purpose (default) | `~/src/oh-my-pi/.omp/skills/<name>/` | symlink `~/.claude/skills/<name>` -> canonical |
| Specific to one repo | `<repo>/.claude/skills/<name>/` (commit there) | discovered when cwd is that repo |
| Owned by a data/tool repo | that repo's `.claude/skills/<name>/` | symlink from `~/.claude/skills/<name>` if wanted globally |

NEVER create a bare, unversioned skill directly in `~/.claude/skills/` - every
skill lands in a git repo, and the symlink layer provides machine-wide
discovery. This is how fixes stay landable.

## Step 2 - Write the SKILL.md

### Frontmatter

```yaml
---
name: <skill-name>            # must equal the directory name
description: <what it does AND when to use it - specific trigger keywords>
argument-hint: "[arg] [--flag]"        # only if arguments are accepted
disable-model-invocation: true         # only for user-only side-effect skills
allowed-tools: <tools the skill needs>
---
```

### Description best practices

The description decides whether the skill is ever used. Third person; injected
into the system prompt.

**Bad:** `"Helps with tests."`
**Good:** `"Run and analyze test suites, generate missing test cases, and
diagnose flaky tests. Use when the user mentions testing, asks to add tests,
says 'why is this test failing', or wants coverage analysis."`

Rules:
- Start with what the skill does (verbs), then when to use it (triggers).
- Include the exact phrases a user would say; models under-trigger, so lean
  toward more trigger contexts.
- Under 1024 characters. Never leave it empty.

### Body structure and writing rules

```markdown
# Skill Title

One-two sentence overview.

## Process
Numbered, imperative steps. Specific actions, not vague directives.

## Output format
Templates / report structures with concrete examples.

## Constraints
Guardrails, each with its WHY so edge cases can be judged.
```

1. **Under 500 lines**; split into supporting files beyond that.
2. **Imperative voice.** "Read the file", not "You should read the file".
3. **Explain the why** on every constraint.
4. **Concrete examples** beat abstract descriptions.
5. **Only what the model doesn't already know** - challenge every paragraph.
6. `$ARGUMENTS` / `$0`, `$1` for arguments; `${CLAUDE_SKILL_DIR}` for the
   skill's own directory (survives symlinks; use it to reference `scripts/`).

## Step 3 - Supporting files (only if needed)

```
<skill-name>/
├── SKILL.md          # required
├── reference.md      # heavy docs the body links to
├── examples/
└── scripts/          # executables; reference via ${CLAUDE_SKILL_DIR}/scripts/
```

Keep references one level deep. Access assets as `skill://<name>/<path>`.

## Step 4 - Companions (when asked for)

**Slash command** (works in TUI AND RPC/AgentDesk sessions, unlike `/skill:`):
create `~/src/oh-my-pi/.omp/commands/<name>.md`, symlink from
`~/.claude/commands/<name>.md`. Frontmatter: `description`, `argument-hint`.
Body: instruct reading `skill://<name>` and executing with `$ARGUMENTS`.
This is REQUIRED for any `disable-model-invocation` skill that must be
reachable from AgentDesk.

**Pinned-model agents** (in-process subagents on a specific model): create
`~/src/oh-my-pi/.omp/agents/<agent>.md`, symlink from
`~/.omp/agent/agents/<agent>.md`. Frontmatter: `name`, `description`,
`tools` (CSV), `model: <provider/model:thinkingLevel>` (e.g.
`openai-codex/gpt-5.5:xhigh`, `anthropic/claude-opus-4-8:high`); body is the
agent's system prompt. Always include: "call the yield tool with your COMPLETE
answer as its text payload - never yield empty/null" (GPT-family agents have
lost payloads without it). See `reviewer-gpt55` / `sweep-opus` as references.

## Step 5 - Verify (do not skip)

1. Fence check: first line is exactly `---`, and the block closes with `---`.
2. Parse check: frontmatter has non-empty `name` (== dir name) and
   `description`.
3. Discovery check: boot a throwaway session and confirm the skill lists with
   its description - `omp --mode rpc`, send `{"type":"get_state"}`, grep the
   returned systemPrompt for `- <name>: <desc...>`; for a command wrapper,
   check `available_commands_update` contains `<name>`. (A new TUI session's
   skill list works too.)
4. If agents were created: spawn each once and confirm the pinned model (ask
   it to report the `Model:` line from its system prompt).

## Step 6 - Land it

Commit the canonical files (skill + command + agents + symlink note) in their
repo - for the default home:

```bash
cd ~/src/oh-my-pi && git add .omp/skills/<name> [.omp/commands/<name>.md] [.omp/agents/...] \
  && git commit -m "feat(.omp): add <name> skill" && git push origin main
```

An uncommitted skill is a regression waiting to happen; the library was
migrated to version control precisely so fixes land.

## Naming conventions

`verb-noun` (`review-pr`), `verb-ing-noun` (`processing-pdfs`), or
`prefix-action` (`db-migrate`). Avoid `helper`, `utils`, `misc`, single words,
double or leading/trailing hyphens. Name must equal the directory name.

## Constraints

- Never duplicate an existing skill name - fix or extend the original
  (first-wins shadowing makes duplicates a silent drift trap).
- Never leave a skill unversioned or a description empty.
- Never rely on `/skill:<name>` for reachability of hidden skills outside the
  TUI - pair with a command file.
- Verify discovery (Step 5) before declaring the skill done. A skill that
  does not surface in a fresh session does not exist.
