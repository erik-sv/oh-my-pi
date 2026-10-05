# Upstream 18.6.2 AgentDesk Integration
Status: Integrated, verified, and activated for new local AgentDesk launches, the auth broker/gateway, and the interactive CLI.
Current Goal: Observe new AgentDesk sessions on 18.6.2. Move the fixed `OMP_BIN` (remote placements, employee workers) at the next planned AgentDesk restart.

## Overview
Merged upstream v18.6.2 (18.4.11–18.6.2) on top of the 18.4.10 integration (`upstream-18-4-10-agentdesk.md`). Merge commit is 4230fe0e11 on `sync/upstream-v18.6.2-agentdesk`. Every contract decision from 18.4.10 still holds. In addition:
- `ephemeral_turn` is refused while a goal continuation is scheduled.
- `ephemeral_turn` and `prompt_error` are part of the published RPC wire schema and SDKs.
- SQL listing keeps nested-glob matching.
- Blob validation and unavailable-image degradation run through upstream's per-site dedupe.
- The browser tab force-kill ownership composes with upstream's single-flight teardown.

## Verification
- `check:ts` and `cargo fmt` pass. Fork suites pass with 0 failures. SQL parity: 110 lines byte-identical.
- Full suite: every remaining failure reproduces on pristine v18.6.2, or is a load timeout that passes when rerun alone.
- Compiled artifact:
  - `--smoke-test` passes;
  - RPC v2 negotiates;
  - `get_state` right after `ready` returns 4 `omp_session_chunks` rows;
  - a pre-agent failure emits `prompt_error` and then `prompt_result{agentInvoked:false,status:error}`;
  - live Anthropic and Codex calls succeed;
  - Chromium navigation works.
- The AgentDesk dev sandbox passes checks a–h.

## Activation (2026-10-05 UTC)
- Artifact: `/home/agentdesk/code/omp-runtimes/omp-v18.6.2-agentdesk-4230fe0e11-8a2b7fa2acd4/omp`, SHA-256 `8a2b7fa2acd4badba3c97c9f197c414a3f581fb0d1762b58cbebccec40eacf5e`.
- The auth broker and gateway units run the artifact. Both units already allow writes to `~/.omp/natives`. Checks:
  - 18.2.9 and 18.6.2 clients obtain credentials from the broker;
  - a gateway chat completion returns successfully.
- The runtime selector is at generation 4 (manifest `omp-v18.6.2-agentdesk-4230fe0e11`). Running 18.2.9 children are untouched.
- `~agentdesk/.local/bin/omp` points to the artifact.
- Backups are in `/root/omp-rollout-20261005/` (unit files, selector, previous CLI symlink target).

## Rollback
1. Republish 18.2.9 with the expected generation set to 4:

   ```bash
   sudo -u agentdesk python3 /home/agentdesk/code/agentdesk/scripts/switch-omp-runtime.py \
     --root /home/agentdesk/code/omp-runtimes \
     --selector /home/agentdesk/data/omp-runtime.json \
     --artifact /home/agentdesk/code/omp-runtimes/omp-v18.2.9-rpcfix-6177510e2c-a8419e9dbcad/omp \
     --sha256 a8419e9dbcadf6d3e05289361fe8b5ef5049e3667559ce783c23f6f37d63c01e \
     --version 18.2.9 --manifest-id omp-v18.2.9-rpcfix-6177510e2c \
     --compatibility-generation 18 --capability rpc --capability sql-session-storage \
     --expected-generation 4
   ```

2. Restore the unit files from the backup directory, then run `systemctl daemon-reload` and restart both auth services.
3. Re-point the CLI symlink to the saved target.

The auth schema is 8 in both versions, so no data migration needs reversing.

## Open items
- The fixed `OMP_BIN`, `AGENTDESK_OMP_CANDIDATE_VERSION` and the manifest id in `/etc/agentdesk/agentdesk.env` are still 18.2.9. Change them together, only at a planned runtime restart.
- `provision-employee.sh` copies `~/.omp/natives/<OMP_BIN version>`. Once 18.6.2 prunes `natives/18.2.9`, provisioning needs `OMP_BIN` moved, or one 18.2.9 start to re-extract.
- AgentDesk OMP children inherit `HOME=/home/agentdesk`, so the dev sandbox needs a HOME-isolating `OMP_BIN` wrapper.
- `providers.cacheWarming` defaults to `idle`. Decide whether to disable it in AgentDesk's overlay.
