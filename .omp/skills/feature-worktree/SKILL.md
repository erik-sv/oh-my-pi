---
name: feature-worktree
description: Isolated per-feature git-worktree workflow for concurrent feature development in the encypherai-commercial monorepo. Use when starting a new feature, working on several features in parallel, landing a feature to main, tearing one down, or when the user mentions worktrees, "new feature", "concurrent/parallel features", "land/ship this feature", multiple agents on one repo, or avoiding shared-checkout collisions. Wraps scripts/worktree/{new,land,teardown,list}-feature.sh.
allowed-tools: Bash, Read, Write, Edit
---

# Feature worktree workflow

Each feature gets its **own git worktree on its own branch**, sharing the one
`.git` object store. This is the standard way to run multiple concurrent agents
in this monorepo without their changes intermingling in one shared checkout.

**Never** start a feature by editing the shared/main checkout. **Always** provision
a worktree first.

## When to use
- Beginning ANY non-trivial feature, or any work that will run alongside other
  agents' work in this repo.
- Landing a completed feature to `main`, or cleaning up after a merge.

## Commands (in `scripts/worktree/`)

```bash
# Start: branch off fresh main + per-service DBs + .env.local + registry entry
scripts/worktree/new-feature.sh <slug> \
    [--services auth-service,key-service] \   # DB-bearing services this feature touches
    [--paths services/billing-service] \      # owned paths (advisory lease)
    [--migrate]                               # run alembic upgrade head on the new DBs

# then:
cd ../encypherai-commercial-worktrees/<slug>
source .env.local        # per-feature DATABASE_URLs + shared caches

# Land: gates (single alembic head, scoped lint/test) + push + PR. CI is the merge gate.
scripts/worktree/land-feature.sh <slug>

# Teardown after the PR merges: drop DBs + remove worktree + branch + registry entry
scripts/worktree/teardown-feature.sh <slug>

# Status of everything in flight
scripts/worktree/list-features.sh
```

## Rules
- **One worktree = one branch = one coherent feature = one PR.** Branch from fresh
  `main`, keep it short-lived, merge as soon as CI is green. No long-lived branches
  accumulating unrelated workstreams.
- A branch is checked out in only one worktree — to resume, `cd` back into the
  existing worktree (do not re-add).
- DB work needs the shared substrate up:
  `docker compose -f docker-compose.microservices.yml up -d`. Each feature uses its
  OWN database per service on the shared servers — never share a feature's DB.
- Before landing: a single `alembic head` per touched service (`uv run alembic merge`
  to relink divergent heads).
- Never hand-edit vendored mirrors (e.g. `c2pa-text/`) inside a feature branch.
- The registry (`.worktrees/registry.json`) and `.env.local` are gitignored,
  machine-local state.

Full reference: `scripts/worktree/README.md`.
