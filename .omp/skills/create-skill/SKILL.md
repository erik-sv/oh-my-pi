---
name: create-skill
description: Scaffold and write new Claude Code skills with correct structure, frontmatter, and best practices. Use when the user wants to create a new skill, slash command, or reusable prompt template — or when they say things like "make a skill for", "add a slash command", "create a command that", or "I want a skill to".
argument-hint: "[skill-name] [brief purpose]"
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion
---

# Create Skill

You are building a new Claude Code skill. Follow this process exactly.

## Step 1 — Gather requirements

Parse `$ARGUMENTS` for a skill name and purpose. If either is missing or ambiguous, ask the user:

1. **Name** — what slash command should invoke this? (lowercase, hyphens, action-oriented: `review-pr`, `generate-migration`, `audit-deps`)
2. **Purpose** — one sentence: what does the skill do and when should it trigger?
3. **Scope** — personal (`~/.claude/skills/`) or project (`.claude/skills/`)?  Default: personal.
4. **Invocation** — who triggers it?
   - User only → `disable-model-invocation: true` (use for skills with side effects: deploy, commit, send)
   - Claude only → `user-invocable: false` (use for background knowledge Claude applies automatically)
   - Both → defaults (most common)
5. **Arguments** — does the skill accept arguments? What are they?
6. **Isolation** — should it run in a forked context? (`context: fork` for research, exploration, or long-running tasks)

## Step 2 — Write the SKILL.md

Create `<scope-path>/skills/<skill-name>/SKILL.md` with the structure below.

### Frontmatter rules

```yaml
---
name: <skill-name>
description: <what it does AND when to use it — be specific, include trigger keywords>
argument-hint: <if arguments are accepted>
disable-model-invocation: <true if user-only>
user-invocable: <false if claude-only>
allowed-tools: <comma-separated list of tools the skill needs>
---
```

**Frontmatter field reference:**

| Field | When to include |
|---|---|
| `name` | Always. Lowercase, hyphens, no "claude"/"anthropic". Max 64 chars. |
| `description` | Always. Max 1024 chars. Third person. Include trigger contexts. |
| `argument-hint` | When skill accepts arguments. Show placeholders: `[issue-number]` |
| `disable-model-invocation` | When skill has side effects or should not auto-trigger |
| `user-invocable` | Set `false` for background knowledge skills |
| `allowed-tools` | When skill needs specific tool permissions |
| `model` | When skill requires a specific model |
| `effort` | When skill needs non-default effort: `low`, `medium`, `high`, `max` |
| `context` | Set `fork` for isolated execution |
| `agent` | With `context: fork` — set subagent type: `Explore`, `Plan`, `general-purpose` |

### Description best practices

The description is the most important field. Claude uses it to decide whether to auto-load the skill. Write it in third person (it gets injected into the system prompt).

**Bad:** `"Helps with tests."`
**Good:** `"Run and analyze test suites, generate missing test cases, and diagnose flaky tests. Use when the user mentions testing, asks to add tests, says 'why is this test failing', or wants test coverage analysis."`

Rules:
- Start with what the skill does (verbs)
- Then say when to use it (trigger contexts)
- Include specific keywords users would say naturally
- Be assertive — Claude under-triggers, so lean toward more trigger contexts
- Stay under 1024 characters

### Body structure

Write the markdown body following this pattern:

```markdown
# Skill Title

Brief overview of what this skill does (1-2 sentences).

## Process

Step-by-step instructions Claude follows when this skill is invoked.
Number the steps. Be specific about what to do, not vague directives.

## Output format

Define expected output structure — templates, checklists, report formats.
Include concrete examples of good output.

## Constraints

What to avoid, edge cases, guardrails.
Explain WHY each constraint exists so Claude can judge edge cases.
```

### Body writing rules

1. **Under 500 lines.** If you need more, split into supporting files.
2. **Imperative voice.** "Read the file" not "You should read the file."
3. **Explain the why.** "Use streaming responses because batch responses over 4KB get truncated by the proxy" — not just "Use streaming responses."
4. **Include examples.** Concrete input/output pairs beat abstract descriptions.
5. **Only add what Claude doesn't know.** Challenge each paragraph: does Claude already know this? If yes, cut it.
6. **Set degrees of freedom.** High for creative tasks, low for fragile operations.
7. **Use `$ARGUMENTS`** for dynamic content: `$0` for first arg, `$1` for second, or `$ARGUMENTS` for all.
8. **Use `` !`command` ``** for dynamic context injection (runs before sending to Claude):
   ```
   Current branch: !`git branch --show-current`
   ```

## Step 3 — Add supporting files (if needed)

Only create supporting files when the skill body would exceed 500 lines or needs reusable assets.

```
<skill-name>/
├── SKILL.md              # Required: main instructions
├── reference.md          # Optional: detailed docs, API specs, schemas
├── template.md           # Optional: output template for Claude to fill
├── examples/             # Optional: example inputs and outputs
│   └── sample-output.md
└── scripts/              # Optional: executable scripts Claude can run
    └── validate.sh
```

Rules for supporting files:
- Keep references one level deep from SKILL.md (no nested references)
- For files over 100 lines, add a table of contents at the top
- Name files descriptively: `form_validation_rules.md` not `doc2.md`
- Use forward slashes in all paths

## Step 4 — Verify

After creating the skill:

1. Confirm the directory exists and SKILL.md is properly formatted
2. Verify frontmatter YAML is valid (no tabs, proper indentation)
3. Check that the description is under 1024 characters
4. Check that the body is under 500 lines
5. Tell the user: "Skill created at `<path>`. Invoke with `/<skill-name>` or start a new session for auto-discovery."

## Naming conventions

| Pattern | Example | When |
|---|---|---|
| `verb-noun` | `review-pr`, `generate-migration` | Action-oriented tasks |
| `verb-ing-noun` | `processing-pdfs`, `analyzing-deps` | Ongoing/background skills |
| `prefix-action` | `db-migrate`, `api-generate` | Thematic grouping for autocomplete |

Avoid: `helper`, `utils`, `tools`, `misc`, single words, names starting/ending with hyphens, double hyphens.

## Variable reference

| Variable | Expands to |
|---|---|
| `$ARGUMENTS` | All arguments passed to the skill |
| `$0`, `$1`, `$2` | Positional arguments (0-indexed) |
| `$ARGUMENTS[N]` | Same as `$N` |
| `${CLAUDE_SESSION_ID}` | Current session ID |
| `${CLAUDE_SKILL_DIR}` | Directory containing this SKILL.md |

## Common patterns

### Task skill (user-invoked, specific action)
```yaml
---
name: deploy-staging
description: Deploy current branch to staging environment. Use when the user says "deploy", "push to staging", or "ship it to staging".
disable-model-invocation: true
allowed-tools: Bash
---
```

### Reference skill (auto-triggered, background knowledge)
```yaml
---
name: api-conventions
description: REST API conventions and patterns for this project. Use when editing API routes, controllers, or middleware — or when the user asks about API design patterns.
user-invocable: false
---
```

### Research skill (forked context, exploration)
```yaml
---
name: investigate-issue
description: Deep-dive investigation of a bug or issue. Use when the user says "investigate", "dig into", "figure out why", or provides an issue number to research.
argument-hint: "[issue-number or description]"
context: fork
agent: Explore
---
```

### Parameterized skill (arguments drive behavior)
```yaml
---
name: migrate-component
description: Migrate a component between frameworks. Use when the user wants to convert, migrate, or port a component.
argument-hint: "[component-name] [source-framework] [target-framework]"
---
# Migrate $0 from $1 to $2
```
