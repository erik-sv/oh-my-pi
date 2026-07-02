#!/usr/bin/env bash
# zoho-doc.sh - Create, share, export, and email Zoho Writer documents as Vera.
#
# Solves the "make a nice formatted Zoho doc and send the user the link" task in
# one place. The recipe below was reverse-engineered from a long trial-and-error
# session; the dead ends are encoded here so you never repeat them:
#
#   * Create-from-file uses field name `content` (NOT `document`) and MUST carry
#     `;type=<mime>`. Naming the doc uses `filename` (NOT `document_name` - that
#     returns R5012 "Unsupported parameters").
#   * Share endpoint is `/documents/{id}/collaboration` (NOT `/collaborate`) and
#     needs ALL THREE of `email_ids` (plural), `role`, and `type=personal`.
#     Valid roles: editor | commenter | viewer | co_owner.  reader/read/view are
#     rejected; the read-only role is `viewer`.
#   * Trash/delete are DELETE verbs (POST returns "method seems to be invalid").
#   * Uploads and mail attachments need their own curl: the shared zoho-api.sh
#     wrapper forces `Content-Type: application/json`, which breaks multipart and
#     octet-stream bodies. We pull a token via `zoho-api.sh token` and build curl
#     ourselves.
#
# Usage:
#   zoho-doc.sh create  <file> [display_name]
#   zoho-doc.sh share   <document_id> <email[,email,...]> [role]      # role default: editor
#   zoho-doc.sh get     <document_id>
#   zoho-doc.sh export  <document_id> <out_file> [format]             # format default: from out_file ext
#   zoho-doc.sh trash   <document_id>
#   zoho-doc.sh delete  <document_id>                                 # trash then permanent delete
#   zoho-doc.sh email   <to[,to,...]> <subject> <body_html_or_file> [attachment ...]
#   zoho-doc.sh deliver --file F --to EMAIL[,EMAIL] [--name N] [--role R]
#                       [--subject S] [--body TEXT_OR_FILE] [--cc EMAIL] [--no-share] [--no-attach]
#
# create/deliver accept .docx/.doc/.odt/.rtf directly and convert text sources
# (.md/.markdown/.html/.htm/.txt/.rst/.org/.tex) to .docx via pandoc first, so
# the easy path to a "nice" doc is: write Markdown, hand it to this script.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZOHO_API="${SELF_DIR}/zoho-api.sh"
WRITER_API="https://www.zohoapis.com/writer/api/v1"
MAIL_API="https://mail.zoho.com/api"
FROM_ADDR="vera.agent@encypher.com"
DOCX_MIME="application/vnd.openxmlformats-officedocument.wordprocessingml.document"

die() { echo "zoho-doc: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
need jq; need curl; need python3
[[ -x "$ZOHO_API" || -f "$ZOHO_API" ]] || die "zoho-api.sh not found beside this script"

token() { bash "$ZOHO_API" token; }

# Temp files (pandoc output) are removed on exit.
TMPFILES=()
# `return 0` is required: an EXIT trap whose last command is falsy (the empty
# array case) would otherwise override a successful script exit status with 1.
cleanup() { local f; for f in "${TMPFILES[@]:-}"; do [[ -n "$f" ]] && rm -f "$f"; done; return 0; }
trap cleanup EXIT

# Lowercase file extension.
ext_of() { local f="$1"; printf '%s' "${f##*.}" | tr '[:upper:]' '[:lower:]'; }

# MIME type for a native (upload-as-is) office document, else empty.
office_mime() {
  case "$1" in
    docx) echo "$DOCX_MIME" ;;
    doc)  echo "application/msword" ;;
    odt)  echo "application/vnd.oasis.opendocument.text" ;;
    rtf)  echo "application/rtf" ;;
    *)    echo "" ;;
  esac
}

# Resolve a source file to an uploadable document. Sets globals PREP_PATH and
# PREP_MIME (call directly - NOT inside $() or the globals are lost to the
# subshell). Native office formats pass through; text formats are converted to
# .docx with pandoc, which is the easy path to a nicely-formatted Writer doc.
prepare_upload() { # <file>
  local src="$1" ext; ext="$(ext_of "$src")"
  [[ -f "$src" ]] || die "file not found: $src"
  local m; m="$(office_mime "$ext")"
  if [[ -n "$m" ]]; then
    PREP_MIME="$m"; PREP_PATH="$src"; return 0
  fi
  case "$ext" in
    md|markdown|html|htm|txt|rst|org|tex)
      need pandoc
      local out; out="$(mktemp --suffix=.docx)"; TMPFILES+=("$out")
      pandoc "$src" -o "$out" >&2 || die "pandoc conversion failed for $src"
      PREP_MIME="$DOCX_MIME"; PREP_PATH="$out"; return 0 ;;
    *) die "unsupported input .$ext (use .docx/.doc/.odt/.rtf or text: .md/.html/.txt/...)" ;;
  esac
}

# json_get <field> -- read a top-level string field from JSON on stdin.
json_get() { python3 -c 'import sys,json;print(json.load(sys.stdin).get(sys.argv[1],"") or "")' "$1"; }

# Upload an already-prepared file as a Writer doc; prints the doc JSON.
_upload_doc() { # <path> <mime> <name>
  local path="$1" mime="$2" name="$3" resp
  resp="$(curl -s -X POST "${WRITER_API}/documents" \
    -H "Authorization: Zoho-oauthtoken $(token)" \
    -F "content=@${path};type=${mime}" \
    -F "filename=${name}")"
  if echo "$resp" | jq -e '.error' >/dev/null 2>&1; then
    die "create failed: $(echo "$resp" | jq -c '.error')"
  fi
  echo "$resp" | jq '{document_id, document_name, open_url, download_url, role}'
}

cmd_create() {
  local file="${1:?usage: create <file> [display_name]}" name="${2:-}"
  [[ -n "$name" ]] || { name="$(basename "$file")"; name="${name%.*}"; }
  prepare_upload "$file"
  _upload_doc "$PREP_PATH" "$PREP_MIME" "$name"
}

cmd_share() {
  local id="${1:?usage: share <document_id> <email[,email]> [role]}" emails="${2:?missing email(s)}" role="${3:-editor}"
  case "$role" in editor|commenter|viewer|co_owner) ;; *) die "invalid role '$role' (use editor|commenter|viewer|co_owner)";; esac
  local resp
  resp="$(curl -s -X POST "${WRITER_API}/documents/${id}/collaboration" \
    -H "Authorization: Zoho-oauthtoken $(token)" \
    -F "email_ids=${emails}" -F "role=${role}" -F "type=personal")"
  if echo "$resp" | jq -e '.error' >/dev/null 2>&1; then
    die "share failed: $(echo "$resp" | jq -c '.error')"
  fi
  echo "$resp" | jq '{shared: .success}'
}

cmd_get() {
  local id="${1:?usage: get <document_id>}"
  bash "$ZOHO_API" GET "${WRITER_API}/documents/${id}" \
    | jq '{document_id, document_name: (.document_name // .title), open_url, download_url, role, is_published}'
}

cmd_export() {
  local id="${1:?usage: export <document_id> <out_file> [format]}" out="${2:?missing out_file}" fmt="${3:-}"
  [[ -n "$fmt" ]] || fmt="$(ext_of "$out")"
  # Export endpoint is /download/{id} (NOT /documents/{id}/download). Supported
  # formats: docx, pdf, html, rtf, txt, zdoc.
  curl -s -X GET "${WRITER_API}/download/${id}?format=${fmt}" \
    -H "Authorization: Zoho-oauthtoken $(token)" -o "$out"
  # A JSON error body (not a binary doc) means the export failed.
  if head -c 1 "$out" | grep -q '{' && jq -e '.error' <"$out" >/dev/null 2>&1; then
    local err; err="$(jq -c '.error' <"$out")"; rm -f "$out"; die "export failed: $err"
  fi
  echo "{\"saved\":\"$out\",\"bytes\":$(wc -c <"$out")}"
}

cmd_trash() {
  local id="${1:?usage: trash <document_id>}"
  curl -s -X DELETE "${WRITER_API}/documents/${id}/trash" \
    -H "Authorization: Zoho-oauthtoken $(token)" | jq -c '{result, message}'
}

cmd_delete() {
  local id="${1:?usage: delete <document_id>}" tok; tok="$(token)"
  curl -s -X DELETE "${WRITER_API}/documents/${id}/trash"  -H "Authorization: Zoho-oauthtoken ${tok}" >/dev/null
  curl -s -X DELETE "${WRITER_API}/documents/${id}/delete" -H "Authorization: Zoho-oauthtoken ${tok}" | jq -c '{result, message}'
}

# Resolve the Mail account id for FROM_ADDR (cached per invocation tree via env).
mail_account_id() {
  if [[ -n "${ZOHO_MAIL_ACCOUNT_ID:-}" ]]; then echo "$ZOHO_MAIL_ACCOUNT_ID"; return; fi
  bash "$ZOHO_API" GET "${MAIL_API}/accounts" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];a=[x for x in d if x.get("primaryEmailAddress")=="'"$FROM_ADDR"'"] or d;print(a[0]["accountId"])'
}

# Upload one file as a mail attachment; echo the attachment descriptor JSON.
mail_upload_attachment() { # <account_id> <file>
  local acc="$1" file="$2" name; name="$(basename "$file")"
  local enc; enc="$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$name")"
  curl -s -X POST "${MAIL_API}/accounts/${acc}/messages/attachments?fileName=${enc}" \
    -H "Authorization: Zoho-oauthtoken $(token)" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$file" | jq -c '.data'
}

# Send an html email. Args via env: TO, CC, SUBJECT, BODY_HTML, ATTACH_JSON (a JSON array).
mail_send() {
  local acc; acc="$(mail_account_id)"
  ATTACH_JSON="${ATTACH_JSON:-[]}" python3 - "$acc" "$FROM_ADDR" "$(token)" <<'PY'
import json, os, subprocess, sys
acc, frm, tok = sys.argv[1], sys.argv[2], sys.argv[3]
payload = {
    "fromAddress": frm,
    "toAddress": os.environ["TO"],
    "subject": os.environ["SUBJECT"],
    "content": os.environ["BODY_HTML"],
    "mailFormat": "html",
}
if os.environ.get("CC"):
    payload["ccAddress"] = os.environ["CC"]
att = json.loads(os.environ.get("ATTACH_JSON", "[]"))
if att:
    payload["attachments"] = [
        {"storeName": a["storeName"], "attachmentName": a["attachmentName"], "attachmentPath": a["attachmentPath"]}
        for a in att
    ]
r = subprocess.run(
    ["curl", "-s", "-X", "POST", f"https://mail.zoho.com/api/accounts/{acc}/messages",
     "-H", f"Authorization: Zoho-oauthtoken {tok}", "-H", "Content-Type: application/json",
     "-d", json.dumps(payload)],
    capture_output=True, text=True)
try:
    d = json.loads(r.stdout)
except Exception:
    print(json.dumps({"error": "non-json mail response", "raw": r.stdout[:300]})); sys.exit(1)
if d.get("status", {}).get("code") != 200:
    print(json.dumps({"error": d})); sys.exit(1)
data = d.get("data", {})
print(json.dumps({"messageId": data.get("messageId"), "subject": data.get("subject"), "toAddress": data.get("toAddress")}))
PY
}

# Read a "body" arg that is either a path to a file or a literal HTML/text string.
read_body() { local b="$1"; if [[ -f "$b" ]]; then cat "$b"; else printf '%s' "$b"; fi; }

cmd_email() {
  local to="${1:?usage: email <to> <subject> <body> [attachment ...]}" subject="${2:?missing subject}" body="${3:?missing body}"
  shift 3
  local acc; acc="$(mail_account_id)"
  local arr="[]"
  for f in "$@"; do
    [[ -f "$f" ]] || die "attachment not found: $f"
    local d; d="$(mail_upload_attachment "$acc" "$f")"
    [[ -n "$d" && "$d" != "null" ]] || die "attachment upload failed: $f"
    arr="$(jq -c --argjson a "$d" '. + [$a]' <<<"$arr")"
  done
  TO="$to" SUBJECT="$subject" BODY_HTML="$(read_body "$body")" ATTACH_JSON="$arr" mail_send
}

cmd_deliver() {
  local file="" to="" name="" role="editor" subject="" body="" cc="" share=1 attach=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --file)    file="$2"; shift 2 ;;
      --to)      to="$2"; shift 2 ;;
      --name)    name="$2"; shift 2 ;;
      --role)    role="$2"; shift 2 ;;
      --subject) subject="$2"; shift 2 ;;
      --body)    body="$2"; shift 2 ;;
      --cc)      cc="$2"; shift 2 ;;
      --no-share)  share=0; shift ;;
      --no-attach) attach=0; shift ;;
      *) die "deliver: unknown option '$1'" ;;
    esac
  done
  [[ -n "$file" ]] || die "deliver: --file is required"
  [[ -n "$to" ]] || die "deliver: --to is required"
  [[ -n "$name" ]] || { name="$(basename "$file")"; name="${name%.*}"; }
  [[ -n "$subject" ]] || subject="$name"

  # 1. Prepare the source ONCE (in this shell, so the temp is cleaned on exit),
  #    then create the Writer doc and reuse the same file as the attachment.
  prepare_upload "$file"
  local upload_path="$PREP_PATH"
  local created; created="$(_upload_doc "$PREP_PATH" "$PREP_MIME" "$name")"
  local id open_url; id="$(echo "$created" | json_get document_id)"; open_url="$(echo "$created" | json_get open_url)"
  [[ -n "$id" ]] || die "deliver: create returned no document_id"

  # 2. Grant collaboration access.
  local shared='"skipped"'
  if [[ "$share" == "1" ]]; then
    shared="$(cmd_share "$id" "$to" "$role" | jq -c '.shared')" || true
  fi

  # 3. Email the link, attaching the source .docx (the editable office file).
  local body_html footer
  footer="<p><b>Zoho Writer (${role} access shared):</b><br><a href=\"${open_url}\">${open_url}</a>"
  [[ "$attach" == "1" ]] && footer="${footer}<br>The document is attached."
  footer="${footer}</p>"
  body_html="$( [[ -n "$body" ]] && read_body "$body" )"
  # Avoid duplicating the link if the author already pasted it into the body.
  if [[ "$body_html" != *"$open_url"* ]]; then body_html="${body_html}${footer}"; fi

  local att_args=()
  # Attach the editable office file we just uploaded (original, or the docx
  # pandoc produced from a text source).
  [[ "$attach" == "1" ]] && att_args=("$upload_path")
  local sent
  sent="$(CC="$cc" cmd_email "$to" "$subject" "$body_html" "${att_args[@]}")"

  python3 -c 'import json,sys;print(json.dumps({"document_id":sys.argv[1],"open_url":sys.argv[2],"shared":json.loads(sys.argv[3]),"email":json.loads(sys.argv[4])},indent=1))' \
    "$id" "$open_url" "${shared:-null}" "$sent"
}

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

main() {
  local sub="${1:-help}"; shift || true
  case "$sub" in
    create)  cmd_create "$@" ;;
    share)   cmd_share "$@" ;;
    get)     cmd_get "$@" ;;
    export)  cmd_export "$@" ;;
    trash)   cmd_trash "$@" ;;
    delete)  cmd_delete "$@" ;;
    email)   cmd_email "$@" ;;
    deliver) cmd_deliver "$@" ;;
    help|-h|--help) usage ;;
    *) usage; die "unknown subcommand: $sub" ;;
  esac
}
main "$@"
