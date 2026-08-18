#!/usr/bin/env bash
# Keeper liveness monitor — 2B item 3. HARD GATE for 2C.
#
# WHAT IS AND IS NOT THE SIGNAL
#   `systemctl is-active opta-trigger` is NOT the signal. A node process can sit
#   alive with a wedged loop, a swallowed exception, or an await that never
#   resolves, and systemd will report it healthy forever. The user-visible failure
#   — a stop-loss that is not being watched — looks exactly like a healthy service.
#
#   The signal is the tick's own COMPLETION line, which the crank emits once per
#   pass and which carries its evaluation counters:
#
#     {"msg":"trigger tick: no live triggers","triggersFound":0,...}
#     {"msg":"trigger tick","triggersFound":N,"fired":F,"skipped...":...}
#
#   A completion line can only exist if the tick fetched orders, read tape and ran
#   the comparator to the end. So its presence asserts BOTH halves the ruling asks
#   for: ticks are completing, and armed orders were evaluated.
#
# ARMED-STATE ESCALATION
#   The last observed triggersFound tells us whether anything is at stake. Silence
#   with zero armed orders is a fault worth logging; silence while orders ARE armed
#   is someone's stop-loss going unwatched, and pages urgent.
#
# COST
#   journald only. Zero RPC credits — deliberate, on the crank that once burned
#   98.6% of all gPA traffic.
set -uo pipefail

UNIT="${OPTA_KEEPER_UNIT:-opta-trigger}"
# Tick is 300s. Two missed ticks plus slack: a single slow pass must not page.
MAX_SILENCE_S="${OPTA_KEEPER_MAX_SILENCE_S:-780}"
NTFY="${OPTA_ALARM_NTFY_URL:-}"
STATE="${OPTA_KEEPER_LIVENESS_STATE:-/var/lib/opta-rpc-alarm/keeper_liveness_state}"
COOLDOWN_S="${OPTA_KEEPER_COOLDOWN_S:-1800}"
MARKER="${OPTA_KEEPER_LIVENESS_MARKER:-/var/lib/opta-rpc-alarm/keeper_liveness_alert}"

WINDOW=$((MAX_SILENCE_S + 600))
LOG=$( { journalctl -u "$UNIT" --since "${WINDOW} seconds ago" --no-pager 2>/dev/null || true; } )

LAST=$(printf '%s' "$LOG" | grep -oE '"msg":"trigger tick[^}]*' | tail -1)
LAST_TS=$(printf '%s' "$LOG" | grep -E '"msg":"trigger tick' | tail -1 | grep -oE '"ts":"[^"]+"' | cut -d'"' -f4)

NOW=$(date -u +%s)
if [ -n "$LAST_TS" ]; then
  TICK_EPOCH=$(date -u -d "$LAST_TS" +%s 2>/dev/null || echo 0)
else
  TICK_EPOCH=0
fi
AGE=$(( TICK_EPOCH > 0 ? NOW - TICK_EPOCH : -1 ))

# How many orders the keeper last SAW. Absent ⇒ unknown, treated as armed, because
# assuming "nothing at stake" is the assumption that makes a monitor useless.
ARMED=$(printf '%s' "$LAST" | grep -oE '"triggersFound":[0-9]+' | cut -d: -f2)
ARMED=${ARMED:-unknown}

if [ "$TICK_EPOCH" -eq 0 ]; then
  STATE_NOW=NO_TICKS
elif [ "$AGE" -gt "$MAX_SILENCE_S" ]; then
  STATE_NOW=STALE
else
  STATE_NOW=OK
fi

echo "{\"svc\":\"opta-keeper-liveness\",\"state\":\"$STATE_NOW\",\"last_tick_age_s\":$AGE,\"max_silence_s\":$MAX_SILENCE_S,\"armed\":\"$ARMED\",\"unit_active\":\"$(systemctl is-active "$UNIT" 2>/dev/null)\"}"

mkdir -p "$(dirname "$STATE")" 2>/dev/null
PREV=$(cat "$STATE" 2>/dev/null || echo UNKNOWN)
printf '%s' "$STATE_NOW" > "$STATE" 2>/dev/null

if [ "$STATE_NOW" = "OK" ]; then
  if [ "$PREV" != "OK" ] && [ "$PREV" != "UNKNOWN" ]; then
    logger -t opta-keeper-liveness -p daemon.notice "keeper ticking again (age ${AGE}s)"
    [ -n "$NTFY" ] && curl -s -m 10 -H "Title: Opta keeper ticking again" \
      -H "Priority: default" -d "Trigger keeper resumed; last tick ${AGE}s ago, ${ARMED} order(s) armed." \
      "$NTFY" >/dev/null 2>&1
  fi
  exit 0
fi

# Escalate on whether anything is actually at stake.
if [ "$ARMED" = "0" ]; then
  PRIO=high;   STAKE="no orders were armed at the last tick, so nothing is unwatched YET"
else
  PRIO=urgent; STAKE="${ARMED} order(s) were armed at the last tick and are now UNWATCHED"
fi

MSG="Trigger keeper is not completing ticks. Last tick ${AGE}s ago (limit ${MAX_SILENCE_S}s); systemd reports the unit '$(systemctl is-active "$UNIT" 2>/dev/null)'. ${STAKE}. TP/SL will not fire while this persists."
logger -t opta-keeper-liveness -p daemon.err "$MSG"

NOW_S=$(date +%s)
LAST_ALERT=$(cat "$MARKER" 2>/dev/null || echo 0)
case "$LAST_ALERT" in (*[!0-9]*|"") LAST_ALERT=0 ;; esac
if [ $((NOW_S - LAST_ALERT)) -lt "$COOLDOWN_S" ]; then
  echo "{\"svc\":\"opta-keeper-liveness\",\"note\":\"alert suppressed by cooldown\",\"since_s\":$((NOW_S - LAST_ALERT))}"
  exit 1
fi
mkdir -p "$(dirname "$MARKER")" 2>/dev/null
printf '%s' "$NOW_S" > "$MARKER" 2>/dev/null

if [ -n "$NTFY" ]; then
  curl -s -m 10 -H "Title: Opta keeper NOT TICKING" -H "Priority: $PRIO" \
    -H "Tags: rotating_light" -d "$MSG" "$NTFY" >/dev/null 2>&1 \
    || logger -t opta-keeper-liveness -p daemon.err "ntfy delivery FAILED for keeper-liveness"
fi
exit 1
