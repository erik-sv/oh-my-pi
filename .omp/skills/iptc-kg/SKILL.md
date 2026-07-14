---
name: iptc-kg
description: Query the IPTC specifications knowledge graph (Photo Metadata, Video Metadata Hub, NewsCodes controlled vocabularies) from the live GitHub repository. Use when implementing or checking IPTC metadata properties, looking up NewsCodes vocabulary terms like digitalsourcetype, checking property definitions across IPTC standards, or mapping IPTC properties to other ecosystems. TRIGGER when the user asks about IPTC, Photo Metadata Standard, Video Metadata Hub, NewsCodes, digitalsourcetype values, or IPTC-to-C2PA property mappings.
---

# IPTC Knowledge Graph Query

You have access to a machine-readable knowledge graph derived from IPTC
specifications and controlled vocabularies. Fetch artifacts from the
live repo to answer questions with precision.

## Data access

### Step 1 - Fetch the spec-version pointer

```
https://raw.githubusercontent.com/encypherai/iptc-knowledge-graph/main/versions/current/spec-version.json
```

### Step 2 - Fetch the right artifact

| Artifact | Use for |
|----------|---------|
| `metadata.json` | Standards, properties, vocabularies, values, cross-standard mappings |
| `cross-standard-map.json` | How properties map across standards, vocabulary gap analysis |
| `ontology.ttl` | RDF/OWL class hierarchy, SKOS vocabulary concepts |
| `context.jsonld` | JSON-LD term definitions |

Construct URLs:
```
https://raw.githubusercontent.com/encypherai/iptc-knowledge-graph/main/versions/current/{artifact}
```

### Step 3 - Extract relevant data

For large artifacts, use Bash with Python or jq:

```bash
# List all standards
curl -s "$URL" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'{n}: v{s[\"version\"]}, {s[\"property_count\"]} props') for n,s in d['standards'].items()]"

# Find properties using digitalsourcetype vocabulary
curl -s "$URL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for sn,s in d['standards'].items():
    for pn,p in s['properties'].items():
        if 'digitalsource' in p.get('vocabulary_uri','').lower():
            print(f'{sn}.{pn}: {p.get(\"definition\",\"\")[:100]}')"

# List all digitalsourcetype values
curl -s "$URL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
v=d['vocabularies']['digitalsourcetype']
for name,val in v['values'].items():
    print(f'[{val[\"status\"]}] {name}: {val[\"label\"]}')"

# Get cross-standard mappings
curl -s "$MAP_URL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for n,m in d['mappings'].items():
    if len(m['standards'])>1:
        print(f'{m[\"display_name\"]}: {m[\"standards\"]}')"
```

## How to answer queries

### Vocabulary lookup
When asked about IPTC vocabularies (e.g., "what values does digitalsourcetype have?"):
1. Fetch `metadata.json`
2. Extract from `vocabularies` dict
3. Report values with labels, definitions, status, and media applicability

### Cross-standard property lookup
When asked "how is X represented across IPTC standards?":
1. Fetch `cross-standard-map.json`
2. Find the property mapping
3. Report each standard's definition, XMP/JSON/XML paths, and scope

### Gap analysis
When asked about missing coverage or scope inconsistencies:
1. Fetch `cross-standard-map.json`
2. Check `vocabulary_gaps` section
3. Report which standards reference the vocabulary and which are missing

### Text applicability
When asked "does this apply to text?":
1. Fetch `metadata.json`
2. Check `media_scope` for each property definition
3. ninjs properties have scope "news_item" (applies to text)
4. Video Metadata Hub properties have scope "video"
5. Photo Metadata properties have scope "image"

## IPTC Standards Covered

| Standard | Version | Media Scope |
|----------|---------|-------------|
| Photo Metadata | 2025.1 | Image (XMP in files) |
| Video Metadata Hub | 1.7 | Video (XMP, EBUCore, PVMD JSON) |
| NewsML-G2 | 2.34 | News items (XML) |
| ninjs | 2.2 | News items (JSON) |

## Constraints

- Always fetch from the live repo when possible
- IPTC vocabularies are maintained by IPTC, not Encypher
- The `digitalsourcetype` vocabulary definition says "digital image" but
  ninjs 2.2 references it for "this content" (media-agnostic)
- C2PA 2.4 also references the vocabulary cross-media
