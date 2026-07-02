#!/usr/bin/env bash
# Authenticated Zoho API caller for Vera (vera.agent@encypher.com)
# Usage: zoho-api.sh METHOD URL [curl-args...]
# Example: zoho-api.sh GET "https://cliq.zoho.com/api/v2/users"
# Example: zoho-api.sh POST "https://cliq.zoho.com/api/v2/users/user@example.com/message" -d '{"text":"Hello"}'
set -euo pipefail

ENV_FILE="$HOME/.config/encypher/zoho-vera.env"
TOKEN_CACHE="$HOME/.config/encypher/zoho-vera-token.json"

if [[ ! -f "$ENV_FILE" ]]; then
  echo '{"error":"Zoho credentials not found. Run: bash scripts/setup-zoho-vera.sh"}'
  exit 1
fi

source "$ENV_FILE"

# Check for cached token (valid for ~1 hour; we refresh 5 minutes early)
ACCESS_TOKEN=""
if [[ -f "$TOKEN_CACHE" ]]; then
  CACHED_EXPIRES=$(jq -r '.expires_at // 0' "$TOKEN_CACHE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if (( NOW < CACHED_EXPIRES )); then
    ACCESS_TOKEN=$(jq -r '.access_token // empty' "$TOKEN_CACHE" 2>/dev/null || true)
  fi
fi

# Refresh if no valid cached token
if [[ -z "$ACCESS_TOKEN" ]]; then
  TOKEN_RESPONSE=$(curl -s -X POST "${ZOHO_ACCOUNT_SERVER}/oauth/v2/token" \
    -d "refresh_token=${ZOHO_REFRESH_TOKEN}" \
    -d "client_id=${ZOHO_CLIENT_ID}" \
    -d "client_secret=${ZOHO_CLIENT_SECRET}" \
    -d "grant_type=refresh_token")

  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')

  if [[ -z "$ACCESS_TOKEN" ]]; then
    echo '{"error":"Token refresh failed","details":'"$TOKEN_RESPONSE"'}'
    exit 1
  fi

  # Cache token with expiry (default 3600s minus 300s buffer = 3300s)
  EXPIRES_IN=$(echo "$TOKEN_RESPONSE" | jq -r '.expires_in // 3600')
  NOW=$(date +%s)
  EXPIRES_AT=$(( NOW + EXPIRES_IN - 300 ))

  mkdir -p "$(dirname "$TOKEN_CACHE")"
  jq -n --arg token "$ACCESS_TOKEN" --argjson expires "$EXPIRES_AT" \
    '{access_token: $token, expires_at: $expires}' > "$TOKEN_CACHE"
fi

# `token` subcommand: print a valid (refreshed-if-needed) access token to stdout.
# Use this from scripts that must build their own curl - multipart uploads
# (Writer doc create) and octet-stream attachments (Mail) break under the forced
# `Content-Type: application/json` header this wrapper applies to normal calls.
#   TOK=$(zoho-api.sh token)
if [[ "${1:-}" == "token" ]]; then
  echo "$ACCESS_TOKEN"
  exit 0
fi

METHOD="$1"
URL="$2"
shift 2

exec curl -s -X "$METHOD" "$URL" \
  -H "Authorization: Zoho-oauthtoken ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  "$@"
