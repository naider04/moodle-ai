#!/usr/bin/env bash
# Smoke test for Moodle Viewer.
# Starts the server on an ephemeral port, logs in, exercises the main API
# routes (web service proxy + AI chat), then shuts the server down.
#
# Usage: ./test.sh   (needs .env with credentials, or edit the vars below)
set -u

# Source .env first so its values are available, but keep the ability to pick
# an explicit test port that doesn't collide with other dev servers.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

PORT="${TEST_PORT:-3999}"
BASE="http://localhost:${PORT}"
COOKIES="$(mktemp)"
LOG="$(mktemp)"
PASS=0
FAIL=0

SITE="${TEST_SITE:-${DEFAULT_SITE:-https://aulagradoa.unemi.edu.ec}}"
USER="${TEST_USERNAME:-${DEFAULT_USERNAME:-}}"
PASSWD="${TEST_PASSWORD:-}"

step() { printf '\n== %s\n' "$1"; }
ok()   { PASS=$((PASS+1)); printf '  ok: %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL: %s\n' "$1"; }

if [ -z "$PASSWD" ]; then
  echo "No TEST_PASSWORD set and .env has none — cannot run login test." >&2
  exit 2
fi

PORT="$PORT" node server.js >"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -f "$COOKIES"' EXIT

# Wait for the server.
for i in $(seq 1 30); do
  curl -s "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 0.3
done

step "health"
curl -s "$BASE/api/health" | grep -q '"ok":true' && ok "health check" || bad "health check"

step "config"
CFG=$(curl -s "$BASE/api/config")
echo "$CFG" | grep -q 'aiConfigured' && ok "config exposes aiConfigured" || bad "config"

step "login ($USER @ $SITE)"
LOGIN=$(curl -s -c "$COOKIES" -X POST "$BASE/api/login" \
  -H "Content-Type: application/json" \
  --data-raw "{\"siteUrl\":\"$SITE\",\"username\":\"$USER\",\"password\":\"$PASSWD\"}")
echo "$LOGIN" | grep -q '"ok":true' && ok "login accepted" || bad "login: $LOGIN"

step "me"
ME=$(curl -s -b "$COOKIES" "$BASE/api/me")
echo "$ME" | grep -q '"username"' && ok "session user returned" || bad "me: $ME"

step "ai: providers"
PROVS=$(curl -s -b "$COOKIES" "$BASE/api/ai/providers")
echo "$PROVS" | grep -q '"providers"' && ok "provider list returned" || bad "providers: $PROVS"
if [ -n "${NVIDIA_API_KEY:-}" ]; then
  echo "$PROVS" | grep -qi '"name":"NVIDIA' && ok "built-in NVIDIA provider seeded" || echo "  note: no NVIDIA provider found"
fi
NEWID=$(curl -s -b "$COOKIES" -X POST "$BASE/api/ai/providers" \
  -H "Content-Type: application/json" \
  --data-raw '{"name":"test-prov","baseUrl":"https://example.com/v1","apiKey":"sk-test-12345","model":"test-model"}' \
  | grep -o '"id":"[^"]*"' | tail -1 | cut -d'"' -f4)
[ -n "$NEWID" ] && ok "added custom provider (id $NEWID)" || bad "add provider: $NEWID"
DEL=$(curl -s -b "$COOKIES" -X DELETE "$BASE/api/ai/providers/$NEWID")
echo "$DEL" | grep -q '"ok":true' && ok "deleted custom provider" || bad "delete: $DEL"

step "ws: core_enrol_get_users_courses"
COURSES=$(curl -s -b "$COOKIES" -X POST "$BASE/api/ws" \
  -H "Content-Type: application/json" \
  --data-raw '{"wsfunction":"core_enrol_get_users_courses","params":{"userid":0}}')
COUNT=$(echo "$COURSES" | grep -o '"id"' | wc -l | tr -d ' ')
[ "$COUNT" -gt 0 ] && ok "fetched $COUNT courses" || bad "courses: $(echo "$COURSES" | head -c 200)"

step "ws: core_webservice_get_site_info"
INFO=$(curl -s -b "$COOKIES" -X POST "$BASE/api/ws" \
  -H "Content-Type: application/json" \
  --data-raw '{"wsfunction":"core_webservice_get_site_info"}')
echo "$INFO" | grep -q '"sitename"' && ok "site info returned" || bad "site info"

step "ws: rejected function"
REJ=$(curl -s -b "$COOKIES" -X POST "$BASE/api/ws" \
  -H "Content-Type: application/json" \
  --data-raw '{"wsfunction":"core_user_delete_user","params":{}}')
echo "$REJ" | grep -qi 'not allowed' && ok "allow-list rejects unknown functions" || bad "reject: $REJ"

step "ws: grades"
GRADES=$(curl -s -b "$COOKIES" -X POST "$BASE/api/ws" \
  -H "Content-Type: application/json" \
  --data-raw '{"wsfunction":"gradereport_user_get_grade_items","params":{"userid":0,"courseid":2015}}')
echo "$GRADES" | grep -q '"usergrades"' && ok "grade items returned" || bad "grades: $(echo "$GRADES" | head -c 200)"

if [ -n "${NVIDIA_API_KEY:-}" ]; then
  step "ai: chat with moodle_ws tool"
  AI=$(curl -sN -b "$COOKIES" -X POST "$BASE/api/ai/chat" \
    -H "Content-Type: application/json" \
    --data-raw '{"messages":[{"role":"user","content":"How many courses am I enrolled in? Use the tool and answer with just the number."}]}')
  echo "$AI" | grep -q '"type":"done"' && ok "AI streamed a reply (SSE done event)" || bad "AI: $(echo "$AI" | head -c 300)"
  echo "$AI" | grep -q '"type":"tool"' && ok "AI used the moodle_ws tool (SSE tool event)" || echo "  note: no tool event in stream"
else
  echo "  skipped AI test (NVIDIA_API_KEY not set)"
fi

step "summary"
echo "  passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
