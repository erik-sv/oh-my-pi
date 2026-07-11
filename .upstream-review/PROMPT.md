You are a senior engineer doing an UNATTENDED, READ-ONLY upstream review. No human is watching; do not ask questions — record any uncertainty in an "Open Questions" section. You are starting fresh; everything you need is in the brief.

FIRST ACTION: read /home/developer/src/oh-my-pi/.upstream-review/REVIEW_BRIEF.md IN FULL with the read tool. It is the authoritative spec: it explains the task, the fork-vs-upstream divergence (our fork erik-sv/oh-my-pi `main` is 280 behind / 7 ahead of `canonical/main`, both already fetched), our 7 local commits that MUST be preserved, the pre-staged input files, and the exact shape of the report you must produce.

YOUR TASK: analyze the ~280 upstream commits our fork is missing and produce a concrete, prioritized recommendation report on what to pull in and HOW to take it safely given our local divergence. Write the report to:
  /home/developer/src/oh-my-pi/.upstream-review/RECOMMENDATIONS.md

This is ANALYSIS + REPORT only. Work in /home/developer/src/oh-my-pi. Use git (read-only: log, show, diff, ls-tree), read, search, find. Ground every claim in an actual `git show`/`git log -p`/file read — never speculate about a commit's contents.

HARD RULES:
- READ-ONLY. Do NOT edit any source file. Do NOT run git rebase / merge / cherry-pick / commit / push / checkout / reset. The ONLY files you may write are RECOMMENDATIONS.md and optional scratch notes under .upstream-review/.
- Preserve-awareness: never recommend an approach that silently drops our 7 local commits (SQL chunk storage, Anthropic thinking-block fixes, peer-coms). Explicitly handle the one that's already upstream (the extension-flag backport, merged as PR #1503) and the thinking-block fixes that may overlap upstream's own thinking/resume work — determine whether upstream supersedes ours.
- Be specific: cite commit hashes; cluster by theme; give concrete git commands for the recommended integration strategy.
- Evaluate the new upstream package `packages/mnemopi` as a candidate addition.
- You are unattended: do not stop to ask; finish the full report.

DELIVERABLE CONTENT (see brief for the full spec): Executive summary + chosen integration strategy with sequencing & commands + a high-value-pulls table (cluster | hashes | benefit | risk | P0/P1/P2) + a conflict map against our 7 commits + a do-NOT-pull list + a verification plan (bun test paths + AgentDesk rpc/SQL-chunk smoke check) + open questions.

When the report is complete and every section of the brief's "Deliverable" is covered, append a 3-5 line final summary at the bottom of RECOMMENDATIONS.md and stop. Work continuously until then.
