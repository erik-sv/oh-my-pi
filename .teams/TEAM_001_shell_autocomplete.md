# TEAM_001 shell autocomplete

Status: complete.

Implemented Tab completion for `omp shell` when no agent is running.

Changes:
- Added a readline completer to `packages/coding-agent/src/cli/shell-cli.ts`.
- Completes `.help` and `.exit`.
- Completes `cd` and `pushd` directory arguments from the shell session cwd.
- Keeps completion cwd in sync after commands by reading `pwd` from the persistent shell session.
- Escapes spaces for unquoted directory completions.
- Added focused tests in `packages/coding-agent/test/shell-cli.test.ts`.
- Updated `packages/coding-agent/CHANGELOG.md`.

Verification:
- `bun test packages/coding-agent/test/shell-cli.test.ts`: pass, 6 tests.
- `bun test packages/coding-agent/test/shell-cli.test.ts packages/coding-agent/test/prompt-action-autocomplete.test.ts packages/tui/test/editor-autocomplete-actions.test.ts packages/tui/test/autocomplete.test.ts`: pass, 38 tests.
- `bunx biome check packages/coding-agent/src/cli/shell-cli.ts packages/coding-agent/test/shell-cli.test.ts packages/coding-agent/CHANGELOG.md && bun --cwd=packages/coding-agent run check:types`: pass.
- `bun --cwd=packages/coding-agent run check`: failed on pre-existing unrelated formatting/import issues in `src/cli/args.ts`, `src/main.ts`, and `src/session/session-manager.ts`; changed files passed targeted check.

Commit message suggestion:

```
Add tab completion to omp shell

Add a readline completer for the standalone `omp shell` console so users can press Tab without entering an agent turn. The completer handles console commands and deterministic directory completion for `cd` and `pushd`.

Completion now reads from the shell session's current working directory, not the launch directory. After each non-cancelled command, the shell console probes `pwd` from the persistent brush session and updates the completer base path. Directory candidates are filtered to directories only, symlink directories are followed, and unquoted paths with spaces are escaped.

Add focused tests for directory completion, file exclusion, space escaping, special console commands, dynamic cwd updates, and `pwd` output parsing. Update the coding-agent changelog.
```
