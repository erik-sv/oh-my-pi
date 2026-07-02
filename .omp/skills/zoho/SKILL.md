---
name: zoho
description: Interact with Zoho One services (Cliq messaging, CRM, Sheet, WorkDrive, Mail, and Zoho Writer documents) as Vera (vera.agent@encypher.com). Trigger whenever the user mentions a Zoho doc, Zoho Writer, a Writer document, or asks to create, make, write up, format, share, or send a document and share the link (optionally with a .docx attachment) - as well as to send a Cliq message, read a spreadsheet, search CRM, list WorkDrive files, check email, or any other Zoho-related action.
argument-hint: "[service] [action] [args...]"
user-invocable: true
allowed-tools: Bash, Read, Write
---

# Zoho One API Skill

Interact with Zoho services as **Vera** (vera.agent@encypher.com), a dedicated AI service account with Zoho One access.

## Authentication

All API calls go through the helper script which handles token refresh automatically:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" METHOD URL [curl-args...]
```

Pipe through `jq .` for readable output, or `jq -r '.field'` to extract values.

## Available Services & Endpoints

### Cliq (Team Messaging)

**Send a direct message to a user:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" POST \
  "https://cliq.zoho.com/api/v2/buddies/EMAIL_OR_ZUID/message" \
  -d '{"text":"Your message here"}'
```
Scope: `ZohoCliq.Webhooks.CREATE`. Returns HTTP 204 on success (empty body).

**Send a message to a channel:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" POST \
  "https://cliq.zoho.com/api/v2/channelsbyname/CHANNEL_UNIQUE_NAME/message" \
  -d '{"text":"Your message here"}'
```
Scope: `ZohoCliq.Webhooks.CREATE`. Returns HTTP 204 on success (empty body).

**Send a message to a chat (group or thread):**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" POST \
  "https://cliq.zoho.com/api/v2/chats/CHAT_ID/message" \
  -d '{"text":"Your message here"}'
```

**List users:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://cliq.zoho.com/api/v2/users?limit=100" | jq .
```

**List channels:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://cliq.zoho.com/api/v2/channels" | jq .
```

### CRM (Contacts, Deals, Leads)

**List records from a module:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://www.zohoapis.com/crm/v7/Contacts?fields=Last_Name,Email,Phone&per_page=10" | jq .
```
Modules: `Contacts`, `Deals`, `Leads`, `Accounts`, `Tasks`, `Events`, `Notes`.

**Search records:**
```bash
# By email
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://www.zohoapis.com/crm/v7/Contacts/search?email=someone@example.com" | jq .

# By keyword
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://www.zohoapis.com/crm/v7/Contacts/search?word=encypher" | jq .

# By criteria
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://www.zohoapis.com/crm/v7/Deals/search?criteria=Stage:equals:Qualification" | jq .
```

### Sheet (Spreadsheets)

The Sheet API uses POST with a `method` parameter. The `resource_id` is from the sheet URL: `https://sheet.zoho.com/sheet/open/<resource_id>/...`

**Fetch records (treats sheet as a table with headers):**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" POST \
  "https://sheet.zoho.com/api/v2/RESOURCE_ID" \
  -d 'method=worksheet.records.fetch&worksheet_name=Sheet1&header_row=1&count=100' \
  -H "Content-Type: application/x-www-form-urlencoded" | jq .
```

**List workbooks:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://sheet.zoho.com/api/v2/workbooks" | jq .
```

Note: Sheet API POST endpoints use `application/x-www-form-urlencoded`, not JSON. Add the `-H "Content-Type: application/x-www-form-urlencoded"` override.

### WorkDrive (File Storage)

**List files in a folder:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://www.zohoapis.com/workdrive/api/v1/files/FOLDER_ID/files" | jq .
```

**Get current user info (verify access):**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://workdrive.zoho.com/api/v1/users/me" | jq .
```

**Download a file:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://download-accl.zoho.com/v1/workdrive/download/FILE_ID" > output_file
```

**List team folders:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://www.zohoapis.com/workdrive/api/v1/teams/TEAM_ID/teamfolders" | jq .
```

### Mail

Mail API requires the account ID. Get it first, then use it for all mail calls.

**Get account ID:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://mail.zoho.com/api/accounts" | jq .
```

**List recent emails:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://mail.zoho.com/api/accounts/ACCOUNT_ID/messages/view?folderId=FOLDER_ID&limit=20&sortorder=false" | jq .
```

**Read an email's content:**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-api.sh" GET \
  "https://mail.zoho.com/api/accounts/ACCOUNT_ID/folders/FOLDER_ID/messages/MESSAGE_ID/content" | jq .
```

### Writer (Documents) - create, share, and email formatted docs

Use the dedicated helper for the whole "make a nice formatted doc and send the user the link" flow. It encodes the working endpoints so you don't repeat the long trial-and-error it took to find them:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-doc.sh" <subcommand> [args...]
```

**The easy path to a nice document: write Markdown, let the script convert + upload.** `create`/`deliver` run any text source (`.md`, `.html`, `.txt`, `.rst`, ...) through `pandoc` into a `.docx` before upload, so headings, bold, tables, lists, and links render cleanly in Writer. Native office files (`.docx`, `.doc`, `.odt`, `.rtf`) upload as-is.

**One-shot deliver (create + share + email link with .docx attached):**
```bash
bash "${CLAUDE_SKILL_DIR}/scripts/zoho-doc.sh" deliver \
  --file brief.md --to "person@example.com" \
  --name "Encypher AI Liability Brief (v1.0)" \
  --subject "AI Liability Brief" --body body.html --role editor
```
Prints a JSON summary `{document_id, open_url, shared, email}`. The Writer link is auto-appended to the email body (skipped if your body already contains it) and the editable office file is attached. Flags: `--name`, `--role` (default `editor`), `--subject`, `--body` (file or literal HTML), `--cc`, `--no-share`, `--no-attach`.

**Individual steps:**
```bash
Z="${CLAUDE_SKILL_DIR}/scripts/zoho-doc.sh"
bash "$Z" create  brief.md "Display Name"              # upload -> {document_id, open_url, download_url}
bash "$Z" share   <document_id> "a@x.com,b@x.com" editor   # grant access
bash "$Z" get     <document_id>                        # doc details / link
bash "$Z" export  <document_id> out.pdf                # download as docx|pdf|html|rtf|txt (by extension)
bash "$Z" email   "to@x.com" "Subject" body.html file.docx  # mail with attachment(s)
bash "$Z" trash   <document_id>                        # recoverable (90-day retention)
bash "$Z" delete  <document_id>                        # trash + permanent delete
```

**Hard-won API facts (already baked into the script - do not relearn them):**
- Create from file: `POST {api}/documents` with `-F "content=@file;type=<mime>"` and `-F "filename=<name>"`. Field is `content` (not `document`); the type suffix is mandatory; name the doc with `filename` (`document_name` is rejected, error `R5012`).
- Share: `POST {api}/documents/{id}/collaboration` needs all three of `email_ids` (plural), `role`, and `type=personal`. Valid roles: `editor`, `commenter`, `viewer`, `co_owner`. The read-only role is `viewer` (`reader`/`read`/`view` are rejected).
- Export: `GET {api}/download/{id}?format=docx|pdf|html|rtf|txt` (NOT `/documents/{id}/download`).
- Trash/delete are `DELETE` verbs (`POST` returns "method seems to be invalid").
- `{api}` = `https://www.zohoapis.com/writer/api/v1`. Uploads and mail attachments build their own curl with a token from `zoho-api.sh token`, because the shared wrapper forces `Content-Type: application/json` (which breaks multipart and octet-stream bodies).

### CRM Convenience Commands

The CRM helper script provides high-level commands for common operations:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/crm.sh" <command> [args...]
```

| Command | Description |
|-|-|
| `crm.sh pipeline [owner]` | Show all active deals grouped by stage; optionally filter by Erik or Matt |
| `crm.sh find <query>` | Search across Contacts, Accounts, Leads, and Deals |
| `crm.sh org <name>` | Show org details with linked contacts and deals (360 view) |
| `crm.sh health` | Show all accounts grouped by relationship health (Healthy/Monitor/Paused) |
| `crm.sh stale [days]` | Show open deals with no update in N days (default 14) |
| `crm.sh summary` | Quick pipeline counts by stage and owner |

### CRM Custom Fields Reference

CRM schema is defined in `tools/zoho-crm-config/config/schema.json` and includes:

**Accounts:** Organization_Type, ICP_Segment, Relationship_Health, Relationship_Tier, Pipeline_Category, Coalition_Status, Licensing_Potential, Owner_Internal, C2PA_Awareness, EU_AI_Act_Exposure, Strategic_Notes

**Contacts:** Persona_Type, Decision_Role, Met_In_Person, Met_At_Event, Referral_Source, Standards_Body_Role, LinkedIn_URL

**Deals:** Deal_Type, ICP_Segment, Licensing_Model, Implementation_Fee, Licensing_Revenue_Potential, Rev_Share_Split, Roundtable_Invited, Founding_Member, Sales_Owner

**Leads:** Lead_Quality, Lead_Category, Source_Event, ICP_Match

### CRM Config-as-Code

Schema management tooling lives in `tools/zoho-crm-config/`:

```bash
cd tools/zoho-crm-config
make crm-diff          # Check schema drift against live CRM
make crm-apply         # Apply schema changes (dry run)
make crm-apply-confirm # Apply schema changes (live)
make crm-snapshot      # Export timestamped config snapshot
make crm-export        # Export current config to config/
```

## Argument Parsing

Parse `$ARGUMENTS` to determine which service and action:

| Input | Action |
|-|-|
| `cliq send USER MESSAGE` | Send Cliq DM |
| `cliq channel CHANNEL MESSAGE` | Send to Cliq channel |
| `crm pipeline [owner]` | Show deal pipeline |
| `crm find <query>` | Search across CRM modules |
| `crm org <name>` | Show org 360 view |
| `crm health` | Show relationship health |
| `crm stale [days]` | Show stale deals |
| `crm summary` | Pipeline counts |
| `crm contacts search QUERY` | Search CRM contacts (raw) |
| `crm deals list` | List CRM deals (raw) |
| `sheet read RESOURCE_ID WORKSHEET` | Read sheet data |
| `workdrive ls [FOLDER_ID]` | List WorkDrive files |
| `mail inbox` | List recent emails |
| `mail read MESSAGE_ID` | Read email content |
| `doc deliver --file F --to EMAIL` | Create Writer doc + share + email link/attachment (see Writer section) |
| `doc create FILE [name]` | Upload a file as a Writer document |
| `doc share DOC_ID EMAIL [role]` | Grant collaboration access to a doc |
| (no args or unrecognized) | Show available commands |

## Constraints

- **Vera is the sender.** All actions are attributed to vera.agent@encypher.com in Zoho's audit logs.
- **Confirm before sending.** Always show the user what will be sent (message text, recipient) and ask for confirmation before any POST/PUT/DELETE that sends messages, creates records, or modifies data.
- **Read-first by default.** Prefer GET operations. Only use POST/PUT/DELETE when the user explicitly asks to send, create, or modify something.
- **Token refresh is automatic.** The helper script refreshes the access token on every call. No manual token management needed.
- **Rate limits exist.** Zoho throttles per-user. If you get a 429, wait and retry. Don't loop aggressively.
- **Scope limitations.** If an API returns a scope error, report which scope is missing. The current scopes are: WorkDrive (files.ALL, workspace.ALL, organization.ALL, teamfolders.READ), CRM (modules.ALL, settings.ALL, users.ALL), Sheet (dataAPI.READ, dataAPI.UPDATE), Cliq (Webhooks.CREATE, Channels.CREATE/READ/UPDATE, Messages.READ, Users.READ), Mail (messages.all, folders.all, accounts.all), Writer (documents.CREATE, documentapis.ALL).
- **Cliq message posting uses `ZohoCliq.Webhooks.CREATE` scope**, not Messages.CREATE (which does not exist). Successful sends return HTTP 204 with empty body.
- **Rate limit: 50 requests/min per user** for Cliq message endpoints, with a 10-minute lockout if exceeded.
