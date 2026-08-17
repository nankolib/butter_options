#!/usr/bin/env bash
# Opta upstream-RPC alarm — ticket 86eyn66b4.
#
# WHY THIS EXISTS
#   On 2026-08-16 15:44:28 UTC the paid upstream RPC ran out of credits. Every
#   consumer (crank, taker, trigger, indexer, writer, and the browser/mobile
#   proxy) started failing and nothing told us. 5,543 proxied requests returned
#   429 to real clients before a human noticed.
#
# WHY getBalance AND NOT getHealth
#   getHealth is authentication-blind. Measured 2026-08-17 against a completely
#   fake api-key, the upstream returned:
#       HTTP 200  {"id":1,"jsonrpc":"2.0","result":"ok"}
#   A getHealth probe is therefore green while the key is dead. getBalance is
#   authenticated and bills 1 credit, so it exercises the real auth+credit path.
#   Do not "optimise" this back to getHealth.
#
# STATES (every signature below was captured empirically, 2026-08-17)
#   OK                 http 200, curl exit 0, numeric result.value
#   CREDITS_EXHAUSTED  http 429 AND body carries -32429 / "max usage reached"
#   RATE_LIMITED       http 429 WITHOUT -32429  -> transient per-second throttle
#   KEY_INVALID        http 401 AND body carries -32401
#   NETWORK            curl exit != 0 (6 dns, 7 refused, 28 timeout), http 000
#
#   The 429 split matters: the client libraries print a bare
#   "Server responded with 429 Too Many Requests" for ordinary throttling, so
#   status alone cannot tell a burst apart from real exhaustion. Classifying on
#   status alone would page on every traffic spike. The JSON body is the only
#   reliable discriminator.
#
# SECRET HANDLING
#   The upstream URL (which embeds the api-key) arrives ONLY via the environment,
#   from systemd's EnvironmentFile= which systemd reads as root BEFORE dropping
#   to User=opta. The key is therefore never on a command line, never in argv,
#   never logged, and not readable by the opta user on disk. Every log/alert line
#   below is scrubbed through redact().
#
# USER-FACING NAMING
#   Alerts say "upstream RPC". The vendor name is deliberately absent from every
#   emitted string.
set -uo pipefail

PROBE_ADDR="${OPTA_ALARM_PROBE_ADDR:-5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk}"
TIMEOUT="${OPTA_ALARM_TIMEOUT:-15}"
NTFY_URL="${OPTA_ALARM_NTFY_URL:-}"
STATE_FILE="${OPTA_ALARM_STATE_FILE:-/var/lib/opta-rpc-alarm/last_state}"

# Redact anything key-shaped before it can reach a log, an alert, or a terminal.
redact() {
  sed -E 's/(api-key=|api_key=|apikey=)[A-Za-z0-9_-]+/\1<REDACTED>/gi;
          s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<REDACTED>/gi'
}

if [ -z "${OPTA_ALARM_RPC_URL:-}" ]; then
  echo "FATAL: OPTA_ALARM_RPC_URL unset (expected from EnvironmentFile)" >&2
  exit 78 # EX_CONFIG
fi

REQ="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"${PROBE_ADDR}\"]}"

# -s so curl's own progress/error text can never carry the URL into a log.
BODY=$(curl -s -m "$TIMEOUT" -X POST "$OPTA_ALARM_RPC_URL" \
  -H 'Content-Type: application/json' -d "$REQ" \
  -w '\n__HTTP__%{http_code}' 2>/dev/null)
CURL_EXIT=$?

HTTP=$(printf '%s' "$BODY" | sed -n 's/.*__HTTP__\([0-9]*\)$/\1/p' | tail -1)
BODY=$(printf '%s' "$BODY" | sed 's/__HTTP__[0-9]*$//')
[ -z "$HTTP" ] && HTTP=000

classify() {
  local exit_code="$1" http="$2" body="$3"

  # Transport failure first: a non-zero curl exit means we never got an answer,
  # so the body is meaningless and must not be inspected.
  if [ "$exit_code" -ne 0 ]; then
    echo "NETWORK"; return
  fi

  case "$http" in
    429)
      if printf '%s' "$body" | grep -qE -- '-32429|max usage reached'; then
        echo "CREDITS_EXHAUSTED"
      else
        echo "RATE_LIMITED"
      fi
      return
      ;;
    401|403)
      if printf '%s' "$body" | grep -qE -- '-32401|[Ii]nvalid api key|missing api key'; then
        echo "KEY_INVALID"
      else
        echo "KEY_INVALID"
      fi
      return
      ;;
    200)
      # A 200 is only OK if it actually carries a numeric balance. A 200 with a
      # JSON-RPC error body is NOT healthy.
      if printf '%s' "$body" | grep -qE '"value"[[:space:]]*:[[:space:]]*[0-9]+'; then
        echo "OK"
      else
        echo "DEGRADED"
      fi
      return
      ;;
    000) echo "NETWORK"; return ;;
    *)   echo "DEGRADED"; return ;;
  esac
}

STATE=$(classify "$CURL_EXIT" "$HTTP" "$BODY")
SAFE_BODY=$(printf '%s' "$BODY" | head -c 300 | tr -d '\n' | redact)

# Structured line to journald. This is the channel the -32429 watcher reads.
echo "{\"svc\":\"opta-rpc-alarm\",\"state\":\"${STATE}\",\"http\":\"${HTTP}\",\"curl_exit\":${CURL_EXIT},\"body\":\"$(printf '%s' "$SAFE_BODY" | sed 's/"/\\"/g')\"}"

notify() {
  local title="$1" msg="$2" prio="$3"
  # Backup channel first: always lands in syslog even if the network is the thing
  # that is broken.
  logger -t opta-rpc-alarm -p daemon.err "${title}: ${msg}"
  if [ -n "$NTFY_URL" ]; then
    curl -s -m 10 \
      -H "Title: ${title}" \
      -H "Priority: ${prio}" \
      -H "Tags: rotating_light" \
      -d "${msg}" "$NTFY_URL" >/dev/null 2>&1 \
      || logger -t opta-rpc-alarm -p daemon.err "ntfy delivery FAILED for: ${title}"
  fi
}

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null
PREV=$(cat "$STATE_FILE" 2>/dev/null || echo "UNKNOWN")
printf '%s' "$STATE" > "$STATE_FILE" 2>/dev/null

case "$STATE" in
  OK)
    # Recovery notice only on transition, so a healthy box stays silent.
    if [ "$PREV" != "OK" ] && [ "$PREV" != "UNKNOWN" ]; then
      notify "Opta RPC recovered" "upstream RPC is answering again (was ${PREV})" "default"
    fi
    exit 0
    ;;
  RATE_LIMITED)
    # Transient by definition — log, never page.
    logger -t opta-rpc-alarm -p daemon.warning "upstream RPC throttled (transient 429, no credit exhaustion)"
    exit 0
    ;;
  CREDITS_EXHAUSTED)
    notify "Opta RPC CREDITS EXHAUSTED" \
      "upstream RPC credit allowance is spent. All cranks, the trigger keeper and the web/mobile proxy are failing. Top up or raise the plan now." "urgent"
    exit 1
    ;;
  KEY_INVALID)
    notify "Opta RPC KEY INVALID" \
      "upstream RPC rejected our credential (http ${HTTP}). This is an auth failure, not a quota failure." "urgent"
    exit 1
    ;;
  NETWORK)
    notify "Opta RPC UNREACHABLE" \
      "cannot reach the upstream RPC at all (curl exit ${CURL_EXIT}). Network or DNS." "high"
    exit 1
    ;;
  *)
    notify "Opta RPC DEGRADED" \
      "unexpected upstream response (http ${HTTP}). Body: ${SAFE_BODY}" "high"
    exit 1
    ;;
esac
