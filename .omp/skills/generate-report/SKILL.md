---
name: generate-report
description: "Generate or edit branded Encypher DOCX reports and documents. Use when the user wants to create a report, white paper, brief, one-pager, policy document, or any branded DOCX output, or when they ask to edit, normalize, or re-brand an existing Encypher DOCX. Triggers: 'create a report', 'write a brief', 'generate a document', 'make a one-pager', 'branded DOCX', 'fix the fonts', 'clean up this doc', 'normalize this report'."
argument-hint: "[topic or description of the document]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# Generate Branded Encypher Report

Create or edit professional, branded DOCX documents using the shared brand module at `docs/shared/docx_brand.py` and the template at `docs/templates/Encypher_Report_Template.dotx` in the `encypherai-commercial` repository.

## How It Works

Encypher has a Python-based DOCX generation system and a parallel Word template, both driven from the same brand constants:

- **For programmatic generation** (scripts, batch outputs): import helpers from `docs/shared/docx_brand.py` and build the document with function calls.
- **For human-authored drafts** (reports written in Word): start from `docs/templates/Encypher_Report_Template.dotx`. Style IDs are prefixed `Encypher*` (e.g. `Encypher Title`, `Encypher Body`) and visible in Word's Styles pane.
- **For editing an existing DOCX**: open with python-docx, make the targeted change, then run the font-normalization sweep (see Font Hygiene below) before saving. Multiple editors round-tripping a doc is the main source of font pollution.

Both paths share the same colors, typography, and header/footer so human-drafted and machine-generated documents look identical.

## Setup

The generator script must add the shared module to the import path. Use this pattern at the top of every generator:

```python
#!/usr/bin/env python3
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "<relative-path-to-docs-dir>"))

from docx.shared import Pt  # only if you need Pt() directly (e.g. spacer paragraphs)

from shared.docx_brand import (
    new_doc, setup_header_footer,
    add_title, add_subtitle, add_heading, add_body, add_body_mixed,
    add_bullet, add_numbered, add_table, add_callout, add_meta_line,
    add_page_break, add_hyperlink, set_cell_shading,
)
```

Adjust the relative path so it resolves to the `docs/` directory containing `shared/`. For a script in `docs/legal/`, the path is `".."`. For a script in `docs/sales/`, same thing.

## API Reference

### Document Setup

| Function | Purpose |
|---|---|
| `new_doc()` | Create a new Document with US Letter size, 1-inch margins |
| `setup_header_footer(doc, author=None, email=None, site_label=None, site_url=None)` | Add branded header (logo on every page) and footer (contact info, hyperlinks, auto page number). Default footer: `Encypher Corporation | info@encypher.com | encypher.com`. With `author`: `Encypher Corporation | Author Name | author@email | encypher.com`. Pass `email` only when `author` is set. |

### Content Helpers

| Function | Purpose |
|---|---|
| `add_title(doc, text, size=22)` | Large title with blue underline. `keep_with_next` enabled. |
| `add_subtitle(doc, text, size=13)` | Italic subtitle in brand blue. `keep_with_next` enabled. |
| `add_heading(doc, text, level=2)` | Section heading. Levels: 1 (large, ruled), 2 (medium, blue), 3 (small, dark). All have `keep_with_next`. |
| `add_body(doc, text, size=9.5, space_after=4, bold=False, italic=False)` | Standard body paragraph. |
| `add_body_mixed(doc, parts, size=9.5, space_after=4)` | Paragraph with mixed formatting. `parts` is a list of `(text, bold)` or `(text, bold, italic)` tuples. |
| `add_bullet(doc, text, bold_prefix=None, size=9)` | Bullet point with optional bold prefix label. |
| `add_numbered(doc, number, text, bold_prefix=None, size=9)` | Numbered item with optional bold prefix label. |
| `add_table(doc, headers, rows, col_widths=None, font_size=8.5)` | Branded table with header row, alternating shading, blue borders. `rows` is a list of lists. `col_widths` in inches. |
| `add_callout(doc, text, size=9)` | Highlighted callout box with blue left border and light background. Italic text. |
| `add_meta_line(doc, label, value, size=9)` | Key-value metadata line (e.g. "Author: Jane Smith"). |
| `add_page_break(doc)` | Insert a hard page break. |
| `add_hyperlink(paragraph, text, url, color=BLUE_NCS, size_pt=7, bold=False)` | Append a clickable hyperlink run to any paragraph. |
| `set_cell_shading(cell, hex_color)` | Apply background fill to a table cell. |

### Brand Constants (importable)

| Constant | Value | Use |
|---|---|---|
| `DELFT_BLUE` | `#1B2F50` | Headings, bold labels |
| `BLUE_NCS` | `#2A87C4` | Level-2 headings, links, bullet markers |
| `COLUMBIA_BLUE` | `#B7D5ED` | Table borders, rules |
| `BODY_TEXT` | `#333333` | Body text |
| `WHITE` | `#FFFFFF` | Table header text |
| `LIGHT_BG` | `"EDF4F9"` | Alternating row shading, callout background |
| `FONT` | `"Roboto"` | Primary font |
| `FONT_MONO` | `"Roboto Mono"` | Code blocks |

## Process

1. **Understand the request.** Clarify the document's purpose, audience, and structure before writing code. Ask what sections are needed if not obvious.

2. **Choose a location.** Place the generator script near its output. Convention: `docs/<topic>/generate_<name>.py` producing `docs/<topic>/Encypher_<Name>.docx`.

3. **Write the generator script.** Follow this skeleton:

```python
#!/usr/bin/env python3
"""Generate branded DOCX: <Title>.

Usage:
  python3 docs/<topic>/generate_<name>.py
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from docx.shared import Pt
from shared.docx_brand import (
    new_doc, setup_header_footer,
    add_title, add_subtitle, add_heading, add_body,
    add_bullet, add_numbered, add_table, add_callout,
    add_meta_line, add_page_break,
)

OUTPUT_DIR = os.path.dirname(__file__)

def build():
    doc = new_doc()
    setup_header_footer(doc)  # company-only: info@encypher.com
    # or: setup_header_footer(doc, author="Name, Title", email="name@encypher.com")

    # -- Title page --
    for _ in range(4):
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(0)

    add_title(doc, "Document Title", size=24)
    add_subtitle(doc, "Subtitle line", size=13)
    add_meta_line(doc, "Prepared by", "Encypher Corporation")
    add_meta_line(doc, "Date", "Month Year")

    add_page_break(doc)

    # -- Sections --
    add_heading(doc, "1. Section Title", level=1)
    add_body(doc, "Body text here.")

    add_heading(doc, "Subsection", level=2)
    add_bullet(doc, "Detail here.", "Key point: ")

    add_table(doc, ["Col A", "Col B"], [["r1a", "r1b"], ["r2a", "r2b"]])

    add_callout(doc, "Important note in a highlighted box.")

    # -- Save --
    path = os.path.join(OUTPUT_DIR, "Encypher_<Name>.docx")
    doc.save(path)
    print(f"  Saved: {path}")

if __name__ == "__main__":
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print("Generating <Name>...")
    build()
    print("Done.")
```

4. **Run the generator:**
```bash
python3 docs/<topic>/generate_<name>.py
```

5. **Verify the output.** Read the generated `.docx` to confirm structure:
```python
python3 -c "
from docx import Document
doc = Document('path/to/output.docx')
print(f'Paragraphs: {len(doc.paragraphs)}, Tables: {len(doc.tables)}')
# Check header/footer
s = doc.sections[0]
print(f'Footer: {s.footer.tables[0].rows[0].cells[0].text}')
"
```

6. **Show the user** the output path and a summary of what was generated.

## Font Hygiene

**Rule: Roboto and Roboto Mono only.** Nothing else. Arimo, Caladea, Calibri, Cambria, Carlito, Courier, and "Roboto Regular" (note: the space-and-weight variant) all creep in when a document is round-tripped through LibreOffice or through a track-changes editor. Sweep them out before delivering any DOCX that leaves the company.

### After editing an existing DOCX, always sweep fonts

```python
import os, re, shutil, zipfile

def normalize_fonts(docx_path):
    """Force every font reference in a DOCX to Roboto / Roboto Mono."""
    workdir = docx_path + ".unpack"
    if os.path.exists(workdir): shutil.rmtree(workdir)
    os.makedirs(workdir)
    with zipfile.ZipFile(docx_path) as z: z.extractall(workdir)

    mono = {"Courier", "Courier New", "Consolas"}

    def sub_rfonts(m):
        attr, val = m.group(1), m.group(2)
        return f'w:{attr}="Roboto Mono"' if val in mono else f'w:{attr}="Roboto"'

    def sub_theme(m):
        script, val = m.group(1), m.group(2)
        return f'<a:{script} typeface="Roboto Mono"' if val in mono else f'<a:{script} typeface="Roboto"'

    for root, _, files in os.walk(workdir):
        for name in files:
            if not (name.endswith(".xml") or name.endswith(".rels")): continue
            p = os.path.join(root, name)
            with open(p) as fh: xml = fh.read()
            new_xml = re.sub(r'w:(ascii|hAnsi|cs|eastAsia)="([^"]+)"', sub_rfonts, xml)
            new_xml = re.sub(r'<a:(latin|ea|cs) typeface="([^"]+)"', sub_theme, new_xml)
            if new_xml != xml:
                with open(p, "w") as fh: fh.write(new_xml)

    tmp = docx_path + ".new"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(workdir):
            for name in files:
                full = os.path.join(root, name)
                z.write(full, os.path.relpath(full, workdir))
    os.replace(tmp, docx_path)
    shutil.rmtree(workdir)
```

### Verify after sweep

```python
import zipfile, re
fonts = set()
with zipfile.ZipFile(path) as z:
    for name in z.namelist():
        if not name.endswith(".xml"): continue
        xml = z.read(name).decode(errors="ignore")
        for m in re.finditer(r'<w:rFonts[^/]*?/>', xml):
            for m2 in re.finditer(r'w:(?:ascii|hAnsi|cs|eastAsia)="([^"]+)"', m.group()):
                fonts.add(m2.group(1))
assert fonts <= {"Roboto", "Roboto Mono"}, f"Pollution: {fonts}"
```

## Editing an Existing Encypher DOCX

When the user hands you a DOCX and asks for changes (tracked-change acceptance, content edits, Section fixes):

1. **Read first.** Extract with `python-docx` (paragraphs, tables) and dump track changes from `document.xml` (`<w:ins>`, `<w:del>`) if track-changes edits are in play.
2. **Edit with targeted run edits**, not `cell.text = "..."` (that wipes formatting). Preserve the first run, set `run.text`, clear trailing runs.
3. **Save** to a versioned path (`..._v1.0.docx`, `..._v1.1.docx`). Do not overwrite the source.
4. **Run the font sweep** above. This is the step most likely to be forgotten; make it automatic.
5. **Verify** with the Verification Checklist.

## Word Template (.dotx)

`docs/templates/Encypher_Report_Template.dotx` is the canonical template for human-authored reports. Regenerate when brand constants change:

```
python3 docs/shared/generate_template.py
```

The generator lives at `docs/shared/generate_template.py` and imports from `docs/shared/docx_brand.py`, keeping the template in lockstep with programmatic output. Named paragraph styles available in the template:

| Style ID | Use |
|-|-|
| Encypher Title | One per document. |
| Encypher Subtitle | Italic line under the title. |
| Encypher Heading 1 / 2 / 3 | Section, subsection, sub-subsection. |
| Encypher Body | Running prose. Default. |
| Encypher Bullet / Numbered | Lists. |
| Encypher Callout | Highlighted sentence with blue left rule. Use sparingly. |
| Encypher Accent | Inline character style for Blue NCS emphasis. |

## Verification Checklist

Before telling the user a DOCX is ready:

- [ ] **Fonts**: only `Roboto` and `Roboto Mono` appear in rFonts and theme typefaces.
- [ ] **Structure**: paragraph count and table count match expectations (`print(f"Paragraphs: {len(doc.paragraphs)}, Tables: {len(doc.tables)}")`).
- [ ] **Header and footer** present on page 1 (logo + contact line + page number).
- [ ] **Content changes** verified by reading target paragraphs or table rows back out.
- [ ] **File size** sanity-check: a policy report with a logo and 3 tables is typically 150-500 KB. A sudden jump or collapse means something is wrong.
- [ ] **No ASCII-violating characters** in inserted text (em-dash, smart quote, ellipsis character). Grep the extracted text.

## Writing Style

All Encypher document prose follows the writing register in `/home/developer/code/CLAUDE.md` under "Encypher Writing Style" (Orwell/Lewis/Economist register, ASCII only, commas over dashes, active voice, no hedging, concrete before abstract). Treat that section as the SSOT; do not duplicate rules here.

Key reminders specific to DOCX output:

- **C2PA = document-level provenance.** Never attribute sentence-level capability to C2PA. Sentence-level and segment-level granularity belong to Encypher's technology.
- **No em-dashes, smart quotes, or ellipsis characters** in inserted prose. These are easy to miss when copy-pasting from email or chat.
- **Commas over dashes** for parentheticals. Reserve a single spaced hyphen for cases where commas would be genuinely ambiguous.

## Upload to Zoho Writer (Native Format)

After generating a DOCX, upload it to Zoho Writer to create a native `.zwriter` document. This preserves all branding and formatting.

### Upload DOCX as native Writer document

```bash
# Get auth token (handles caching and refresh)
source "$HOME/.config/encypher/zoho-vera.env"
TOKEN_CACHE="$HOME/.config/encypher/zoho-vera-token.json"
ACCESS_TOKEN=""
if [[ -f "$TOKEN_CACHE" ]]; then
  CACHED_EXPIRES=$(jq -r '.expires_at // 0' "$TOKEN_CACHE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if (( NOW < CACHED_EXPIRES )); then
    ACCESS_TOKEN=$(jq -r '.access_token // empty' "$TOKEN_CACHE" 2>/dev/null || true)
  fi
fi
if [[ -z "$ACCESS_TOKEN" ]]; then
  TOKEN_RESPONSE=$(curl -s -X POST "${ZOHO_ACCOUNT_SERVER}/oauth/v2/token" \
    -d "refresh_token=${ZOHO_REFRESH_TOKEN}" \
    -d "client_id=${ZOHO_CLIENT_ID}" \
    -d "client_secret=${ZOHO_CLIENT_SECRET}" \
    -d "grant_type=refresh_token")
  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')
  EXPIRES_IN=$(echo "$TOKEN_RESPONSE" | jq -r '.expires_in // 3600')
  NOW=$(date +%s)
  EXPIRES_AT=$(( NOW + EXPIRES_IN - 300 ))
  jq -n -arg token "$ACCESS_TOKEN" -argjson expires "$EXPIRES_AT" \
    '{access_token: $token, expires_at: $expires}' > "$TOKEN_CACHE"
fi

# Upload - parameter name MUST be "content" (not "document", "file", etc.)
RESPONSE=$(curl -s -X POST "https://www.zohoapis.com/writer/api/v1/documents" \
  -H "Authorization: Zoho-oauthtoken ${ACCESS_TOKEN}" \
  -F "content=@/path/to/file.docx" \
  -F "filename=Document Name")

DOCUMENT_ID=$(echo "$RESPONSE" | jq -r '.document_id')
```

Required OAuth scope: `ZohoWriter.documents.CREATE` (on Vera service account).

### Move to WorkDrive team folder

Uploaded documents land in Vera's "My Folders". Move to the correct team folder:

```bash
curl -s -X PATCH "https://www.zohoapis.com/workdrive/api/v1/files/${DOCUMENT_ID}" \
  -H "Authorization: Zoho-oauthtoken ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"data\": {\"attributes\": {\"parent_id\": \"FOLDER_ID\"}, \"type\": \"files\"}}"
```

Known folder IDs:

| Folder | ID |
|-|-|
| General (team folder) | `v6z7f0e2a9e678c7647ea85661fe5c43da3c8` |

### Create external share link

Team policy requires passwords on all external links:

```bash
curl -s -X POST "https://www.zohoapis.com/workdrive/api/v1/links" \
  -H "Authorization: Zoho-oauthtoken ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "attributes": {
        "resource_id": "'"${DOCUMENT_ID}"'",
        "link_name": "Link Name",
        "role_id": 5,
        "allow_download": true,
        "request_user_data": false,
        "password_text": "encypher2026"
      },
      "type": "links"
    }
  }'
```

Role IDs: 5 = Editor, 6 = View & Comment, 34 = Viewer.

### Send Cliq notification

```bash
bash "$HOME/.claude/skills/zoho/scripts/zoho-api.sh" POST \
  "https://cliq.zoho.com/api/v2/buddies/RECIPIENT_EMAIL/message" \
  -d '{"text":"Document: https://workdrive.encypher.com/writer/open/'"${DOCUMENT_ID}"'"}'
```

Cliq DM addresses: `erik.svilich@encypher.com`, `eddan.katz@encypher.com`.

### Upload DOCX to WorkDrive only (no Writer conversion)

If native Writer format is not needed:

```bash
curl -s -X POST "https://www.zohoapis.com/workdrive/api/v1/upload" \
  -H "Authorization: Zoho-oauthtoken ${ACCESS_TOKEN}" \
  -F "content=@/path/to/file.docx" \
  -F "parent_id=v6z7f0e2a9e678c7647ea85661fe5c43da3c8" \
  -F "override-name-exist=true"
```

### Full pipeline summary

1. Generate branded DOCX with `docx_brand.py`
2. Upload to Writer: `POST /writer/api/v1/documents` with `-F "content=@file.docx"`
3. Move to team folder: `PATCH /workdrive/api/v1/files/{id}` with `parent_id`
4. Share: `POST /workdrive/api/v1/links` with password
5. Notify: Cliq DM with Writer open URL

## Existing Examples

Reference these for patterns:
- `docs/legal/generate_cloudflare_regulatory_brief.py` - one-page partner brief (compact table, two-column layout, tight margins)
- `docs/legal/generate_provenance_report.py` - multi-page policy report with tables and callouts
- `docs/shared/generate_template.py` - the .dotx template generator; good reference for injecting custom styles into styles.xml
- `docs/legal/Encypher_Government_Content_Provenance_Report_v1.0.docx` - reference output: normalized fonts, versioned filename, Section 9 priority matrix, recommendations list
- `docs/sales/generate_publisher_onepagers.py` - compact one-pagers (uses older inline helpers, pre-shared-module)

## Common Patterns

**Title page with spacers:**
```python
for _ in range(4):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
add_title(doc, "Title", size=24)
```

**Disclosure/disclaimer callout on title page:**
```python
add_callout(doc, "This document is prepared by Encypher Corporation...")
```

**Numbered recommendations with bold prefix:**
```python
add_numbered(doc, 1, " Description of the recommendation.",
             "Short label. ")
```

**Table with column widths (inches):**
```python
add_table(doc, ["Name", "Status", "Notes"],
          [["Row 1", "Active", "Details"]],
          col_widths=[2.0, 1.0, 3.9], font_size=8)
```
