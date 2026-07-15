# TEAM_010 Peer Comms Removal

## Status
Complete

## Goal
Compare the local fork checkout with `origin/main`. If the fork is not ahead, finish removing the global peer-comms extension, peer collaboration skills, and active references.

## Evidence
- `git fetch origin` completed.
- `git rev-list --left-right --count HEAD...origin/main` returned `0 0`.
- Local `HEAD` and `origin/main` both resolved to `7be7da937d0dbc2605870dbaf29343f8dee089f5`.
- The checkout already contained uncommitted deletions for the peer-comms extension and its tests before TEAM_010 edits.

## Work log
- Removed `.omp/skills/agent-collaboration/`.
- Removed `.omp/skills/peer-collab/`, including `peer-subnet.sh`.
- Removed the peer-comms extension entry from `.omp/settings.json`.
- Removed `docs/peer-coms.md` and the extension catalog entry.
- Removed active peer-comms guidance from review-board, review-loop, security-audit, and spawn-detached-agent skills.
- Removed peer-comms-specific examples from retained tests and changelog text while preserving the general extension behavior coverage.
- Removed the global peer-comms extension symlinks under `~/.omp/agent/extensions/`.
- Removed stale runtime registry state under `~/.omp/agent/peer-coms/`.
- Preserved historical `.teams/` records. They describe earlier fork state and are not executable configuration or active skill content.

## Verification
- Active-source grep across `.omp`, `docs`, `packages`, and `scripts` found no `peer-coms`, peer tool, `peer-collab`, or `agent-collaboration` references.
- `bun test packages/coding-agent/test/extensibility/legacy-pi-inplace-load.test.ts packages/coding-agent/test/tools/report-tool-issue.test.ts` passed: 32 tests, 0 failures, 114 assertions.
- `bunx biome check` passed for all modified retained files.
- `~/.omp/agent/extensions/` is empty after removing the peer-comms links.
- The global skills directory no longer contains the two removed skill directories.

## Handoff
The working tree also contains unrelated Zoho and report-tool-issue changes. Do not discard them. Peer-comms deletion files were already unstaged when this session began; this session completed the removal around them.

## Suggested commit message

remove(peer-comms): delete global extension and collaboration skills

Remove the peer-comms extension, tests, documentation, global extension wiring, runtime registry state, peer-collab and agent-collaboration skills, and active references in project skills and examples. Keep generic extension asset-loading and dynamic tool-report coverage without peer-specific fixtures. Preserve historical team records and unrelated in-progress Zoho and auto-QA work.

Verification:
- 32 focused tests passed with 114 assertions
- Biome passed on all modified retained files
- active-source peer-comms reference scan returned no matches
