# Zoho One Skill (Vera)

Agent skill for interacting with Zoho One as **Vera** (`vera.agent@encypher.com`),
a dedicated AI service account. Covers Cliq messaging, CRM, Sheet, WorkDrive,
Mail, and **Zoho Writer documents** (create / share / export / email).

This repository is checked out in place at `~/.claude/skills/zoho`, so the
harness discovers it as a user skill and the files that run are the files under
version control.

## Layout

| Path | Purpose |
| --- | --- |
| `SKILL.md` | Skill instructions + endpoint recipes (the agent reads this) |
| `scripts/zoho-api.sh` | Authenticated Zoho API caller; auto-refreshes the token. `zoho-api.sh token` prints a bare token for callers that build their own curl. |
| `scripts/zoho-doc.sh` | Writer documents: `create / share / get / export / trash / delete / email / deliver`. Writes Markdown -> `.docx` (pandoc) -> Writer. |
| `scripts/crm.sh` | High-level CRM convenience commands (pipeline, find, org, health, stale, summary). |

## Setup

Credentials live outside the repo at `~/.config/encypher/zoho-vera.env`
(created by `setup-zoho-vera.sh` in the agentdesk repo). `zoho-api.sh` refreshes
and caches the access token automatically; nothing secret is stored here.

## Quick start

```bash
Z=~/.claude/skills/zoho/scripts
# Make a formatted doc from Markdown, share it, and email the link + .docx:
bash "$Z/zoho-doc.sh" deliver --file brief.md --to "person@example.com" \
  --name "Encypher Brief (v1.0)" --subject "Brief" --body body.html --role editor
```

See `SKILL.md` for the full command reference and the hard-won Writer API facts.
