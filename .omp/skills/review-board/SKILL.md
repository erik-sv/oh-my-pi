---
name: review-board
description: Convene a multi-model review board for high-risk code, architecture, product, security, or delivery decisions. Use when the user asks for a global review, review board, second opinions, GPT-5.5/Opus review, pre-merge validation, risk review, or wants independent critique before shipping.
argument-hint: "[task, diff, PR, plan, or decision to review]"
allowed-tools: Read, Search, Task, Bash
---

# Review Board

Run an independent review board before accepting load-bearing work. Prefer native OMP peers when available so the review is visible in AgentDesk session activity; otherwise delegate read-only reviewer tasks and clearly state what was actually used.

## Process

1. Define the review target from `$ARGUMENTS`.
   - Identify the exact files, diff, PR, plan, or decision under review.
   - State the acceptance criteria and risk areas before asking reviewers.
   - If the target is code, inspect the relevant files or diff first; do not send reviewers a vague assignment.

2. Convene three independent reviewers.
   - **GPT-5.5 Reviewer**: adversarial correctness, hidden failure modes, test adequacy, and operational risk.
   - **Opus 4.7 Reviewer**: architecture, long-term maintainability, API boundaries, and product/user impact.
   - **Opus 4.6 Reviewer**: implementation detail, security, data integrity, and edge cases.
   - Use read-only delegated reviewer tasks with roles and model hints matching the board. Do not claim those delegates ran on a specific model unless the tool output proves it.

3. Keep reviewers independent.
   - Give each reviewer the same factual packet: target, constraints, acceptance criteria, changed files, and relevant observed test results.
   - Do not include another reviewer’s findings in the initial prompt.
   - Instruct reviewers to return only evidence-backed findings with severity, file/line when applicable, and a concrete fix.

4. Adjudicate findings.
   - Treat any plausible P0/P1 finding as real until disproven by code inspection, tests, or source documentation.
   - De-duplicate overlapping findings, preserve dissent, and reject findings only with evidence.
   - Fix confirmed issues before final approval when the user asked for delivery, not just review.

5. Verify after fixes.
   - Run the smallest tests that cover the changed behavior.
   - For UI changes, capture or inspect the UI state when possible.
   - Do not restart services unless the user explicitly permits it.

## Output format

```markdown
## Review Board Result
Decision: Approved | Changes required | Blocked

| Reviewer | Focus | Verdict | Key findings |
|---|---|---|---|
| GPT-5.5 Reviewer | Correctness/risk | ... | ... |
| Opus 4.7 Reviewer | Architecture/product | ... | ... |
| Opus 4.6 Reviewer | Implementation/security | ... | ... |

## Required fixes
- [ ] Severity — finding, evidence, fix

## Verification
- Command or UI check observed: result

## Notes
- Model/peer substitutions, if any.
- Dissenting opinions worth preserving.
```

## Constraints

- Reviewers are read-only unless the user explicitly asks the board to implement fixes; this prevents competing edits and race conditions.
- Do not use a board as a substitute for tests. Review finds risks; tests prove behavior.
- Do not fabricate model participation. If a model or peer mechanism is unavailable, say exactly what was used instead.
- Do not rubber-stamp. A clean result must mention what was inspected and why the board found no blocking issues.
- Do not broaden the task beyond the review target. Recommend follow-up work separately from required fixes.
