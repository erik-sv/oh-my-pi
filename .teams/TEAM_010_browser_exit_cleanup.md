# TEAM_010 - Browser exit cleanup

## Status
Complete.

## Scope
Ensure OMP disposes browser-tool resources on interactive signals, RPC shutdown, and process-level cleanup. Prevent tool-owned headless Chrome processes from surviving graceful OMP termination.

## Baseline
- `bun test packages/coding-agent/test/tools/browser-lifecycle-leak.test.ts packages/coding-agent/test/tools/browser-launch.test.ts` - 8 passed.

## Verification
- `bun test test/tools/browser-lifecycle-leak.test.ts test/rpc-input-frame.test.ts` in `packages/coding-agent` - 19 passed, 85 assertions.
- `bun run check` in `packages/coding-agent` - Biome, docs index, and TypeScript checks passed.
- Live signal smoke - production registry launched Chrome PID 38634; SIGTERM exited OMP with 143 and Chrome was no longer alive after 750 ms.

## Handoff
OMP now runs an idempotent postmortem browser sweep and disposes RPC sessions before exit. AgentDesk reaper hardening is complete under TEAM_052 in `/Users/eriks/code/agentdesk-mac-local`.

## Commit message suggestion
fix(browser): reap tool-owned Chrome on OMP shutdown

Register an idempotent postmortem sweep that releases supervised tabs before disposing bare browser handles. Close headless and tool-spawned browser processes while preserving disconnect-only semantics for connected external browsers.

Route RPC EOF and explicit shutdown through memoized `AgentSession.dispose()` before process exit. Align the RPC runner return contract with graceful completion and add lifecycle regressions for bare handles, external ownership, and disposal ordering.
