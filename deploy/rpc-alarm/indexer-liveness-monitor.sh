#!/usr/bin/env bash
# Indexer liveness monitor — the /trade grid now depends on this service.
#
# WHY THIS AND NOT `Restart=always`
#   Restart= would not have prevented the outage that prompted it. systemd NEVER
#   auto-restarts after an explicit `systemctl stop`, and that is exactly how the
#   indexer was left down: a shutdown test succeeded and nothing brought it back.
#   Restart=always covers only an unexpected clean exit — a narrower case than
#   the one that actually happened, and it cannot see the broader one at all.
#
#   Nor is `systemctl is-active` the signal, for the reason the keeper monitor
#   beside this one already documents: a node process can sit alive with a wedged
#   loop and systemd reports it healthy forever.
#
# THE SIGNAL
#   `/api/chain/meta` — the same endpoint the FE reads before trusting the read
#   path. One probe covers every failure that matters, and they are different
#   failures:
#
#     unreachable     process down, or the event loop wedged
#     healthy=false   refreshing too slowly, or a scan erroring out
#     stale per type  one account type falling behind the others
#
#   Checking what the FE checks means the monitor cannot be green while the page
#   is degraded — which is the failure mode a service-level probe would miss.
#
# WHAT DEGRADED ACTUALLY COSTS
#   Not an outage: the FE falls back to direct chain scans by design. The page
#   gets slow (~14s), not broken. So this pages HIGH, not urgent — reserving
#   urgent for the keeper, where silence means someone's stop-loss is unwatched.
#   A monitor that cries wolf gets muted, and a muted monitor is not a monitor.
#
# COST
#   One local HTTP request. Zero RPC credits — deliberate, on the box that once
#   burned 98.6% of all gPA traffic.
set -uo pipefail

URL="${OPTA_INDEXER_META_URL:-http://127.0.0.1:8791/api/chain/meta}"
UNIT="${OPTA_INDEXER_UNIT:-opta-indexer}"
NTFY="${OPTA_ALARM_NTFY_URL:-}"
STATE="${OPTA_INDEXER_LIVENESS_STATE:-/var/lib/opta-rpc-alarm/indexer_liveness_state}"
MARKER="${OPTA_INDEXER_LIVENESS_MARKER:-/var/lib/opta-rpc-alarm/indexer_liveness_alert}"
COOLDOWN_S="${OPTA_INDEXER_COOLDOWN_S:-1800}"
# Startup blocks the event loop for a few minutes while SQLite work completes, so
# a probe during that window legitimately fails. Tolerated via the grace check
# below rather than by a longer timeout, which would only hide it.
STARTUP_GRACE_S="${OPTA_INDEXER_STARTUP_GRACE_S:-360}"

BODY=$(curl -s -m 10 "$URL" 2>/dev/null || true)

if [ -z "$BODY" ]; then
  STATE_NOW=UNREACHABLE
  DETAIL="no response from $URL"
  HEALTHY=unknown
  STALE_KINDS=""
else
  HEALTHY=$(printf '%s' "$BODY" | grep -oE '"healthy":(true|false)' | cut -d: -f2)
  HEALTHY=${HEALTHY:-unknown}
  # Name the types that are stale, so the page says WHICH rather than "something".
  STALE_KINDS=$(printf '%s' "$BODY" \
    | grep -oE '"[a-zA-Z]+":\{"slot":[0-9]+,"refreshedAt":[0-9]+,"ageSec":-?[0-9]+,"stale":true' \
    | grep -oE '^"[a-zA-Z]+"' | tr -d '"' | paste -sd, - 2>/dev/null || true)
  OLDEST=$(printf '%s' "$BODY" | grep -oE '"oldestAgeSec":-?[0-9]+' | cut -d: -f2)
  OLDEST=${OLDEST:-unknown}
  if [ "$HEALTHY" = "true" ]; then
    STATE_NOW=OK
    DETAIL="oldest age ${OLDEST}s"
  else
    STATE_NOW=DEGRADED
    DETAIL="oldest age ${OLDEST}s; stale: ${STALE_KINDS:-none reported}"
  fi
fi

# A restart legitimately fails this probe for a few minutes. Suppress only the
# UNREACHABLE case during that window — a service that is UP but reporting
# unhealthy is a real signal even shortly after boot.
UPTIME_S=0
ACTIVE_TS=$(systemctl show -p ActiveEnterTimestamp --value "$UNIT" 2>/dev/null || true)
if [ -n "$ACTIVE_TS" ]; then
  AT_EPOCH=$(date -d "$ACTIVE_TS" +%s 2>/dev/null || echo 0)
  [ "$AT_EPOCH" -gt 0 ] && UPTIME_S=$(( $(date +%s) - AT_EPOCH ))
fi

echo "{\"svc\":\"opta-indexer-liveness\",\"state\":\"$STATE_NOW\",\"healthy\":\"$HEALTHY\",\"detail\":\"$DETAIL\",\"uptime_s\":$UPTIME_S,\"unit_active\":\"$(systemctl is-active "$UNIT" 2>/dev/null)\"}"

if [ "$STATE_NOW" = "UNREACHABLE" ] && [ "$UPTIME_S" -lt "$STARTUP_GRACE_S" ] && [ "$UPTIME_S" -gt 0 ]; then
  echo "{\"svc\":\"opta-indexer-liveness\",\"note\":\"within startup grace\",\"uptime_s\":$UPTIME_S}"
  exit 0
fi

mkdir -p "$(dirname "$STATE")" 2>/dev/null
PREV=$(cat "$STATE" 2>/dev/null || echo UNKNOWN)
printf '%s' "$STATE_NOW" > "$STATE" 2>/dev/null

if [ "$STATE_NOW" = "OK" ]; then
  if [ "$PREV" != "OK" ] && [ "$PREV" != "UNKNOWN" ]; then
    logger -t opta-indexer-liveness -p daemon.notice "indexer healthy again ($DETAIL)"
    [ -n "$NTFY" ] && curl -s -m 10 -H "Title: Opta indexer healthy again" \
      -H "Priority: default" -d "Chain read path recovered; $DETAIL." \
      "$NTFY" >/dev/null 2>&1
  fi
  exit 0
fi

MSG="Opta indexer read path is ${STATE_NOW}. ${DETAIL}. systemd reports the unit '$(systemctl is-active "$UNIT" 2>/dev/null)'. The /trade grid falls back to direct chain scans while this persists — slow, not broken."
logger -t opta-indexer-liveness -p daemon.err "$MSG"

NOW_S=$(date +%s)
LAST_ALERT=$(cat "$MARKER" 2>/dev/null || echo 0)
case "$LAST_ALERT" in (*[!0-9]*|"") LAST_ALERT=0 ;; esac
if [ $((NOW_S - LAST_ALERT)) -lt "$COOLDOWN_S" ]; then
  echo "{\"svc\":\"opta-indexer-liveness\",\"note\":\"alert suppressed by cooldown\",\"since_s\":$((NOW_S - LAST_ALERT))}"
  exit 1
fi
mkdir -p "$(dirname "$MARKER")" 2>/dev/null
printf '%s' "$NOW_S" > "$MARKER" 2>/dev/null

if [ -n "$NTFY" ]; then
  curl -s -m 10 -H "Title: Opta indexer read path ${STATE_NOW}" -H "Priority: high" \
    -H "Tags: warning" -d "$MSG" "$NTFY" >/dev/null 2>&1 \
    || logger -t opta-indexer-liveness -p daemon.err "ntfy delivery FAILED for indexer-liveness"
fi
exit 1
