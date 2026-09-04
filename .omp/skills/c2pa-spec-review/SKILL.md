---
name: c2pa-spec-review
description: Review C2PA specification text with the rigor of a veteran standards editor. Checks normative language precision (RFC 2119), structural placement (security in Security section, validation in Validation section), CDDL schema correctness, cross-reference integrity, and alignment with existing C2PA conventions. Use when the user says "review spec", "check my C2PA changes", "spec review", "standards review", or when reviewing PR changes to specs-core.
argument-hint: "[file-path or 'all' for full diff review]"
allowed-tools: Read, Bash, Glob, Grep, Agent
---

# C2PA Specification Review

Review C2PA specification changes with the standards-body rigor of a three-decade veteran editor. This skill applies the editorial lens of someone who co-chairs C2PA, has deep familiarity with W3C/ISO/IETF conventions, and prioritizes spec consistency above author convenience.

## Process

### 1. Gather context

Read the target file(s). If `$ARGUMENTS` is "all" or empty, run `git diff` in the specs-core repo to identify all changed files. For each changed file, read both the current version and understand the surrounding section structure.

Load these reference files to establish conventions:
- `docs/modules/specs/partials/Validation/Validation.adoc` -- heading conventions, status code table structure, assertion validation patterns
- `docs/modules/specs/partials/Threats-Harms/Threats_Harms.adoc` -- heading conventions, normative language expectations (zero "shall" in threats)
- `docs/modules/specs/partials/schemas/cddl/` -- CDDL patterns, extensibility conventions (`* tstr => any`)
- At least two existing assertion definitions for structural comparison

### 2. Apply review checklist

For each file or change, evaluate against these categories. Rate each finding as BLOCKING, SHOULD-FIX, or STYLE.

#### A. Normative language (RFC 2119)

- "shall" = absolute requirement. Never use in informational/security/threat sections.
- "should" = recommended but exceptions exist. Must have clear justification for non-compliance.
- "may" = truly optional (permission). Verify it does not mask a "should."
- **"may" vs "can":** "may" is an RFC 2119 keyword granting permission. "can" describes capability or possibility. "A URI may become stale" is wrong (grants permission to become stale); "A URI can become stale" is correct (describes possibility). Flag every "may" that describes possibility rather than permission.
- **"shall" on guidance:** Generation processes, recommended workflows, and implementation patterns are guidance, not requirements. Use "it is recommended" or "should," never "shall," for patterns that claim generators may choose not to follow.
- **Conditional "should" vs "shall":** When a field is explicitly opted into (e.g., an optional field the claim generator chose to include), validation of that field is typically "shall," not "should." If the claim generator went out of their way to include it, downgrading verification to advisory undermines the purpose.
- Check for normative hedging: "it is recommended that" should be "should." "It is required" should be "shall."
- Check for accidental normative statements in NOTEs. NOTEs are informational and must not contain "shall."
- Verify consistent use: same concept uses same normative verb throughout.

#### B. Structural placement

- Validation logic belongs in the Validation section, not inline with feature description.
- Security analysis belongs in Threats/Harms section, not inline.
- The feature section defines the mechanism. Validation and security sections define how to check it.
- Guidance and best practices do not belong in normative spec text. If present, should be a NOTE or removed.
- **Assertion definitions:** New assertions should generally be defined in the Standard Assertions section, following existing precedent. If a feature section defines assertions inline (as the live-video section does), note the inconsistency and flag it for discussion. Check how existing assertions (`c2pa.actions`, `c2pa.soft-binding`, `c2pa.metadata`, `c2pa.ingredient.v3`) are structured and placed.
- **Validation integration:** New validation rules should integrate into the existing validation flow (Validation.adoc) rather than creating standalone validation subsections. Status codes go in the consolidated tables. Check whether a separate validation file can be folded into existing assertion-validation patterns.
- Check that `include::` directives are placed correctly relative to sibling includes.

#### C. Cross-references and consistency

- Every new assertion must be added to the Specific Assertion Validation list in Validation.adoc.
- Every new status code must appear in the consolidated status code tables (success/informational/failure).
- `hashed-uri` references must use `$hashed-uri-map` in CDDL (the existing type). External URLs use `$hashed-ext-uri-map`.
- `componentOf` is parent-to-child ONLY. Never describe it as child-to-parent.
- `parentOf` is the derived-from/predecessor relationship in Update Manifests. A `parentOf` ingredient references the previous active manifest being superseded. Do not describe a child asset as "having a parentOf" in a compound content context; `parentOf` describes manifest lineage, not parent-child editorial relationships.
- Update Manifests have exactly one `parentOf` ingredient and no hard bindings.
- Network access is ALWAYS OPTIONAL in C2PA validation. Any retrieval must use "may attempt."
- **Forward references:** When a concept is explained later in the document, add an xref or "as described in <<anchor>>" link. Do not leave the reader to discover the explanation by reading forward.

#### D. CDDL schema correctness

- Verify schema matches prose description exactly (fields, optionality, types).
- Check for extensibility: `* tstr => any` pattern for forward compatibility.
- Verify `.size (1..max-tstr-length)` constraint on URI/string fields.
- Check that optional fields use `?` prefix.
- Verify CBOR diagnostic examples match the schema (field names, types, structure).
- Example should demonstrate the minimal valid case unless showing optional fields.

#### E. AsciiDoc conventions

- Heading levels must match the parent document's convention.
  - Validation.adoc uses `###` (Markdown-style) headings for subsections.
  - Threats_Harms.adoc uses `====` (AsciiDoc-style) headings.
  - Compound-Content section uses `===` AsciiDoc headings.
- Check xref targets exist and use correct anchor IDs.
- Verify `include::` paths are correct relative to the including file.
- PlantUML diagram references must have correct target/format attributes.

#### F. Semantic precision

- Distinguish between "manifest" (the C2PA Manifest) and "manifest store" (the container).
- "active manifest" has a specific meaning (the current manifest in a chain).
- "claim generator" is the entity creating the manifest, not a software component.
- "validator" is the entity performing validation.
- Authentication vs. discovery: hash-verified references authenticate; URI references discover.
- Do not conflate trust (claim signature + trust list) with integrity (hash verification).
- **Signing terminology:** C2PA does not "sign assets." A claim generator creates a manifest and applies it to an asset. Never write "signed asset," "sign the child," or "sign with an assertion." Correct: "apply a manifest to the asset," "create a manifest for the asset," "the asset's manifest."
- **HTTP vs HTTPS:** "HTTP" refers to the Hypertext Transfer Protocol family (RFC 7230), which includes both `http://` and `https://` URL schemes. Use "HTTP" when referring to the protocol family. Use "HTTPS URL" only when specifically requiring TLS. When the spec says "HTTP URL," add a NOTE clarifying this refers to the protocol, not the scheme, per RFC 7230.

#### G. C2PA domain rules

These are implicit requirements that experienced C2PA editors enforce but are not written as explicit checklist items elsewhere in the spec.

- **Inception actions are required in all manifests.** Every C2PA Manifest shall contain at least one inception action in its `c2pa.actions` assertion (e.g., `c2pa.created`, `c2pa.opened`, `c2pa.placed`). If a section describes manifest contents without mentioning an inception action, flag it.
- **Manifest storage agnosticism.** C2PA supports embedded manifests, sidecar manifests, and remote manifest stores. Spec text must not assume or mandate a specific storage mechanism unless the section is format-specific guidance. Phrases like "embed the manifest in the asset" or "the manifest shall be included in the asset" force embedded storage. Use "apply a manifest to the asset" or "the asset shall have a C2PA Manifest" and reference the embedding annex for format-specific details.
- **Assertion fields must be provenance-relevant.** C2PA assertions carry provenance data, not editorial metadata that drifts from reality. Fields like display order, presentation hints, or rendering instructions do not belong in assertions. If a proposed field would become stale when the asset is reused in a different context, it is not provenance-relevant. Flag it.
- **Action selection.** Each workflow has appropriate actions. `c2pa.created` for new content, `c2pa.opened` for existing content, `c2pa.placed` for ingredient placement, `c2pa.edited` for content changes, `c2pa.edited.metadata` for metadata-only changes. Do not mandate a specific action when multiple are appropriate; use "the appropriate action for the workflow." When an Update Manifest adds only metadata (no content change), `c2pa.edited.metadata` is correct only if the change is purely metadata; verify this matches the described workflow.
- **Optional fields in diagrams.** If the prose describes an assertion or field as optional, any diagram depicting that assertion must annotate it as "(optional)." Diagrams and prose must agree on optionality.

### 3. Generate report

Produce a structured report with this format:

```
## C2PA Spec Review Report

### Summary
[1-2 sentences: overall assessment]

### BLOCKING Issues
[Issues that would cause a standards-body reviewer to reject the PR]

B1: [file:line] [Category] — [Description]
   Current: [what the text says]
   Required: [what it should say]
   Rationale: [why this matters for the spec]

### SHOULD-FIX Issues
[Issues that weaken the spec but would not block acceptance]

SF1: [file:line] [Category] — [Description]
   ...

### STYLE Notes
[Consistency and convention issues]

S1: [file:line] [Category] — [Description]
   ...

### Passed Checks
[Explicit confirmation of areas that are correct]
- [Check]: OK — [brief note]
```

## Constraints

- Never suggest adding guidance or best-practice text to normative sections. The spec defines mechanisms; it does not advise implementers on how to use them well.
- Never suggest "shall" in NOTE blocks, security sections, or threat analysis sections.
- Do not recommend changes that would conflict with existing C2PA patterns. When unsure, check how existing assertions (e.g., `c2pa.actions`, `c2pa.soft-binding`, `c2pa.metadata`) handle the same situation.
- The review persona is constructive but demanding. Flag real issues; do not manufacture problems to appear thorough.
- If the spec text is correct, say so explicitly. Silence on a topic is ambiguous; explicit "OK" is not.
