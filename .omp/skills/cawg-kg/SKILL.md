---
name: cawg-kg
description: >
  Query the Creator Assertions Working Group specification knowledge graph from
  the live GitHub repository. Use when: implementing CAWG identity, metadata,
  training-mining, endorsement, organizational-identity-profile, or ux-guidance
  assertions; checking CAWG spec requirements; looking up assertion labels,
  named_actor structure, or identity_claims_aggregation; finding validation
  rules and status codes; comparing spec versions; or answering questions about
  CAWG conformance. TRIGGER when: user asks about CAWG, cawg.identity,
  cawg.training-mining, cawg.metadata, named_actor, identity assertion,
  signer_payload, referenced_assertions, VC/DID identity, or DIF creator
  assertions.
argument-hint: "[query or entity name, e.g. 'signer-payload-map properties' or 'diff identity 1.1 1.2']"
allowed-tools: Read, Bash, Glob, Grep, Agent, WebFetch
---

# CAWG Knowledge Graph Query

You have access to a machine-readable knowledge graph derived from the CAWG
specifications, hosted at https://github.com/encypherai/cawg-knowledge-graph.
Fetch artifacts from the live repo to answer questions with precision rather
than relying on training data.

CAWG specs live under DIF at `github.com/decentralized-identity/cawg-*`. CAWG
extends C2PA with identity, metadata enrichment, and training/mining rights
assertions. For C2PA standard questions, prefer the sibling `c2pa-kg` skill.

## Data access — live GitHub URLs

Always fetch from the live repo. Never guess answers from training data when
the knowledge graph is available.

### Step 1 — Resolve the current spec version

Fetch the evergreen pointer file:

```
https://raw.githubusercontent.com/encypherai/cawg-knowledge-graph/spec-current/spec-version.json
```

This returns the current flagship spec version (CAWG identity, ratified by
DIF) and the `families` map listing every tracked CAWG family with its current
and available versions:

```json
{
  "cawg_family": "identity",
  "spec_version": "1.2",
  "families": {
    "identity": {"current": "1.2", "available": ["1.0", "1.1", "1.2"]},
    "metadata": {"current": "1.1", "available": ["1.0", "1.1"]},
    "training-mining": {"current": "1.1", "available": ["1.0", "1.1"]},
    "endorsement": {"current": null, "draft": "1.0"},
    "organizational-identity-profile": {"current": "1.0"},
    "ux-guidance": {"current": "1.0"}
  }
}
```

If the user requests a specific family and version, use the tagged URL:

```
https://raw.githubusercontent.com/encypherai/cawg-knowledge-graph/v1.{family}.{version}/spec-version.json
```

Tag format: `v1.{family}.{version}`. Examples:
- `v1.identity.1.2` for identity 1.2
- `v1.metadata.1.1` for metadata 1.1
- `v1.training-mining.1.0` for training-mining 1.0
- `v1.endorsement.1.0-draft` for endorsement draft

### Step 2 — Fetch the right artifact

Each tracked (family, version) has five artifacts. Fetch only what the query
needs:

| Artifact | Use for |
|----------|---------|
| `metadata.json` | Entity lookups, properties, relationships, enums, type aliases, status codes, c2pa_references |
| `validation-rules.json` | Normative validation rules by phase |
| `predicates.json` | Conformance predicates and test vectors |
| `ontology.ttl` | RDF/OWL class hierarchy with `owl:seeAlso` links to C2PA entities |
| `context.jsonld` | JSON-LD term definitions |

Construct the URL:

```
https://raw.githubusercontent.com/encypherai/cawg-knowledge-graph/v1.{family}.{version}/versions/{family}/{version}/{artifact}
```

Or use `spec-current` for the flagship identity spec:

```
https://raw.githubusercontent.com/encypherai/cawg-knowledge-graph/spec-current/versions/identity/1.2/metadata.json
```

### Step 3 — Extract relevant data

For large artifacts, use Bash with Python or jq to extract only the relevant
section:

```bash
# Fetch and extract a single entity
curl -s "https://raw.githubusercontent.com/encypherai/cawg-knowledge-graph/spec-current/versions/identity/1.2/metadata.json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); e=d['entities'].get('signer-payload-map'); print(json.dumps(e, indent=2) if e else 'Not found')"

# List all identity entities
curl -s "$URL" | python3 -c "import json,sys; d=json.load(sys.stdin); print('\n'.join(sorted(d['entities'].keys())))"

# Filter validation rules by phase
curl -s "$RULES_URL" | python3 -c "
import json,sys
rules=json.load(sys.stdin)
for r in rules:
    if r.get('phase')=='signature':
        print(f\"[{r['severity']}] {r['description'][:120]}\")"

# Find c2pa_references (CAWG to C2PA linkage)
curl -s "$URL" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('c2pa_references', []), indent=2))"
```

## How to answer queries

### Assertion label lookup

When asked about a CAWG assertion label (e.g., `cawg.identity`,
`cawg.training-mining`, `cawg.ai_training`):

1. Identify the family the label belongs to (prefix after `cawg.`).
2. Fetch that family's `metadata.json` and search the `entities` and
   `status_codes` for the label.
3. Report the label's purpose, the entity shape it carries, required and
   optional fields, and the C2PA assertion it attaches to (from
   `c2pa_references`).

### Entity lookup

When asked about a CAWG entity (e.g., `signer-payload-map`, `hash-map`,
`training-mining-entries-map`):

1. Fetch `spec-version.json` to confirm family and version.
2. Fetch `metadata.json` for that family/version and extract the entity from
   the `entities` dict.
3. Report the entity's properties (name, type, required, cardinality,
   description), relationships (target entity, relationship type), enum
   constraints, and CDDL source snippet when available.

### Validation rules

When asked about CAWG validation requirements:

1. Fetch `validation-rules.json` for the relevant family/version.
2. Filter by phase if specified: `structural`, `signature`, `trust`,
   `binding`, `assertion`, `credential`, `content`.
3. Report rules with RFC 2119 severity (must/shall/should/may), description,
   and referenced entities.
4. Cross-reference with status codes from `metadata.json`.

### Status codes

When asked about CAWG status codes:

1. Fetch `metadata.json` and extract the `status_codes` section.
2. Group by family prefix (`cawg.identity.*`, `cawg.training-mining.*`).
3. Report the code, phase (success/failure), when it fires, and the normative
   text that drives it.

Representative identity codes include `cawg.identity.trusted`,
`cawg.identity.well-formed`, `cawg.identity.cbor.invalid`,
`cawg.identity.assertion.mismatch`, `cawg.identity.hard_binding_missing`,
`cawg.identity.credential_revoked`, `cawg.identity.sig_type.unknown`.

### Cross-references to C2PA

When asked how a CAWG assertion relates to C2PA:

1. Fetch `metadata.json` and inspect the `c2pa_references` block.
2. Each reference names a CAWG label, a target C2PA entity, and a
   relationship type (`extends`, `refines`, `applies-to`).
3. For deeper C2PA detail, invoke the `c2pa-kg` skill on the target entity.

### Version comparison

When asked "what changed between identity 1.1 and 1.2":

1. Fetch `metadata.json` for both tags.
2. Compare entity sets: added, removed, modified entities.
3. Compare properties: added/removed/changed fields.
4. Compare validation rule sets and status codes.

Use targeted extraction (jq/python) to avoid loading both full files into
context.

### Open-ended search

When the user's question is open-ended:

1. Fetch `metadata.json` and search entity names and descriptions for keyword
   matches.
2. Search validation rule descriptions for query terms.
3. Report matching entities and rules with definitions.

## CAWG family cheat sheet

| Family | Label prefix | Current | Purpose |
|--------|--------------|---------|---------|
| identity | `cawg.identity` | 1.2 (ratified 2025-12-15) | Named-actor identity via X.509 or VC |
| metadata | `cawg.metadata` | 1.1 | Structured publisher and work metadata |
| training-mining | `cawg.training-mining`, `cawg.data_mining`, `cawg.ai_training`, `cawg.ai_inference`, `cawg.ai_generative_training` | 1.1 | Rights assertions for AI training and data mining |
| endorsement | `cawg.endorsement` | 1.0-draft | Third-party endorsement assertions |
| organizational-identity-profile | profile | 1.0 | Requires C2PA 2.2+ and CAWG identity 1.2 + metadata 1.1 |
| ux-guidance | guidance | 1.0 | Consumer-facing presentation guidance |

## Output format

- Report entity definitions as structured tables (name, type, required,
  description).
- Report validation rules grouped by phase with severity indicators.
- Report version diffs as categorized lists (added, removed, modified).
- Report c2pa_references alongside CAWG answers when the question spans both
  specs.
- Always cite the CAWG family and spec version in the response.
- Use precise CAWG terminology: named_actor, signer_payload,
  referenced_assertions, identity_claims_aggregation, hard binding.

## Constraints

- Always fetch from the live repo. Training data may be outdated.
- CAWG identity assertions carry named_actor data; they do NOT replace the
  C2PA claim signer. Do not conflate the two.
- Organizational identity profile requires a combination of specs (C2PA
  2.2/2.3 plus CAWG identity 1.2 plus CAWG metadata 1.1). State the full
  stack when the question touches it.
- For large artifacts, extract the relevant section rather than dumping
  entire files into context.
- If a fetch fails, fall back to a local clone at
  `/home/developer/code/cawg-knowledge-graph/versions/` if it exists, then to
  training data as a last resort (clearly marked as potentially outdated).
- For C2PA-specific questions (manifests, claims, ingredients, trust list),
  prefer the `c2pa-kg` skill.
