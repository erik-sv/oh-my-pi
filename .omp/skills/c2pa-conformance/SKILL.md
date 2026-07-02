---
name: c2pa-conformance
description: >
  Query the C2PA conformance program repositories and run the local
  conformance suite. Use when: checking conformance program requirements,
  running rubric evaluations, reviewing Sherif or Scott Perry's conformance
  issues, comparing our suite against upstream rubrics, querying the
  conforming products list or trust lists, or understanding conformance
  program vs spec requirements. TRIGGER when: user mentions conformance
  rubric, conformance program, conformance testing, json-formula rubric,
  signal rubric, conformance 0.2, Sherif, conforming products list, CPL,
  crJSON evaluation, or c2pa-conformance-suite.
argument-hint: "[query, e.g. 'run rubric on asset.jpg' or 'latest Sherif issues']"
allowed-tools: Read, Bash, Glob, Grep, Agent, WebFetch
---

# C2PA Conformance Program Query

You have access to the C2PA conformance program infrastructure through three
channels: the Rust CLI tool, the Python conformance suite, and the upstream
GitHub repositories.

## Key distinction: spec vs conformance program

The C2PA **specification** (`c2pa-org/specifications`) defines normative
requirements for manifests, claims, assertions, and validation. The c2pa-kg
skill covers this.

The C2PA **conformance program** (`c2pa-org/conformance`) adds operational
requirements *on top of* the spec. These are stricter and include:

- Mandatory specVersion in claim_generator_info (spec says SHOULD, program says MUST)
- CN name matching between submission and signing certificates
- crJSON output requirements for validator products
- Rubric-based automated evaluation using json-formula expressions
- Trust list and CA vetting requirements
- Security requirements for generator products

Always clarify which layer a requirement comes from.

## Rust CLI tool (primary)

**Location:** `/home/developer/code/c2pa-conformance-tool-cli`
**Repo:** `encypherai/c2pa-conformance-tool-cli` (public fork of `contentauth/c2pa-conformance-tool-cli`)
**Release:** v0.3.0

The Rust CLI is the primary tool for rubric evaluation. It is forked from
Adobe's upstream conformance tool, which is the reference implementation used
by the C2PA conformance program itself. This means our verification pipeline
uses the same c2pa-rs SDK, the same crJSON serialization, and the same
json-formula rubric expressions that the conformance program uses to evaluate
submissions. Our fork adds rubric evaluation, signals analysis, untrusted
asset support, and security patches on top. It matches the Python reference
evaluator output across all 18 golden fixtures.

### Key capabilities over upstream

- **Rubric evaluation** (`-rubric`): composable YAML rubrics in conformance and signals modes
- **crJSON extraction** (`-emit-crjson`): extract crJSON from binary assets
- **Pre-existing crJSON evaluation** (`-crjson`): evaluate crJSON files against rubrics for formats c2pa-rs cannot read (FLAC, DOCX, EPUB, ODT, OXPS, OTF, JXL)
- **Untrusted fallback**: automatic `verify_trust: false` when trust verification fails (pre-conformant products with self-signed certs)
- **Security patches**: rustls-webpki 0.103.13 (3 CVEs), rustls 0.23.40, rand 0.8.6/0.9.4

### Running the CLI

```bash
cd /home/developer/code/c2pa-conformance-tool-cli
export PATH="$HOME/.cargo/bin:$PATH"

# Validate a signed asset
cargo run -release -bin c2pa-validate - image.jpg

# Evaluate conformance rubric against a binary asset
cargo run -release -bin c2pa-validate - -rubric testfiles/rubrics/asset-rubric-conformance0.1-spec2.2.yml image.jpg

# Evaluate signals rubric (per-manifest signal detection)
cargo run -release -bin c2pa-validate - -rubric testfiles/rubrics/asset-rubric-signals-local.yml -rubric-mode signals image.jpg

# Extract crJSON from a binary asset
cargo run -release -bin c2pa-validate - -emit-crjson -o asset_crjson.json image.jpg

# Evaluate pre-existing crJSON (for unsupported formats)
cargo run -release -bin c2pa-validate - -crjson -rubric testfiles/rubrics/asset-rubric-conformance0.1-spec2.2.yml asset_crjson.json

# Run all rubrics in a directory
cargo run -release -bin c2pa-validate - -rubric-dir testfiles/rubrics/ image.jpg

# JSON output to file
cargo run -release -bin c2pa-validate - -rubric testfiles/rubrics/asset-rubric-conformance0.2-spec2.4.yml -f json -o results.json image.jpg

# Run tests (110+ tests including 36 golden fixture tests)
cargo test -release - -include-ignored
```

### Vendored crates

| Crate | Path | Purpose |
|-|-|-|
| `c2pa` v0.78.0 | `vendor/c2pa-rs/sdk` | C2PA SDK (manifest reading, signing, verification) |
| `profile_evaluator_rs` | `vendor/profile-evaluator-rs` | Rubric + profile evaluation engine (conformance and signals modes) |
| `json-formula-rs` | `vendor/json-formula-rs` | JMESPath-like expression evaluator for rubric formulas |

### Rubric files

```
testfiles/rubrics/
  asset-rubric-conformance0.1-spec2.2.yml   # 16 traits
  asset-rubric-conformance0.2-spec2.2.yml   # 17 traits
  asset-rubric-conformance0.2-spec2.4.yml   # 24 traits
  asset-rubric-signals-local.yml            # 13 signal categories
  asset-rubric-integrity.yml                # Integrity checks
  goldens/                                  # 18 crJSON inputs + expected outputs
```

### Test assets (29 formats)

```
testfiles/encypher-assets/
  audio/    aac, flac*, mp4, mpa, mpeg, wav
  document/ docx*, epub*, odt*, oxps*, pdf
  font/     otf*
  image/    avif, dng, gif, heic, heic-seq, heif, heif-seq, jpeg, jxl*, png, svg, tiff, webp
  video/    avi, m4v, mp4, quicktime

* = includes pre-converted crJSON for -crjson mode (c2pa-rs codec unsupported)
```

### When to use the Rust CLI vs the Python suite

The Rust CLI should be the default for all conformance work. It uses the same
verification stack as the conformance program (c2pa-rs for manifest reading,
crJSON serialization, and signature verification). Results from the Rust CLI
are directly comparable to what a conformance program evaluator would produce.

The Python suite is an independent reimplementation with its own container
extractors, JUMBF/CBOR parser, and predicate engine. It is useful for
cross-validation and for cases where you need low-level inspection that the
Rust CLI does not expose.

| Scenario | Use |
|-|-|
| Rubric evaluation (conformance or signals) | Rust CLI |
| crJSON extraction from binary assets | Rust CLI (`-emit-crjson`) |
| Evaluating unsupported format crJSON | Rust CLI (`-crjson`) |
| Verifying our results match what the conformance program would see | Rust CLI (same stack) |
| Cross-validation against an independent implementation | Python suite |
| Low-level JUMBF/CBOR inspection or custom container extraction | Python suite |
| Detailed predicate-level output (242 validation rules) | Python suite |
| Container-level binary validation (raw byte checks, no c2pa-rs) | Container validators |

## Container validators (internal)

**Location:** `/home/developer/code/encypherai-commercial/enterprise_api/tests/c2pa_conformance/container_validators.py`
**Tests:** `/home/developer/code/encypherai-commercial/enterprise_api/tests/test_container_conformance.py`

The container validators check the binary container encoding layer - the part
below the manifest. Rubric tests check manifest structure via crJSON. Container
validators check whether the manifest is embedded in the file in a way that any
spec-compliant parser can find it. They operate on raw bytes without c2pa-rs.

This layer exists because c2pa-rs reads its own output fine, but external tools
(c2patool, Sherif's conformance checker) may not. The two confirmed bugs that
motivated these validators:

1. **JXL**: Our embedder wrote a `c2pa` wrapper box around the JUMBF manifest
   store. Spec A.3.14 requires a top-level `jumb` superbox. External parsers
   looked for `jumb`, found `c2pa`, reported "No claim found."

2. **MP3**: c2pa-rs wrote ID3v2.4 tags. Spec A.3.4 references ID3v2.3. The
   frame size encoding differs (v2.4 syncsafe vs v2.3 big-endian). A v2.3
   parser reads syncsafe sizes as big-endian, seeks past EOF.

### Supported formats

| Format | Spec section | Issue codes |
|-|-|-|
| JXL | A.3.14 | `JXL_TOO_SHORT`, `JXL_BARE_CODESTREAM`, `JXL_NO_MANIFEST`, `JXL_C2PA_BOX_NOT_JUMB`, `JXL_JUMB_NESTED_IN_C2PA`, `JXL_WRONG_JUMD_UUID` |
| MP3 | A.3.4 | `MP3_NO_ID3V2`, `MP3_ID3V2_VERSION_MISMATCH`, `MP3_NO_GEOB`, `MP3_GEOB_WRONG_MIME`, `MP3_GEOB_DEPRECATED_MIME`, `MP3_FRAME_SIZE_INTEROP_FAILURE`, `MP3_FRAME_SIZE_AMBIGUOUS` |

### Running container validation

```bash
cd /home/developer/code/encypherai-commercial/enterprise_api

# Run all container conformance tests (17 tests)
~/.local/bin/uv run pytest tests/test_container_conformance.py -v

# Run just JXL or MP3 container tests
~/.local/bin/uv run pytest tests/test_container_conformance.py -k "JXL" -v
~/.local/bin/uv run pytest tests/test_container_conformance.py -k "MP3" -v

# Validate a specific file programmatically
~/.local/bin/uv run python -c "
from tests.c2pa_conformance.container_validators import validate_file
result = validate_file('path/to/signed.mp3')
print(result.summary())
"
```

### API

```python
from tests.c2pa_conformance.container_validators import (
    validate_file,    # Auto-detects format from extension
    validate_jxl,     # JXL-specific (takes bytes)
    validate_mp3,     # MP3-specific (takes bytes)
    Severity,         # ERROR or WARNING
    ValidationResult, # .passed, .errors, .warnings, .summary()
)
```

### When to use container validators

Use container validators when:
- A signed file fails in external tools but passes in c2pa-rs verification
- Adding support for a new container format (write the validator first)
- Debugging interop issues reported by the conformance program
- Verifying Pipeline B embedder output against spec requirements

Container validators complement rubric evaluation. The rubric checks what is
inside the manifest (claims, assertions, trust). Container validators check
that the manifest is accessible in the first place.

### Adding a new format validator

1. Add a `validate_<format>(data: bytes) -> ValidationResult` function to
   `container_validators.py`.
2. Register the extension in `validate_file()`.
3. Add integration tests in `test_container_conformance.py` (both fixture-based
   and synthetic unit tests).
4. Add issue codes to the table above.

## Python conformance suite

**Location:** `/home/developer/code/c2pa-conformance-suite`

The suite (v1.3.0) provides deterministic conformance testing with:
- 17 container extractors (27+ MIME types)
- JUMBF/CBOR parser (format-agnostic core)
- 150 declarative predicates against 242 validation rules
- Full cryptographic verification (COSE_Sign1, X.509, OCSP, timestamp)
- crJSON serializer (conformance program standard format)
- **json-formula rubric evaluator** (C2PA conformance program v0.2)
- **Signal rubric evaluator** (inception and transformation signals)
- Composable rubric loader with include resolution

### Running the suite

```bash
cd /home/developer/code/c2pa-conformance-suite

# Validate a single asset
~/.local/bin/uv run c2pa-conform validate asset.jpg

# Validate and emit crJSON
~/.local/bin/uv run c2pa-conform validate asset.jpg -output-format crjson -output results.json

# Run the default conformance rubric (0.2 spec 2.4)
~/.local/bin/uv run c2pa-conform rubric asset.jpg

# Run a specific rubric
~/.local/bin/uv run c2pa-conform rubric -crjson-input results.json -rubric path/to/rubric.yml

# Run with signal rubric
~/.local/bin/uv run c2pa-conform rubric asset.jpg -signal-rubric src/c2pa_conformance/data/rubrics/asset-rubric-signals-local.yml

# Force a specific engine
~/.local/bin/uv run c2pa-conform rubric -crjson-input results.json -engine json-formula

# Run tests
~/.local/bin/uv run pytest -x -q
```

### Vendored rubric files

The suite bundles upstream conformance program rubrics at:
```
src/c2pa_conformance/data/rubrics/
  asset-rubric-conformance0.2-spec2.4.yml   # Default rubric
  asset-rubric-conformance0.2-spec2.2.yml
  asset-rubric-conformance0.1-spec2.2.yml
  asset-rubric-integrity.yml
  asset-rubric-signals-local.yml
  composables/
    globals.yml                              # Shared variables + named expressions
    globals-signals.yml                      # Signal-specific globals
    conformance-program-0.2.yml              # Program 0.2 checks
    conformance-spec-2.4.yml                 # Spec 2.4 checks
    conformance-spec-2.2.yml                 # Spec 2.2 checks
    conformance-program-0.1.yml              # Program 0.1 checks
    integrity.yml                            # Integrity checks
    signal-inception-*.yml                   # Inception signal rubrics
    signal-transformations-*.yml             # Transformation signal rubrics
```

### Test vectors

Upstream test vectors are at:
```
tests/fixtures/upstream_rubric_vectors/
  capture.json                               # crJSON input
  capture.conformance.json                   # Expected conformance output
  capture.signals.json                       # Expected signal output
  ...
  unit/                                      # Unit test vectors for individual checks
```

## Upstream repositories

### c2pa-org/conformance (private, we have member access)

The conformance task force repo. Query via `gh` CLI:

```bash
# List recent issues
gh issue list -R c2pa-org/conformance -state open -limit 20

# View a specific issue
gh issue view 355 -R c2pa-org/conformance

# List recent PRs
gh pr list -R c2pa-org/conformance -state all -limit 10

# Fetch a file from the asset-rubrics branch (active development)
gh api "repos/c2pa-org/conformance/contents/asset-rubrics/composables/globals.yml?ref=sherifhanna-google/asset-rubrics" \
  -jq '.content' | tr -d '\n' | base64 -d

# Get the full repo tree
gh api "repos/c2pa-org/conformance/git/trees/main?recursive=1" -jq '.tree[].path'

# Get the asset-rubrics branch tree (where active rubric development happens)
gh api "repos/c2pa-org/conformance/git/trees/sherifhanna-google/asset-rubrics?recursive=1" \
  -jq '.tree[].path'

# Search for recent comments from Sherif
gh api "repos/c2pa-org/conformance/issues/comments?per_page=30&sort=created&direction=desc" \
  | jq '[.[] | select(.user.login == "sherifhanna-google")]'
```

Key documents in the conformance repo:
- `docs/C2PA Conformance Program.adoc` - Main program document
- `docs/Additional Conformance Requirements Against the Content Credentials Specification` - Stricter-than-spec requirements
- `docs/C2PA Generator Product Security Requirements.adoc` - Security requirements
- `docs/C2PA Certificate Policy.adoc` - Certificate policy
- `docs/C2PA Governance Framework.adoc` - Governance framework
- `conforming-products/conforming-products-list.schema.json` - CPL schema

Active branches:
- `main` - Stable documents
- `sherifhanna-google/asset-rubrics` - Active rubric development (json-formula migration)
- `SSP-Updates-to-Conformance-Program-Documentation-for-0.2-update` - v0.2 process updates

### c2pa-org/conformance-public (public)

Public-facing conformance artifacts:

```bash
# Get the trust list
curl -sL "https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/C2PA-TRUST-LIST.pem"

# Get the conforming products list
gh api repos/c2pa-org/conformance-public/contents/conforming-products/conforming-products-list.json \
  -jq '.content' | tr -d '\n' | base64 -d

# Check recent trust list updates
gh api repos/c2pa-org/conformance-public/commits -jq '.[0:5] | .[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'
```

### contentauth/c2pa-conformance-tool-cli (public, upstream)

Adobe's Rust-based conformance tool. Our fork (`encypherai/c2pa-conformance-tool-cli`)
adds rubric evaluation, signals analysis, untrusted asset support, and security patches.
The upstream does not have rubric evaluation.

```bash
# View upstream recent commits
gh api repos/contentauth/c2pa-conformance-tool-cli/commits -jq '.[0:5] | .[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'

# View our fork's recent commits
gh api repos/encypherai/c2pa-conformance-tool-cli/commits -jq '.[0:5] | .[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])"'

# Compare our fork against upstream
gh api repos/encypherai/c2pa-conformance-tool-cli/compare/contentauth:main...encypherai:main -jq '.ahead_by, .behind_by, (.commits[] | "\(.sha[0:8]) \(.commit.message | split("\n")[0])")'
```

## Key people

- **Sherif Hanna** (`sherifhanna-google`) - C2PA conformance program lead, Google. Drives rubric development and validator product requirements.
- **Scott Perry** (`ScottSPerryCPA`, `C2PAConformance`) - Conformance program operations. Handles intake forms, versioning, CA vetting.
- **Leonard Rosenthol** (`lrosenthol`) - Adobe. json-formula creator, rubric expression author.
- **Andy Parsons** (`andyparsons`) - CAI/Adobe. Public documentation and conformance explorer.
- **Darrell Kindred** (`darrellkindred`) - Media type and format coverage discussions.

## How to answer queries

### "What are the latest conformance requirements?"

1. Fetch the Additional Conformance Requirements doc from the conformance repo.
2. Check recent issues for new requirements (especially from Sherif and Scott Perry).
3. Cross-reference with the vendored rubric checks.

### "Run a conformance rubric on X"

**Prefer the Rust CLI** (faster, has signals mode, supports untrusted assets):

1. If X is a binary asset:
   ```bash
   cd /home/developer/code/c2pa-conformance-tool-cli
   PATH="$HOME/.cargo/bin:$PATH" cargo run -release -bin c2pa-validate - -rubric testfiles/rubrics/asset-rubric-conformance0.2-spec2.4.yml X
   ```
2. If X is a crJSON file:
   ```bash
   PATH="$HOME/.cargo/bin:$PATH" cargo run -release -bin c2pa-validate - -crjson -rubric testfiles/rubrics/asset-rubric-conformance0.2-spec2.4.yml X
   ```
3. For signals analysis, add `-rubric-mode signals` with `asset-rubric-signals-local.yml`.
4. Report pass/fail counts and any failures.

**Fallback to Python suite** when you need detailed predicate-level output or custom container inspection:

1. If X is a file path, run: `uv run c2pa-conform rubric X`
2. If X is a crJSON file, run: `uv run c2pa-conform rubric -crjson-input X`

### "What checks does conformance 0.2 add?"

1. Read the composable `conformance-program-0.2.yml` rubric.
2. Compare against `conformance-program-0.1.yml`.
3. Cross-reference with the Additional Conformance Requirements doc.

### "Are we aligned with upstream?"

1. Compare vendored rubric files against the upstream asset-rubrics branch.
2. Check for new composables, expressions, or test vectors.
3. Run upstream test vectors through our evaluator and report any failures.

### "This signed file fails in external tools / c2patool / Sherif's checker"

This is a container-level interop issue. The rubric tests will not catch it
because they check manifest structure, not binary container encoding.

1. Run the pre-submission pipeline first (fastest path to diagnosis):
   ```bash
   cd /home/developer/code/encypherai-commercial/enterprise_api
   ~/.local/bin/uv run python tests/c2pa_conformance/validate_submission.py path/to/signed/dir/
   ```
2. Check issue codes in the output against the known bugs table below.
3. If the format is not yet covered, inspect raw bytes against the relevant
   spec section (Appendix A).
4. If a bug is found, write the validator first (TDD), then fix the embedder.

### "Validate a submission before sending to Google"

Run the pre-submission conformance pipeline. This is the gate that must pass
before any files go to the C2PA conformance program:

```bash
cd /home/developer/code/encypherai-commercial/enterprise_api

# Validate the signed directory (default: tests/c2pa_conformance/signed/)
~/.local/bin/uv run python tests/c2pa_conformance/validate_submission.py

# Validate a specific directory
~/.local/bin/uv run python tests/c2pa_conformance/validate_submission.py path/to/submission/
```

The pipeline runs four validation levels:

| Level | What it checks | Catches |
|-|-|-|
| 1. Container | Binary embedding (FLAC blocks, ZIP manifest, ID3 GEOB) | FLAC ID3v2 bug, MP3 version mismatch, missing ZIP manifest |
| 2. Claim structure | JUMBF URI correctness, required claim fields, spec version | Missing `/c2pa/` prefix, old URN format, missing specVersion |
| 3. External extraction | Python suite extractors can parse the manifest | Anything c2pa-rs reads but independent readers cannot |
| 4. c2patool interop | c2patool reads the file without error (supported formats only) | Any interop issue with the reference tool |

The pipeline produces both console output and a JSON report at
`tests/c2pa_conformance/results/submission_validation.json`.

**Script**: `/home/developer/code/encypherai-commercial/enterprise_api/tests/c2pa_conformance/validate_submission.py`

### "Validate a new format end-to-end"

Full conformance validation for a newly supported format requires three layers:

1. **Container validation** (validate_submission.py level 1): Is the manifest
   embedded correctly in the binary container?
2. **Claim structure** (validate_submission.py level 2): Are JUMBF URIs
   correct? Does the claim have required fields?
3. **Rubric conformance** (Rust CLI or Python suite): Does the manifest pass
   the conformance program rubric checks?

Run the full pipeline:
```bash
cd /home/developer/code/encypherai-commercial/enterprise_api

# Pre-submission pipeline (levels 1-4)
~/.local/bin/uv run python tests/c2pa_conformance/validate_submission.py

# Rubric evaluation (separate, requires crJSON)
cd /home/developer/code/c2pa-conformance-tool-cli
PATH="$HOME/.cargo/bin:$PATH" cargo run -release -bin c2pa-validate - \
  -rubric testfiles/rubrics/asset-rubric-conformance0.2-spec2.4.yml asset.ext

# Signing unit tests
cd /home/developer/code/encypherai-commercial/enterprise_api
~/.local/bin/uv run pytest tests/unit/test_document_signing.py -k "FORMAT" -v
```

## Sibling skills

- **c2pa-kg**: Query the C2PA specification knowledge graph (entities, validation rules, conformance predicates). Use for spec-level questions.
- **cawg-kg**: Query the CAWG knowledge graph (identity, metadata, training-mining assertions). Use for CAWG-layer questions.
- **c2pa-spec-review**: Review C2PA specification text with standards-body rigor.

Use `c2pa-conformance` for conformance *program* questions. Use `c2pa-kg` for *specification* questions. The conformance program is a superset of the spec.

## Known bugs (as of 2026-05-23)

Bugs found during Google conformance program review, confirmed by the
pre-submission pipeline. Both must be fixed before resubmission.

### Bug 1: FLAC container embedding (FLAC_ID3V2_EMBEDDING)

**Status**: Open
**File**: `enterprise_api/app/utils/flac_c2pa_embedder.py`
**Symptom**: Google validator "No claim found." Our Python FLACExtractor also
fails. c2patool does not support FLAC at all.

**Root cause**: The FLAC embedder wraps C2PA JUMBF in an ID3v2.3 GEOB frame
prepended before the fLaC magic bytes. FLAC readers look for FLAC APPLICATION
metadata blocks (block type 2, application ID `c2pa`), not ID3v2 tags.

**Evidence**: The CLI test FLAC at `c2pa-conformance-tool-cli/testfiles/
encypher-assets/audio/flac/signed_test.flac` correctly uses FLAC APPLICATION
blocks and extracts fine with the Python FLACExtractor.

**Fix**: Rewrite `flac_c2pa_embedder.py` to use FLAC APPLICATION metadata
blocks instead of ID3v2.3 GEOB. The two-pass approach (placeholder, hash,
sign, replace) stays the same; only the container format changes.

### Bug 2: Claim signature URI missing /c2pa/ prefix (CLAIM_SIG_URI_MISSING_PREFIX)

**Status**: Open
**File**: `enterprise_api/app/utils/c2pa_claim_builder.py:188`
**Symptom**: Google validator "claimSignature.missing" on DOCX. Affects ALL
Pipeline B formats (DOCX, EPUB, ODT, OXPS, OTF, PDF, FLAC, MP3, JXL, TTF).

**Root cause**: Line 188 builds the claim signature reference as:
```python
"signature": f"self#jumbf={manifest_label}/c2pa.signature"
```
This produces `self#jumbf=urn:c2pa:xxx/c2pa.signature`. The correct absolute
form used by c2patool and c2pa-rs is:
```
self#jumbf=/c2pa/urn:c2pa:xxx/c2pa.signature
```
The `/c2pa/` manifest store prefix is missing. External validators cannot
resolve the URI to the signature JUMBF box.

**Why self-verification passes**: `document_verification_service.py` accesses
the signature directly from the parsed JUMBF tree, bypassing URI resolution.

**Fix**: One-line change:
```python
"signature": f"self#jumbf=/c2pa/{manifest_label}/c2pa.signature"
```

### Ecosystem gaps (not bugs)

These formats have valid C2PA manifests but no external tool can read them:

| Format | c2patool | Google validator | Our readers |
|-|-|-|-|
| EPUB | Unsupported | Unknown | Python ZIPExtractor: OK |
| ODT | Unsupported | Unknown | Python ZIPExtractor: OK |
| OXPS | Unsupported | Unknown | Python ZIPExtractor: OK |
| OTF | Unsupported | Unknown | Python FontExtractor: OK |

Evidence for Google: provide crJSON extracts from the Python conformance suite
showing valid manifests with `claimSignature.validated`, `timeStamp.validated`,
and `assertion.dataHash.match` in validationResults. Also provide independent
COSE_Sign1 signature verification proof using the `cryptography` library.

### Additional findings from the pre-submission pipeline

| Code | Formats | Issue |
|-|-|-|
| `MP3_GEOB_OLD_MIME` | MP3 | Python ID3Extractor uses old `application/c2pa` MIME; update to `application/jumbf` |
| `EXTRACT_FAILED` on .avi, .webp | AVI, WebP | Python suite missing extractors for RIFF-WebP and AVI |

## Known limitations

- **json-formula `true` literal handling** (Python suite): The upstream rubric expression for `no_unsupported_assertions` uses `true` without backtick escaping. The json-formula-py implementation treats unescaped `true` as a field reference, not a boolean literal. This causes false failures on assets with deduplicated assertion keys (e.g., `c2pa.ingredient.v3__1`). The Rust json-formula-rs implementation handles this correctly.
- **Signal rubric pruning**: The upstream signal evaluator includes provenance DAG pruning logic for multi-manifest chains. Both our Rust and Python implementations cover the core evaluation but do not yet implement the full pruning/reclassification logic.
- **c2patool format coverage**: c2patool v0.26.41 does not support FLAC, DOCX, EPUB, ODT, OXPS, OTF, JXL, DNG, or MP3. For these formats, use the Python conformance suite extractors and the pre-submission pipeline for interop validation.
- **Rubric version sync**: The vendored rubrics are from the `sherifhanna-google/asset-rubrics` branch as of 2026-04-24. The branch has not yet been merged to `main`.
- **Unsupported format crJSON**: For 7 formats (FLAC, DOCX, EPUB, ODT, OXPS, OTF, JXL), the Rust CLI requires pre-converted crJSON via `-crjson` mode because c2pa-rs lacks native codec support. A converter script exists at `/home/developer/code/encypherai-commercial/docs/c2pa/conformance/convert_reader_to_crjson.py`. Long-term fix: have our API emit crJSON natively.
- **Container validators coverage**: Only JXL (A.3.14) and MP3 (A.3.4) have container-level validators. Other formats (FLAC, WAV, PDF, BMFF, etc.) are not yet covered. Add validators as interop issues surface for each format.
- **`algorithmicMedia` DST not mapped**: Our assets use `algorithmicMedia` as the digitalSourceType, which is not mapped to any signal in the current signals rubric. This is correct behavior (the rubric tracks specific signal categories, not generic DSTs), but means signal detection returns empty for our assets.
