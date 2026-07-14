---
name: cross-standard-map
description: Query the cross-standard property and vocabulary mapping showing how shared concepts (e.g. Digital Source Type) are referenced across standards ecosystems (IPTC, C2PA, and others). Use when comparing how a property or vocabulary is defined across standards, checking cross-ecosystem mappings or extensions, analyzing vocabulary gaps, or answering "how does IPTC X map to C2PA Y" questions. TRIGGER when the user mentions cross-standard mapping, property mapping between standards, digitalSourceType across ecosystems, or standard-to-standard vocabulary alignment.
---

# Cross-Standard Map Query

You have access to a cross-standard property and vocabulary mapping that
shows how shared concepts (like Digital Source Type) are referenced across
different standards ecosystems (IPTC, C2PA, and others).

## Data access

### Step 1 - Fetch the artifact

```
https://raw.githubusercontent.com/encypherai/cross-standard-map/main/versions/current/cross-standard-map.json
```

### Step 2 - Extract relevant data

```bash
# List all cross-ecosystem mappings
curl -s "$URL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for name,m in d['mappings'].items():
    cross = ' [CROSS-ECOSYSTEM]' if m['is_cross_ecosystem'] else ''
    print(f'{name}{cross}: {m[\"ecosystems\"]} - {len(m[\"references\"])} refs')"

# Get scope comparison for a concept
curl -s "$URL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=d['mappings']['Digital Source Type']
for std, scope in m['scope_summary'].items():
    print(f'{std}: {scope}')"

# List vocabulary extensions
curl -s "$URL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d['vocabulary_extensions']:
    print(f'{e[\"extending_standard\"]}: {e[\"extension_name\"]} ({e[\"extension_uri\"]})')"
```

## How to answer queries

### Cross-standard property lookup
When asked "how is X represented across standards?":
1. Fetch cross-standard-map.json
2. Find the mapping by concept_name
3. Report each reference with its standard, ecosystem, property name, and media scope

### Scope comparison
When asked about scope differences:
1. Check scope_summary in the mapping
2. Check gap_analyses for scope_inconsistencies
3. Report which standards scope the property differently

### Vocabulary extensions
When asked about vocabulary additions by other standards:
1. Check vocabulary_extensions
2. Report which ecosystem added what values and their URIs

## Ecosystems Covered

| Ecosystem | Source KG | Standards |
|-----------|-----------|-----------|
| IPTC | iptc-knowledge-graph | Photo Metadata 2025.1, VMHub 1.7, NewsML-G2 2.34, ninjs 2.2 |
| C2PA | c2pa-knowledge-graph | C2PA 2.4 |

## Constraints

- Each ecosystem's KG is the source of truth for its own standard
- This map only covers shared concepts (primarily vocabulary references)
- Scope values come from the source KGs and may use different terminology
