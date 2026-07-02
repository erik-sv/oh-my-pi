---
name: draft-provisional-patent
description: Draft, scaffold, and review provisional patent applications with the rigor of senior tech-portfolio patent counsel, using the master-class methodology reverse-engineered from the ENC-0100 filing. Covers spec architecture (module inventory, lexicography taxonomy, boilerplate, claim-mirroring), claim strategy (family layout, actor analysis, encoder/decoder mirrors, dependent archetypes), and a pre-filing QC gate. Use when the user mentions provisional patents, patent drafting, claims or claim strategy, spec sections, lexicography/definitions blocks, "prepare for counsel", "patent scaffold", coverage analysis against a filed provisional, or reviewing a patent draft before filing.
argument-hint: "[scope|draft|review] [invention description or draft file path]"
allowed-tools: Read, Write, Edit, Glob, Grep, Agent
---

# Draft Provisional Patent

Apply the house provisional-drafting methodology — derived from the as-filed ENC-0100 provisional (senior counsel, 30+ years of big-tech portfolios) — to scope, draft, or review provisional patent applications.

**Authoritative reference (read it first):**
`docs/company_internal_strategy/Provisional_Patent_Drafting_Playbook.md` in the encypherai-commercial repo. If working outside that repo or the file is missing, operate from the digest below, but say so.

**Standing constraints (apply to every mode):**
- Everything produced is *strategic IP work product for counsel review* — never legal advice, never a filing. Say so in the document header and the reply.
- Until a provisional covering a mechanism is filed, treat the mechanism as disclosure-sensitive: flag any draft text, demo, or exemplar that could constitute public disclosure (absolute-novelty jurisdictions have no grace period).
- Never write "the present invention is/provides/comprises". Use "the present disclosure". No SUMMARY section.

## Process

### 0. Determine mode from $ARGUMENTS
- **scope** — inventor has mechanisms, no document: produce a module inventory + claim-family scaffold.
- **draft** — scaffold exists or sections requested: write spec sections and claims.
- **review** — a draft exists: run the QC gate and report findings.
If ambiguous, infer from what exists on disk; ask only if genuinely undecidable.

### 1. Scope mode — module inventory first
1. Identify every separable mechanism (anything that could stand as its own patent). Interview the codebase/architecture docs, not just the prompt.
2. Build the **figure list = invention inventory**: one figure per module, table of `FIG | module | source of record (file/doc)`. Get explicit inventor sign-off on this list before any prose.
3. Apply the **Four-Artifact Rule** — every module gets: figure → description block → definitions (as needed) → claim family. A module missing any artifact is a defect.
4. Map each module to an **actor** in the value chain (who performs it alone?). Plan encoder/decoder mirror families for every protocol-shaped module.
5. Lay out claim families with **reserved claim-number gaps** between them.
6. Output a scaffold document (see Output format) into the matter's drafts directory.

### 2. Draft mode — section rules (digest of playbook Parts 2–4)
- **Title:** `<DISTINCTIVE CONCEPT> AND RELATED METHODS AND SYSTEMS FOR <F1>, <F2>, AND/OR <F3>`. No product names, standards, or implementation tech.
- **Technical Field:** one sentence, funnel: broad field → "in particular" hooks. Every hook ↔ one independent-claim family (audit bidirectionally).
- **Background:** ≤4 ¶¶. ¶1 naive approach (category-level, no citations). ¶2 incumbent standard, purely descriptive, time-scoped verbs ("proposed"). ¶3 every problem as "the present inventor has recognized…"; ≥1 phrased as a *technical problem* with technical constraints (§101/EPO); benefits hedged ("may allow for…, among other potential benefits"). Banned words: well known, conventional, standard practice, always, must.
- **Cross-reference / priority:** a provisional CANNOT claim priority or domestic benefit to an earlier application, and IBR is not honored in many foreign jurisdictions — make each provisional self-contained (restate relied-upon parent concepts inline, in the parent's terminology); claim benefit of multiple provisionals later in the non-provisional/PCT filed within 12 months of the earliest. Never write "claims the benefit of" in a provisional. (Playbook Part 9.1.)
- **Lexicography (refined, Playbook Part 9.2–9.4):** REUSE the parent provisional's coined lexicon verbatim — never coin a competing term for a concept the parent already named (it narrows and may collide with a parent species term). Express-define ONLY when no generic term exists AND the definition expands scope (the "attestance" test). NEVER expressly define art-standard terms (e.g., "generative model," "apportionment") or terms clear from context (e.g., "origination record"). Do not avoid art-standard terms ("artificial intelligence," "AI model") for their own sake. Trim definitions to scope-expanding coinages only.
- **Conciseness & figures (Playbook Part 9.5–9.7):** a defensive provisional may over-disclose, but a claim-bearing instrument must be concise — cut benefits not tied to a described mechanism, cut variation-sweep fluff, cut linear-flowchart figures that are not claim-central, do not give embodiment-length exposition to old/unpatentable techniques (KSR), and describe mechanisms within the integrated system context rather than as free-floating "separate embodiments."
- **Lexicography block** (applies to the scope-expanding coinages retained per the refinement above — NOT a license to define art-standard terms): "The following terms shall have the meanings given:" — coin an umbrella term (never a field word); build a genus-species taxonomy ≥2 levels; definition verbs as breadth knobs ("shall be understood as relating to any one or more of" → "means X; an X may be A or B" → "means a Y comprising …"); every definition in claim grammar (liftable into a claim verbatim); incumbent standard tied to a species, never the genus; negatives only to split sibling species. Inline-broaden ordinary words mid-narrative with "unless the context indicates otherwise".
- **Module walk**, per module in figure order: "Turning now to FIG. N…"; inventor-insight sentence only at load-bearing modules; canonical embodiment with figure-century reference numerals (FIG. 4 → 410–470); variation sweeps for every parameter incl. one non-obvious alternate; nested numeric ranges ("about") + one concrete value; mechanism-backed benefit sentences (because→therefore), external-world facts time-scoped ("currently"); tradeoff candor + cure; **claim-mirroring paragraph** for every independent claim.
- **Language system:** default modal is "may"; "should" only for true technical constraints; zero "must/critical/essential/key". "e.g." exemplifies freely; every "i.e." is a deliberate scope decision (use to equate coined ↔ art terms). Fix canonical compound phrases once, never vary. Terms of degree always anchored to a comparator.
- **Closing boilerplate:** "…scope of the invention should, therefore, be determined only by the claims."

### 3. Draft mode — claim rules (digest of playbook Part 5)
- File claims even though optional: priority armor (EPO "directly and unambiguously"), forces the claim plan at month 0, free EPO-style multiple dependencies ("any one of the preceding claims") — flattened later at US conversion.
- **One family per module; family per actor.** Single-actor discipline (no signer+verifier steps in one claim — divided infringement). Encoder/decoder mirrors. Prefer claims whose infringement is observable from public artifacts; flag back-end-only claims as defensive.
- **Independent anatomy:** "A computer-implemented method of [intended use], the method comprising the steps of:" + gerund steps; minimum-element (novelty only — everything shippable goes in dependents); undefined criteria as breadth devices ("according to a segmentation criterion"); antecedent chains ("a X" → "the X"); order-neutral listing with both orders disclosed in spec; algorithmic logic as indented sub-steps with upon/when/repeating-until; `whereby/thereby` result clauses as garnish never the meat; hard performance bounds as `wherein` limitations with variables defined in-claim.
- **System claim:** processor + memory storing instructions that, when executed, cause… (§112(f)-safe). Zero "means for"/"step for". **Data-structure claim:** components + functional-capability `wherein` clauses (§101 mitigation). **Wrapper claims:** "performing the method of any one of the preceding claims" lifted into corpus/pipeline scope.
- **Dependents** are fallbacks AND claim-differentiation tools (a dependent adding L implies the parent lacks L — write one for every limitation an adversary might import). Archetypes per family: data-content; hardening (repeat on every applicable branch); location/architecture (claim both directions); encoding-specifics with exact ranges/identifiers; parameterization; Markush closed groups ("selected from the group consisting of… and combinations thereof"); open lists ("at least one of…", bury crown-jewel species here); standards-conformance one level down only; chained micro-dependents one rung per step.

### 4. Review mode — QC gate
Run the full Part 7 checklist from the playbook against the draft. Rate every finding **BLOCKING / SHOULD-FIX / STYLE**. Machine-check mechanically (grep, don't skim):
1. Banned-word scan: `must|required|necessary|critical|essential|key|well.known|conventional|the present invention` — each hit justified or BLOCKING.
2. Every dependency target exists and is not reserved; family ranges start at the family's own independent.
3. Every "the X" in every claim resolves to "a/an X" through that claim's actual dependency chain (the ENC-0100 cl. 48/50 and cl. 4 defect classes).
4. Single-actor test per claim; zero "means for"/"step for".
5. Hook↔family bidirectional audit; claim-mirroring paragraph per independent; Four-Artifact audit per module.
6. Inventor singular/plural matches inventorship; every "i.e." reviewed; OCR/typo scan of claim text.

### 5. Drawings — house conventions (reverse-engineered from the ENC-0100 as-filed drawing set)
- Drawings are a **separate sibling document** (`<DOCKET>-DRW`), filed alongside the specification — never inline in the spec body. One figure per letter-size sheet; complex diagrams may be rotated landscape on the portrait sheet.
- Sheet anatomy: bold diagram title at the top; the diagram; centered **FIG. N** caption below; optional one-line *italic* descriptive subtitle under the caption; "Note:" callout boxes inside the sheet for explanatory remarks; the arrangement-level numeral (e.g., 100) floated top-right with a leader arrow.
- Boxes carry **bold component labels with the reference numeral in parentheses** — e.g., "Provenance Registry (130)". Numerals are figure-century (FIG. 4 → 410–470) and MUST match the spec text exactly — bidirectional audit: every numeral in a figure appears in that module's walk, and every figure-century numeral in the walk appears in the figure. Monospace font for literal data values; curved leader lines and braces for content mockups (the ENC-0100 FIG. 1 style).
- **Color is permitted in the informal as-filed set** (house precedent: ENC-0100 filed a non-BW drawing set) but only as redundant emphasis — every distinction MUST survive grayscale, because formal USPTO drawings at conversion are redrawn black-and-white by a draftsman.
- Figure list = module inventory (Four-Artifact Rule). Generate informal drawings programmatically from the spec's canonical-embodiment component lists so numeral consistency holds by construction; keep the generator script next to the artifact; hand the set to counsel's draftsman for formalization.

## Output format

- **Scope mode** → `<matter-dir>/drafts/<DOCKET>_<topic>_provisional_scaffold_<date>.md`: header (status/sources/urgency), module-inventory table, title/field/background drafts, lexicography tree, claim-family table with reserved gaps, candidate independents, dependent-archetype instantiation, counsel gate checklist. Model: `docs/company_internal_strategy/drafts/ENC0400_pdf_provisional_scaffold_2026-06-11.md`.
- **Draft mode** → spec sections in the skeleton order (playbook Part 6), numbered paragraphs `[0001]`, docket in header.
- **Drawings** → `<matter-dir>/drafts/<DOCKET>_Drawings_for_Attorney_Review.docx`: cover sheet (status/counsel disclaimer) + one sheet per figure per §5, generated by a script kept beside the artifact (model: `generate_enc0300_figures.py`).
- **Review mode** → findings report grouped by section, each finding: rating, location (¶/claim number), the rule violated (cite playbook part), and proposed fix text.

End every reply with the counsel disclaimer and (if relevant) outstanding disclosure-risk items.

## Constraints

- **Why counsel-gated:** provisionals create binding admissions and priority positions; an unreviewed filing is worse than none. Never present output as filable.
- **Why module-first:** prose written before the figure list produces unitary "one invention" documents that cannot be restricted, divided, or licensed per-mechanism.
- **Why no scope-shrinking:** in a provisional, disclosure is free and omission is fatal — when unsure whether to include a variation, include it.
- **Why mechanical QC:** the exemplar itself — drafted by a 30-year veteran — shipped with dependency-target and antecedent-basis defects. Humans skim; grep doesn't.
