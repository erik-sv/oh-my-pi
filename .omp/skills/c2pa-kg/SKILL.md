---
name: c2pa-kg
description: >
  Query the C2PA specification knowledge graph from the live GitHub repository.
  Use when: implementing C2PA, checking spec requirements, looking up entity
  definitions, finding validation rules, comparing spec versions, or answering
  questions about C2PA data structures. TRIGGER when: user asks about C2PA
  entities, manifests, claims, assertions, ingredients, validation, trust model,
  spec changes between versions, or C2PA conformance predicates.
argument-hint: "[query or entity name, e.g. 'ClaimMap properties' or 'diff 2.2 2.4']"
allowed-tools: Read, Bash, Glob, Grep, Agent, WebFetch
---

# C2PA Knowledge Graph Query

You have access to a machine-readable knowledge graph derived from the C2PA specification,
hosted at https://github.com/encypherai/c2pa-knowledge-graph. Fetch artifacts from the
live repo to answer questions with precision rather than relying on training data.

## Data access — live GitHub URLs

Always fetch from the live repo. Never guess answers from training data when the
knowledge graph is available.

### Step 1 — Resolve the current spec version

Fetch the evergreen pointer file:

```
https://raw.githubusercontent.com/encypherai/c2pa-knowledge-graph/spec-current/spec-version.json
```

This returns the current spec version and direct URLs to all artifacts. If the user
requests a specific version, use the versioned URL instead:

```
https://raw.githubusercontent.com/encypherai/c2pa-knowledge-graph/v1.{spec_version}/spec-version.json
```

Tag format: `v1.{spec_version}` (e.g., `v1.2.4` for spec 2.4, `v1.1.4` for spec 1.4).

### Step 2 — Fetch the right artifact

Each spec version has five artifacts. Fetch only what the query needs:

| Artifact | Use for | Typical size |
|----------|---------|--------------|
| `metadata.json` | Entity lookups, properties, relationships, enums, type aliases, status codes | Large (~14K lines) |
| `validation-rules.json` | Normative validation rules by phase | Medium (~3K lines) |
| `predicates.json` | Conformance predicates, test vectors, format coverage | Medium (~8K lines) |
| `ontology.ttl` | RDF/OWL class hierarchy, cardinality constraints | Medium (~8K lines) |
| `context.jsonld` | JSON-LD term definitions | Medium (~4K lines) |

Construct the URL from spec-version.json's `urls` field, or directly:

```
https://raw.githubusercontent.com/encypherai/c2pa-knowledge-graph/v1.{spec_version}/versions/{spec_version}/{artifact}
```

### Step 3 — Extract relevant data

For large artifacts (metadata.json especially), use Bash with Python or jq to extract
only the relevant section rather than reading the entire file:

```bash
# Fetch and extract a single entity
curl -s "https://raw.githubusercontent.com/encypherai/c2pa-knowledge-graph/spec-current/versions/2.4/metadata.json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); e=d['entities'].get('ClaimMapV2'); print(json.dumps(e, indent=2) if e else 'Not found')"

# List all entity names
curl -s "$URL" | python3 -c "import json,sys; d=json.load(sys.stdin); print('\n'.join(sorted(d['entities'].keys())))"

# Filter validation rules by phase
curl -s "$RULES_URL" | python3 -c "
import json,sys
rules=json.load(sys.stdin)
for r in rules:
    if r.get('phase')=='structural':
        print(f\"[{r['severity']}] {r['description'][:120]}\")"
```

## How to answer queries

### Entity lookup

When asked about a C2PA entity (e.g., "what properties does a Claim have?"):

1. Fetch `spec-version.json` to confirm the current version.
2. Fetch `metadata.json` and extract the entity from the `entities` dict.
   Entity names are CamelCase (e.g., `ClaimMap`, `ClaimMapV2`, `ActionItemsMap`,
   `IngredientMapV3`).
3. Report the entity's properties (name, type, required, cardinality, description),
   relationships (target entity, relationship type), and deprecation status.
4. If the entity name is ambiguous, search across all entity names and suggest matches.

### Validation rules

When asked about validation requirements:

1. Fetch `validation-rules.json` (prefer this over metadata.json for rule queries).
2. Filter by phase if specified: `structural`, `cryptographic`, `trust`, `semantic`,
   `assertion`, `ingredient`, `timestamp`, `signature`, `content`.
3. Report rules with severity (must/shall/should/may), description, and referenced entities.
4. Cross-reference with status codes from `metadata.json` when relevant.

### Conformance predicates

When asked about conformance testing or format-specific validation:

1. Fetch `predicates.json`.
2. Filter by format family if specified: `text_plain`, `image`, `video_bmff`,
   `audio_wav`, `document_pdf`, `multi_asset`, `boxes_hash`, `collection_hash`,
   `structured_text`, `streaming_bmff`.
3. Report predicate ID, title, source rules, severity, and conditions.
4. Include test vectors when the user asks for examples.

### Version comparison

When asked "what changed between X and Y":

1. Fetch `metadata.json` for both versions.
2. Compare entity sets: added, removed, modified entities.
3. For modified entities, compare properties: added/removed/changed fields.
4. Compare validation rule sets and enum types.

Use targeted extraction (jq/python) to avoid loading both full files into context.

### Search

When the user's question is open-ended:

1. Fetch `metadata.json` and search entity names and descriptions for keyword matches.
2. Search validation rule descriptions for query terms.
3. Report matching entities and rules with definitions.

## Known spec versions

| Version | KG Tag | Entities | Rules |
|---------|--------|----------|-------|
| 2.4 | v1.2.4 | 148 | 237 |
| 2.3 | v1.2.3 | 98 | 233 |
| 2.2 | v1.2.2 | 86 | 203 |
| 2.1 | v1.2.1 | 81 | 159 |
| 2.0 | v1.2.0 | 74 | 129 |
| 1.4 | v1.1.4 | 74 | 131 |
| 1.3 | v1.1.3 | 64 | 102 |
| 1.2 | v1.1.2 | 44 | 82 |
| 1.1 | v1.1.1 | 44 | 82 |
| 1.0 | v1.1.0 | 42 | 75 |
| 0.8 | v1.0.8 | 0 | 0 |
| 0.7 | v1.0.7 | 0 | 0 |

The **`spec-current`** tag always resolves to the latest version.

## Output format

- Report entity definitions as structured tables (name, type, required, description).
- Report validation rules grouped by phase with severity indicators.
- Report version diffs as categorized lists (added, removed, modified).
- Always cite the spec version number in your response.
- Use precise C2PA terminology: manifests, claims, assertions, ingredients, trust anchors.

## Sibling skill: cawg-kg

CAWG (Creator Assertions Working Group) is a DIF-hosted family of assertions
that extend C2PA: identity (named_actor), metadata enrichment, training and
data-mining rights, endorsement, organizational identity profile, and UX
guidance. CAWG has its own knowledge graph and dedicated skill.

Redirect to the `cawg-kg` skill when the question concerns:

- `cawg.identity`, `cawg.training-mining`, `cawg.metadata`, or any `cawg.*` label
- `named_actor`, `signer_payload`, `referenced_assertions`, or
  `identity_claims_aggregation`
- CAWG validation rules, status codes (`cawg.identity.*`), or conformance
- Organizational identity profile (which combines C2PA 2.2+ with CAWG identity
  1.2 and CAWG metadata 1.1)

Use `c2pa-kg` for pure C2PA questions; use `cawg-kg` for CAWG questions; use
both when the answer spans the seam.

## Constraints

- Always fetch from the live repo. Training data may be outdated.
- C2PA (the standard) defines document-level provenance. Do not confuse C2PA standard
  capabilities with proprietary extensions built on top of C2PA.
- CAWG assertions ride inside C2PA manifests but are governed by DIF, not the
  C2PA Technical Working Group. Do not attribute CAWG requirements to the C2PA spec.
- For large artifacts, extract the relevant section rather than dumping entire files
  into context. Use the Python/jq extraction patterns above.
- If a fetch fails (network error, 404), fall back to a local clone at
  `/home/developer/code/c2pa-knowledge-graph/versions/` if it exists, then to
  training data as a last resort (clearly marked as potentially outdated).
