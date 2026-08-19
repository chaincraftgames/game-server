#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-session-flow.sh — End-to-end smoke test for the game server.
#
# Tests the full session lifecycle:
#   1. Create session (REST)
#   2. Two players join (REST)
#   3. Both connect via WebSocket (wscat)
#   4. Both send "ready" status
#   5. Observe game start (prompts arrive)
#
# Prerequisites:
#   - Game server running on localhost:3001 (npm run dev)
#   - wscat installed (npm i -g wscat)
#   - jq installed (brew install jq)
#
# Usage:
#   ./scripts/test-session-flow.sh [gameId]
#   Default gameId: high-card
# ---------------------------------------------------------------------------

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
GAME_ID="${1:-high-card}"
PLAYER_1="alice"
PLAYER_2="bob"

header() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"; }
ok()     { printf '  \033[1;32m✓ %s\033[0m\n' "$1"; }
fail()   { printf '  \033[1;31m✗ %s\033[0m\n' "$1"; exit 1; }

# ---------------------------------------------------------------------------
# 0. Health check
# ---------------------------------------------------------------------------
header "Health check"
HEALTH=$(curl -sf "$BASE_URL/health")
echo "$HEALTH" | jq .
echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null && ok "Server is up" || fail "Server not responding"

# ---------------------------------------------------------------------------
# 1. List available games
# ---------------------------------------------------------------------------
header "List games"
GAMES=$(curl -sf "$BASE_URL/sessions/games")
echo "$GAMES" | jq .
echo "$GAMES" | jq -e '.games | length > 0' > /dev/null && ok "Games available" || fail "No games found"

# ---------------------------------------------------------------------------
# 2. Create session
# ---------------------------------------------------------------------------
header "Create session (game: $GAME_ID)"
CREATE_RESP=$(curl -sf -X POST "$BASE_URL/sessions/$GAME_ID/session" \
  -H "Content-Type: application/json" \
  -d '{}')
echo "$CREATE_RESP" | jq .

SESSION_ID=$(echo "$CREATE_RESP" | jq -r '.sessionId')
JOIN_CODE=$(echo "$CREATE_RESP" | jq -r '.joinCode')

[[ -n "$SESSION_ID" && "$SESSION_ID" != "null" ]] && ok "Session created: $SESSION_ID" || fail "No sessionId"
[[ -n "$JOIN_CODE"  && "$JOIN_CODE"  != "null" ]] && ok "Join code: $JOIN_CODE"         || fail "No joinCode"

# ---------------------------------------------------------------------------
# 3. Player 1 joins
# ---------------------------------------------------------------------------
header "Player 1 ($PLAYER_1) joins"
JOIN1=$(curl -sf -X POST "$BASE_URL/sessions/$SESSION_ID/join" \
  -H "Content-Type: application/json" \
  -d "{\"playerId\": \"$PLAYER_1\", \"joinCode\": \"$JOIN_CODE\"}")
echo "$JOIN1" | jq .

TOKEN_1=$(echo "$JOIN1" | jq -r '.token')
[[ -n "$TOKEN_1" && "$TOKEN_1" != "null" ]] && ok "Token: $TOKEN_1" || fail "No token for $PLAYER_1"

# ---------------------------------------------------------------------------
# 4. Player 2 joins
# ---------------------------------------------------------------------------
header "Player 2 ($PLAYER_2) joins"
JOIN2=$(curl -sf -X POST "$BASE_URL/sessions/$SESSION_ID/join" \
  -H "Content-Type: application/json" \
  -d "{\"playerId\": \"$PLAYER_2\", \"joinCode\": \"$JOIN_CODE\"}")
echo "$JOIN2" | jq .

TOKEN_2=$(echo "$JOIN2" | jq -r '.token')
[[ -n "$TOKEN_2" && "$TOKEN_2" != "null" ]] && ok "Token: $TOKEN_2" || fail "No token for $PLAYER_2"

# ---------------------------------------------------------------------------
# 5. Error cases — duplicate join & bad join code
# ---------------------------------------------------------------------------
header "Error: duplicate join"
DUP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/sessions/$SESSION_ID/join" \
  -H "Content-Type: application/json" \
  -d "{\"playerId\": \"$PLAYER_1\", \"joinCode\": \"$JOIN_CODE\"}")
DUP_CODE=$(echo "$DUP" | tail -1)
DUP_BODY=$(echo "$DUP" | sed '$d')
echo "$DUP_BODY" | jq .
[[ "$DUP_CODE" == "400" ]] && ok "Correctly rejected duplicate join (400)" || fail "Expected 400, got $DUP_CODE"

header "Error: bad join code"
BAD=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/sessions/$SESSION_ID/join" \
  -H "Content-Type: application/json" \
  -d "{\"playerId\": \"charlie\", \"joinCode\": \"ZZZZ\"}")
BAD_CODE=$(echo "$BAD" | tail -1)
BAD_BODY=$(echo "$BAD" | sed '$d')
echo "$BAD_BODY" | jq .
[[ "$BAD_CODE" == "400" ]] && ok "Correctly rejected bad join code (400)" || fail "Expected 400, got $BAD_CODE"

# ---------------------------------------------------------------------------
# 6. Check state (before game starts — should be empty/initial)
# ---------------------------------------------------------------------------
header "Get session state (pre-game)"
STATE=$(curl -sf "$BASE_URL/sessions/$SESSION_ID/state")
echo "$STATE" | jq .
ok "State retrieved"

# ---------------------------------------------------------------------------
# 7. WebSocket connections — interactive from here
# ---------------------------------------------------------------------------
WS_BASE="${BASE_URL/http/ws}"

header "WebSocket URLs (use wscat to connect)"

WS_URL_1="$WS_BASE/sessions/$SESSION_ID/ws?playerId=$PLAYER_1&playerToken=$TOKEN_1"
WS_URL_2="$WS_BASE/sessions/$SESSION_ID/ws?playerId=$PLAYER_2&playerToken=$TOKEN_2"

echo ""
echo "  Player 1 ($PLAYER_1):"
echo "    wscat -c '$WS_URL_1'"
echo ""
echo "  Player 2 ($PLAYER_2):"
echo "    wscat -c '$WS_URL_2'"
echo ""
echo "  Once both are connected, send ready from each:"
echo '    {"type":"player-status-update","data":{"id":"'"$PLAYER_1"'","status":"ready"}}'
echo '    {"type":"player-status-update","data":{"id":"'"$PLAYER_2"'","status":"ready"}}'
echo ""
echo "  When a prompt arrives, respond with:"
echo '    {"type":"prompt-response","data":{"value":"<your-choice>"}}'
echo ""

# ---------------------------------------------------------------------------
# 8. Automated WebSocket test (if wscat is available)
# ---------------------------------------------------------------------------
if ! command -v wscat &> /dev/null; then
  echo "wscat not found — skipping automated WebSocket test."
  echo "Install with: npm i -g wscat"
  exit 0
fi

header "Automated WebSocket test"

# Use named pipes for coordinating
FIFO_1=$(mktemp -u)
FIFO_2=$(mktemp -u)
OUT_1=$(mktemp)
OUT_2=$(mktemp)
mkfifo "$FIFO_1" "$FIFO_2"

cleanup() {
  exec 3>&- 4>&- 2>/dev/null || true
  kill %1 %2 2>/dev/null || true
  rm -f "$FIFO_1" "$FIFO_2" "$OUT_1" "$OUT_2"
}
trap cleanup EXIT

# Start wscat first — this opens the read end of each FIFO
wscat -c "$WS_URL_1" < "$FIFO_1" > "$OUT_1" 2>&1 &
wscat -c "$WS_URL_2" < "$FIFO_2" > "$OUT_2" 2>&1 &

# Now open write ends (won't block since read ends are open)
exec 3>"$FIFO_1"
exec 4>"$FIFO_2"

# Give connections time to establish and receive pre-game sync
sleep 1

# Send ready via fd so the write end stays open after the echo
echo '{"type":"player-status-update","data":{"id":"'"$PLAYER_1"'","status":"ready"}}' >&3
sleep 0.5
echo '{"type":"player-status-update","data":{"id":"'"$PLAYER_2"'","status":"ready"}}' >&4

# Wait for game to start and first prompts to arrive
sleep 2

# Close write ends so wscat exits gracefully
exec 3>&- 4>&-
sleep 0.5

header "Player 1 received"
cat "$OUT_1"
echo ""

header "Player 2 received"
cat "$OUT_2"
echo ""

ok "WebSocket flow completed — check output above for sync + prompt messages"
