#!/usr/bin/env bash
# CRM convenience commands for the Zoho skill.
# Usage: bash crm.sh <command> [args...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZOHO_API="bash $SCRIPT_DIR/zoho-api.sh"

cmd="${1:-help}"
shift 2>/dev/null || true

case "$cmd" in

  pipeline)
    # Show active deals grouped by stage
    OWNER="${1:-}"
    QUERY="https://www.zohoapis.com/crm/v7/Deals?per_page=100&fields=Deal_Name,Stage,Account_Name,Deal_Type,ICP_Segment,Sales_Owner,Closing_Date"

    RESULT=$($ZOHO_API GET "$QUERY" 2>/dev/null)
    COUNT=$(echo "$RESULT" | jq '.data | length // 0' 2>/dev/null || echo 0)

    if [[ "$COUNT" == "0" ]]; then
      echo "No deals found."
      exit 0
    fi

    if [[ -n "$OWNER" ]]; then
      echo "=== Pipeline: $OWNER ==="
      echo "$RESULT" | jq -r --arg owner "$OWNER" '
        [.data[] | select(.Sales_Owner == $owner)] |
        group_by(.Stage) |
        .[] |
        "\n--- \(.[0].Stage) (\(length) deal\(if length > 1 then "s" else "" end)) ---" +
        ([.[] | "  \(.Deal_Name)\n    Account: \(.Account_Name.name // "unlinked") | Type: \(.Deal_Type // "-") | ICP: \(.ICP_Segment // "-")"] | join("\n"))
      ' 2>/dev/null
    else
      echo "=== Full Pipeline ==="
      echo "$RESULT" | jq -r '
        .data |
        group_by(.Stage) |
        .[] |
        "\n--- \(.[0].Stage) (\(length) deal\(if length > 1 then "s" else "" end)) ---" +
        ([.[] | "  \(.Deal_Name) [\(.Sales_Owner // "-")]" +
         "\n    Account: \(.Account_Name.name // "unlinked") | Type: \(.Deal_Type // "-") | ICP: \(.ICP_Segment // "-")"] | join("\n"))
      ' 2>/dev/null
    fi
    ;;

  find)
    # Search across Contacts, Leads, Accounts by name or email
    QUERY="${1:-}"
    if [[ -z "$QUERY" ]]; then
      echo "Usage: crm.sh find <name or email>"
      exit 1
    fi

    echo "=== CRM Search: $QUERY ==="

    echo ""
    echo "--- Contacts ---"
    C_RESULT=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Contacts/search?word=$(echo "$QUERY" | jq -Rr @uri)&per_page=10" 2>/dev/null)
    C_COUNT=$(echo "$C_RESULT" | jq '.data | length // 0' 2>/dev/null || echo 0)
    if [[ "$C_COUNT" -gt 0 ]]; then
      echo "$C_RESULT" | jq -r '.data[] | "  \(.First_Name // "") \(.Last_Name) - \(.Email // "no email") | \(.Title // "-") @ \(.Account_Name.name // "-") | Persona: \(.Persona_Type // "-") | Role: \(.Decision_Role // "-")"' 2>/dev/null
    else
      echo "  (none)"
    fi

    echo ""
    echo "--- Accounts ---"
    A_RESULT=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Accounts/search?word=$(echo "$QUERY" | jq -Rr @uri)&per_page=10" 2>/dev/null)
    A_COUNT=$(echo "$A_RESULT" | jq '.data | length // 0' 2>/dev/null || echo 0)
    if [[ "$A_COUNT" -gt 0 ]]; then
      echo "$A_RESULT" | jq -r '.data[] | "  \(.Account_Name) | Type: \(.Organization_Type // "-") | ICP: \(.ICP_Segment // "-") | Health: \(.Relationship_Health // "-") | Owner: \(.Owner_Internal // "-")"' 2>/dev/null
    else
      echo "  (none)"
    fi

    echo ""
    echo "--- Leads ---"
    L_RESULT=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Leads/search?word=$(echo "$QUERY" | jq -Rr @uri)&per_page=10" 2>/dev/null)
    L_COUNT=$(echo "$L_RESULT" | jq '.data | length // 0' 2>/dev/null || echo 0)
    if [[ "$L_COUNT" -gt 0 ]]; then
      echo "$L_RESULT" | jq -r '.data[] | "  \(.First_Name // "") \(.Last_Name) - \(.Email // "no email") | \(.Company // "-") | Quality: \(.Lead_Quality // "-") | ICP: \(.ICP_Match // "-")"' 2>/dev/null
    else
      echo "  (none)"
    fi

    echo ""
    echo "--- Deals ---"
    D_RESULT=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Deals/search?word=$(echo "$QUERY" | jq -Rr @uri)&per_page=10" 2>/dev/null)
    D_COUNT=$(echo "$D_RESULT" | jq '.data | length // 0' 2>/dev/null || echo 0)
    if [[ "$D_COUNT" -gt 0 ]]; then
      echo "$D_RESULT" | jq -r '.data[] | "  \(.Deal_Name) | Stage: \(.Stage) | Type: \(.Deal_Type // "-") | Owner: \(.Sales_Owner // "-")"' 2>/dev/null
    else
      echo "  (none)"
    fi
    ;;

  org)
    # Show Account details + linked Contacts + Deals
    ORG_NAME="${1:-}"
    if [[ -z "$ORG_NAME" ]]; then
      echo "Usage: crm.sh org <organization name>"
      exit 1
    fi

    echo "=== Organization: $ORG_NAME ==="

    # Find account
    ACC_RESULT=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Accounts/search?word=$(echo "$ORG_NAME" | jq -Rr @uri)" 2>/dev/null)
    ACC_COUNT=$(echo "$ACC_RESULT" | jq '.data | length // 0' 2>/dev/null || echo 0)

    if [[ "$ACC_COUNT" == "0" ]]; then
      echo "  Account not found."
      exit 0
    fi

    ACC_ID=$(echo "$ACC_RESULT" | jq -r '.data[0].id')

    echo ""
    echo "--- Account Details ---"
    echo "$ACC_RESULT" | jq -r '.data[0] | "  Name: \(.Account_Name)\n  Type: \(.Organization_Type // "-")\n  ICP: \(.ICP_Segment // "-")\n  Health: \(.Relationship_Health // "-")\n  Tier: \(.Relationship_Tier // "-")\n  Category: \(.Pipeline_Category // "-")\n  Coalition: \(.Coalition_Status // "-")\n  Owner: \(.Owner_Internal // "-")\n  C2PA: \(.C2PA_Awareness // "-")\n  Notes: \(.Strategic_Notes // "-")"' 2>/dev/null

    # Find linked contacts
    echo ""
    echo "--- Contacts ---"
    CONTACTS=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Contacts/search?criteria=Account_Name:equals:$ACC_ID&per_page=50" 2>/dev/null)
    C_COUNT=$(echo "$CONTACTS" | jq '.data | length // 0' 2>/dev/null || echo 0)
    if [[ "$C_COUNT" -gt 0 ]]; then
      echo "$CONTACTS" | jq -r '.data[] | "  \(.First_Name // "") \(.Last_Name) - \(.Email // "no email")\n    Title: \(.Title // "-") | Persona: \(.Persona_Type // "-") | Role: \(.Decision_Role // "-") | Met: \(.Met_In_Person // false)"' 2>/dev/null
    else
      echo "  (none linked)"
    fi

    # Find linked deals
    echo ""
    echo "--- Deals ---"
    DEALS=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Deals/search?criteria=Account_Name:equals:$ACC_ID&per_page=50" 2>/dev/null)
    D_COUNT=$(echo "$DEALS" | jq '.data | length // 0' 2>/dev/null || echo 0)
    if [[ "$D_COUNT" -gt 0 ]]; then
      echo "$DEALS" | jq -r '.data[] | "  \(.Deal_Name)\n    Stage: \(.Stage) | Type: \(.Deal_Type // "-") | Owner: \(.Sales_Owner // "-")"' 2>/dev/null
    else
      echo "  (none)"
    fi
    ;;

  health)
    # Show all accounts grouped by health status
    echo "=== Relationship Health Overview ==="
    RESULT=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Accounts?per_page=100&fields=Account_Name,Relationship_Health,Relationship_Tier,Organization_Type,Owner_Internal,ICP_Segment" 2>/dev/null)

    for health in Healthy Monitor Paused; do
      FILTERED=$(echo "$RESULT" | jq --arg h "$health" '[.data[] | select(.Relationship_Health == $h)]' 2>/dev/null)
      COUNT=$(echo "$FILTERED" | jq 'length' 2>/dev/null)
      echo ""
      echo "--- $health ($COUNT) ---"
      echo "$FILTERED" | jq -r '.[] | "  [\(.Relationship_Tier // "-")] \(.Account_Name) | \(.Organization_Type // "-") | \(.ICP_Segment // "-") | Owner: \(.Owner_Internal // "-")"' 2>/dev/null
    done
    ;;

  stale)
    # Show deals that may need attention (no recent modification)
    DAYS="${1:-14}"
    echo "=== Stale Deals (no update in $DAYS+ days) ==="
    CUTOFF=$(date -d "-$DAYS days" +%Y-%m-%dT00:00:00+00:00 2>/dev/null || date -v-${DAYS}d +%Y-%m-%dT00:00:00+00:00 2>/dev/null)

    RESULT=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Deals?per_page=100&fields=Deal_Name,Stage,Account_Name,Sales_Owner,Modified_Time" 2>/dev/null)

    echo "$RESULT" | jq -r --arg cutoff "$CUTOFF" '
      [.data[] | select(.Stage != "Closed Won" and .Stage != "Closed Lost" and .Modified_Time < $cutoff)] |
      if length == 0 then "  No stale deals found."
      else .[] | "  \(.Deal_Name)\n    Stage: \(.Stage) | Owner: \(.Sales_Owner // "-") | Last modified: \(.Modified_Time | split("T")[0])"
      end
    ' 2>/dev/null
    ;;

  summary)
    # Quick pipeline summary counts
    echo "=== Pipeline Summary ==="
    DEALS=$($ZOHO_API GET "https://www.zohoapis.com/crm/v7/Deals?per_page=100&fields=Stage,Sales_Owner" 2>/dev/null)

    echo ""
    echo "By Stage:"
    echo "$DEALS" | jq -r '.data | group_by(.Stage) | .[] | "  \(.[0].Stage): \(length)"' 2>/dev/null

    echo ""
    echo "By Owner:"
    echo "$DEALS" | jq -r '.data | group_by(.Sales_Owner) | .[] | "  \(.[0].Sales_Owner // "unassigned"): \(length)"' 2>/dev/null

    echo ""
    TOTAL=$(echo "$DEALS" | jq '.data | length' 2>/dev/null)
    echo "Total active deals: $TOTAL"
    ;;

  help|*)
    echo "Zoho CRM Commands:"
    echo "  crm.sh pipeline [owner]    - Show deals grouped by stage (optionally filter by Erik/Matt)"
    echo "  crm.sh find <query>        - Search across Contacts, Accounts, Leads, Deals"
    echo "  crm.sh org <name>          - Show org details with linked contacts and deals"
    echo "  crm.sh health              - Show accounts grouped by relationship health"
    echo "  crm.sh stale [days]        - Show deals with no update in N days (default 14)"
    echo "  crm.sh summary             - Quick pipeline counts by stage and owner"
    ;;
esac
