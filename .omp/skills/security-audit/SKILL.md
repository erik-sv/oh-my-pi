---
name: security-audit
description: Runs an OMP-native, multi-phase security audit of a codebase. Use when the user asks to find vulnerabilities, do a security review, audit security posture, pen-test code, check auth/tenant isolation, or produce verified machine-readable findings. Focuses on exploitable issues with concrete impact, adversarial validation, and structured reports.
argument-hint: "[target path] [optional output directory]"
---

# Security Audit

Run a structured, OMP-native security audit. Find exploitable vulnerabilities with real impact, validate them adversarially, and produce human-readable and machine-readable artifacts.

Adapted from Cloudflare's `security-audit-skill` under MIT license, with OMP delegation, Encypher/AgentDesk threat-model hooks, and no shell assumptions.

## Inputs

The user may provide:

- Target path: repository, subdirectory, service, package, or file set.
- Output directory: where audit artifacts should be written.
- Scope: broad audit, targeted auth audit, tenant-isolation audit, dependency/security posture review, or fix mode.

If target is missing, use the current working directory. If output directory is missing, create the next unused path under `~/security-audits/<repo-name>/run-<N>`. Use OMP file tools to inspect paths. Do not use shell commands to list, read, search, or page files.

## Output artifacts

Write all audit artifacts to the output directory:

- `architecture.md`: Phase 1 architecture, trust model, input surfaces, and prior-run summary.
- `REPORT.md`: concise human report with executive summary, baseline, findings, hardening notes, and positive patterns.
- `FINDINGS-DETAIL.md`: detailed traces for MEDIUM and higher confirmed findings.
- `findings.json`: array of confirmed and rejected findings matching `report-schema.json`.
- `rejected-findings.md`: optional notes for killed false positives when useful.

Use `${CLAUDE_SKILL_DIR}/report-schema.json` and `${CLAUDE_SKILL_DIR}/validate-findings.cjs` for structured output validation when the runtime exposes `CLAUDE_SKILL_DIR`. If not, use the files beside this `SKILL.md`.

## Core rules

1. Report only exploitable issues. Every confirmed finding needs a concrete attacker, exact action sequence, observable result, and meaningful impact.
2. Defense-in-depth gaps are hardening notes unless the attack works despite existing controls.
3. Severity is likelihood plus impact. A missing control is not severity. A defeated explicit security boundary is usually HIGH.
4. Validate with a different agent than the one that found the issue. The validation agent tries to kill the finding.
5. Independently verify every final confirmed finding against file paths and line numbers.
6. Keep audit and remediation separate unless the user explicitly asks for fixes. Audit agents do not edit target code.
7. Use native OMP delegation through `task`, `explore`, and `reviewer`. Never use legacy AgentDesk `/subagent` routes.
8. Subagent assignments must say: no edits, no writes to target code, no formatters, no project-wide build/test/lint gates. They may read, search, and return evidence.
9. Do not use shell for file reads, directory listings, content search, or line ranges. Use OMP `read`, `find`, `search`, `lsp`, and AST tools.
10. Do not pad reports with checklist findings. A short report with three real bugs beats a long report with thirty theories.

## Phase 0: Scope and prior runs

1. Establish target and output directory.
2. Check for prior runs under `~/security-audits/<repo-name>/` and read their `findings.json` files if present.
3. Summarize prior confirmed and rejected findings in `architecture.md`.
4. Use prior runs to avoid rediscovery and target gaps. Multiple runs should be additive.
5. Read project instructions that are already in context. If a target repository has explicit local instructions and the current harness has not injected them, inspect the target's own top-level guidance files only when needed to avoid violating repository rules.

## Phase 1: Reconnaissance

Launch a single batched `task` call with parallel read-only agents. Use `explore` agents where read-only mapping is enough. For each assignment, include exact target path, no-edit constraints, and required output.

### Recon agent A: overview and baseline

Ask it to return:

- What kind of software this is.
- Primary users and actors.
- Languages, frameworks, database, runtime, deployment model.
- Comparable mainstream systems and relevant security baselines.
- High-level directories and key entry points.
- Files that define startup, routing, storage, config, auth, and external integrations.

### Recon agent B: trust boundaries and access control

Ask it to return:

- Where untrusted input enters: HTTP, CLI, files, IPC, webhooks, queues, environment, config, MCP/tools, plugins.
- Authentication model.
- Authorization model.
- Tenant/company/resource boundaries.
- Privilege separation, child processes, sandboxing, filesystem boundaries.
- Bypass mechanisms: dev flags, test helpers, setup modes, debug endpoints.
- File paths and line numbers for enforcement points.

### Recon agent C: input and sink inventory

Ask it to return:

- Network endpoints with methods and purpose.
- File upload, import, export, archive, and config parsing surfaces.
- User-generated content surfaces that are later rendered, served, signed, indexed, or processed.
- External integrations, webhooks, OAuth, dynamic code execution, plugins, host tools.
- Dangerous sinks: SQL/raw query, HTML/template output, redirects, path operations, shell/process execution, deserialization, eval/dynamic import, crypto verification, key management, outbound HTTP.

Synthesize results into `architecture.md`. Include file paths. This document is injected verbatim into Phase 2 prompts.

If Phase 1 reveals a complex subsystem, launch additional read-only recon agents before hunting. Examples: plugin framework, multi-tenant auth, signing pipeline, payment flow, CDN edge worker, queue/worker system, MCP/host-tool bridge.

## Phase 2: Hunt

Launch multiple parallel `task` or `reviewer` agents in one batched call. Use narrow roles. Split by attack class and subsystem when the codebase is large.

Every hunting assignment must include:

- `architecture.md` content or path.
- Specific attack class and scope.
- Starting file paths from Phase 1.
- No-edit/no-write/no-gate constraints.
- The hunting method and validation rules below.
- Acceptance: confirmed exploitable findings only, or `No exploitable vulnerabilities found` with key paths checked.

### Attack classes

Use relevant classes. Add application-specific classes from Phase 1.

1. Injection: trace untrusted input to SQL, HTML, template, redirect, file path, shell/process, deserialization, log, search index, analytics, dynamic import, eval, or secondary system.
2. Access control: verify each state change checks the right permission for the right actor and resource. Check alternate paths, bulk paths, exports, imports, and body fields that override security decisions.
3. Tenant and resource isolation: check company/workspace/project/session boundaries, IDORs, joins missing tenant predicates, cache keys, SSE channels, queue payloads, storage prefixes, and background jobs.
4. Resource and file handling: path traversal, symlink/TOCTOU, archive extraction, temp files, SSRF, URL parser differentials, object storage keys, signed URLs.
5. Cryptography and secrets: weak randomness, token scope, hardcoded secrets, key leakage, signature validation, timestamp/nonce handling, revocation, timing comparison, failure fallback.
6. Business logic: state-machine violations, replay, skip steps, partial failure, race conditions, numeric manipulation, time-window boundaries, setup/migration gaps.
7. Feature abuse and data leakage: exports, search/filter/sort oracles, preview/draft leakage, notifications/webhooks as SSRF, enumeration through error/status/size/timing differences.
8. Chained attacks: combine safe-looking behaviors across components. Include host tools, agent runtime, OAuth, webhooks, background workers, caches, and admin approvals.
9. Wildcard: ignore categories and break the system. Read boring or strange code. Follow comments that claim a path is safe.
10. Obvious things: secrets, TODO security comments, debug routes, dev modes, default credentials, CORS, cookies, dependency lockfiles, direct shell execution, stack traces, `.env` leaks.

### Hunting method

Tell each hunter:

- Read the code at depth. Follow data from entry point through validation, transformation, storage, retrieval, and sink.
- Attack sad paths: catch blocks, fallback branches, default cases, timeout paths, cleanup routines, retry logic, partial failures.
- Test boundaries: missing/null/undefined, empty, max length, Unicode, zero, negative, first/last item, one past max, exact expiry/rate-limit moment.
- Check component assumptions: API assumes DB validates, renderer assumes stored data is safe, route assumes middleware ran, worker assumes producer checked permissions.
- Try wrong order: callback before request, confirmation before start, delete during create, replay completed flow.
- Look for concurrency gaps: check-then-act, read-then-write, delete while iterating, two users claiming same resource.
- Find parser disagreements: router vs URL parser, MIME vs extension vs magic bytes, schema vs DB, markdown/HTML/sanitizer mismatch, JSON/string coercion.
- Follow round trips: stored then rendered, encoded then decoded, escaped then unescaped, serialized then parsed.
- Check config overrides: user or environment value disables a security default, feature flag skips validation, setup mode weakens auth.
- Treat self-declared identity, capability, provenance, metadata, or model/tool output as untrusted unless independently verified.

### Hunter validation rules

Before reporting any finding, each hunter must answer:

1. Exact attacker starting point.
2. Exact input, request, command, file, or action sequence.
3. Exact observable result.
4. Exact impact.
5. Existing mitigation layers checked and why they do not block exploitation.
6. Parser/runtime behavior verified if the exploit depends on it.
7. File paths and line numbers for trace steps.

## Phase 3: Adversarial validation

Consolidate duplicate hunter findings first. Merge by root cause.

For each remaining candidate finding, launch a separate validation agent. Batch independent findings in one `task` call. Use `reviewer` or `task`, not the original hunter.

Prompt each validator:

- Your job is to DISPROVE this finding.
- Read the exact code paths.
- Verify every trace step.
- Apply exploitation, impact, baseline, mitigation, and parser/runtime tests.
- Return exactly one verdict:
  - `CONFIRMED: ...` with evidence and exact exploit path.
  - `REJECTED: ...` with the claim that failed and evidence.
  - `NEEDS CORRECTION: ...` with precise fields to change.

Kill false positives aggressively. Do not kill real findings because the fix is awkward.

## Phase 4: Report

Write `REPORT.md`:

- Executive summary, one paragraph.
- Baseline comparable and posture.
- Findings table: severity, title, one-line impact.
- Each confirmed finding: file path, concrete attack scenario, impact, recommended fix.
- Hardening notes: defense-in-depth gaps that are not findings.
- Positive patterns: controls that worked.
- Prior-run coverage note if applicable.

Write `FINDINGS-DETAIL.md` for MEDIUM and higher confirmed findings:

- Input to sink trace with file:line references.
- Exact request/action sequence.
- What the attacker gets.
- Conditions and prerequisites.
- How the baseline comparable handles the same scenario when known.
- Fix strategy.

Keep both reports short. Remove padding.

## Phase 5: Structured output

Write `findings.json` as an array. Every item must match `report-schema.json` exactly. Include both confirmed findings and important rejected candidates when rejection history prevents rediscovery.

Rules:

- Use relative file paths from repository root.
- Include real line numbers verified against source.
- A confirmed trace has at least two steps, starts with `entrypoint`, ends with `sink`.
- Do not add fields outside the schema.
- If you cannot populate a confirmed finding with real trace and execution fields, reject it or re-verify it.

Run:

`node <skill-dir>/validate-findings.cjs <output-dir>/findings.json`

This command is allowed because it computes schema validity. Fix structural failures before Phase 6.

## Phase 6: Independent verification

Launch one fresh verification agent per confirmed finding, all in parallel. Give each agent exactly one `findings.json` object and the target path.

Prompt:

- You did not write this finding.
- Verify every factual claim against source.
- Check every trace file, line, scope, and description.
- Verify endpoint/method/input/auth conditions.
- Verify root cause.
- Verify remediation strategy would block the exploit without breaking intended behavior.
- Return exactly one verdict:
  - `VERIFIED`
  - `CORRECTED: <field>: <wrong> -> <right>`
  - `REJECTED: <reason>`

Apply corrections. Re-run schema validation. Reconcile `REPORT.md`, `FINDINGS-DETAIL.md`, and `findings.json` so they do not disagree.

## Phase 7: Remediation handoff or fix mode

If the user asked only for an audit, stop after verified artifacts and summarize paths.

If the user asked to fix findings:

1. Convert each confirmed finding into a minimal failing test before changing code.
2. Fix root cause, not symptoms.
3. Remove obsolete bypasses and dead code. Do not add compatibility shims unless the user explicitly requires them.
4. Run the smallest relevant tests that cover the change, then the relevant package gate if needed.
5. Update the audit artifacts with final fixed status only after tests pass.

Do not let the audit agents edit code. The lead agent owns remediation and verification.

## AgentDesk overlay

When the target is AgentDesk, add these checks:

- Route handlers require auth unless explicitly public.
- SQL uses prepared queries via `lib/db.js`; no direct concatenation.
- Company, session, run, project, and worktree IDs remain tenant-scoped across routes, SSE, queues, and background jobs.
- SSE broadcasts use `broadcastEvent()` and do not leak cross-company payloads.
- Zoho writes go only through `zohoOutbox.enqueue()`.
- GitHub writes go only through `githubOutbox.enqueue()`.
- Dev candidates are filed only through `devPipeline.fileCandidate()`.
- OMP is the sole spawn runtime; no legacy direct spawn paths are reintroduced.
- User-initiated sessions are never queued by background automation budgets.
- Host tools validate arguments, company scope, authorization, and side-effect approval boundaries.
- Migrations are inert/backward-compatible until operator restart.

## Encypher commercial overlay

When the target is `encypherai-commercial`, add these checks:

- C2PA, CA, TSA, signing, certificate, trust-list, and revocation paths never trust self-declared identity or metadata.
- Private keys, API tokens, TSA credentials, and signing material never appear in logs, client responses, fixtures, downloadable artifacts, or error messages.
- Asset ownership, organization membership, tenant/workspace/project boundaries, and customer data isolation hold across UI, API, background workers, object storage, CDN integrations, and exports.
- Provenance claims distinguish document-level C2PA guarantees from Encypher segment-level technology. Do not let marketing/product text imply C2PA provides sentence-level provenance.
- Webhooks, callbacks, fetchers, CDN worker config, and remote manifests are checked for SSRF, redirect, DNS, and object-key boundary issues.
- Watermark/fingerprinting code is audited against its stated threat model. Removability is not a vulnerability if the product honestly claims deterrence rather than impossible persistence.
- Enterprise POC flows are checked for demo-mode bypasses, seeded credentials, fixture leakage, permissive CORS, public debug endpoints, and first-run/setup weaknesses.

## Final response

Return:

- Output directory absolute path.
- Counts: confirmed, rejected, hardening notes.
- Highest severity and one-line rationale.
- Files created.
- Verification performed, including schema validator result and Phase 6 status.
- If blocked, exact missing prerequisite and what was already completed.
