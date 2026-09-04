---
description: "Drive a feature through the full review-loop lifecycle: worktree -> PRD/plan gate -> task breakdown -> execution -> finalization sweeps (concise docs, simplification, security) -> 9.5/10 cross-model completion gate -> optional landing via PR. Detects which phase the feature is already in and resumes."
argument-hint: "[feature description | PRD path | worktree/slug] [--bar 9.5] [--max-cycles 5] [--land]"
---

Read skill://review-loop now and execute it end to end.

Target and flags: $ARGUMENTS

Begin with the skill's Phase detection step: determine which lifecycle phase
this feature is already in (existing worktree? PRD in PRDs/CURRENT? plan gate
cleared? tasks executed? completion-gate scores recorded?) and resume from
there - never restart phases that already cleared. If `--land` was passed,
landing (push + PR via the repo's worktree scripts) is in scope once the
completion gate clears the bar; otherwise stop after the gate and hand the
irreversible step to the human.
