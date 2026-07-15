# Browser Process Lifecycle

## Status
Complete.

## Current Goal
Close every browser-tool-owned Chrome process during graceful OMP shutdown, including RPC EOF and Ctrl-C.

## Overview
Browser tabs currently close when `AgentSession.dispose()` runs, but RPC shutdown bypasses disposal and registry-only browser handles can escape session ownership. Add process-level browser cleanup and route RPC shutdown through normal session disposal.

## Objectives
- Dispose all browser tabs and bare browser handles during postmortem cleanup.
- Dispose RPC sessions before process exit.
- Preserve connected or reused external browsers.
- Keep cleanup idempotent and bounded.

## Tasks
- [x] 1.0 Add failing lifecycle regressions. - red then green
  - [x] 1.1 Cover bare headless browser registry cleanup. - bun test
  - [x] 1.2 Cover RPC disposal before exit. - bun test
- [x] 2.0 Implement browser shutdown ownership.
  - [x] 2.1 Add idempotent global browser cleanup.
  - [x] 2.2 Register cleanup with postmortem.
  - [x] 2.3 Dispose RPC sessions before exit.
- [x] 3.0 Verify behavior.
  - [x] 3.1 Pass focused browser and RPC tests. - 19 tests
  - [x] 3.2 Smoke-test signal-driven browser cleanup. - SIGTERM

## Success Criteria
- Ctrl-C and SIGTERM close tool-owned Chrome process trees.
- RPC EOF and explicit shutdown dispose the active session before exit.
- Bare handles not yet attached to a tab are still closed.
- Connected external browsers are disconnected, not killed.
- Focused automated tests and an end-to-end process smoke test pass.

## Completion Notes
OMP now sweeps tabs and bare browser handles through postmortem cleanup. RPC EOF and explicit shutdown await memoized session disposal before exit. A live SIGTERM smoke launched headless Chrome through the production registry and confirmed the Chrome PID exited with OMP. Connected external browsers remain disconnect-only.
