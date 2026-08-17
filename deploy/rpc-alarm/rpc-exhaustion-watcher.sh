#!/usr/bin/env bash
# Opta upstream-RPC exhaustion watcher — ticket 86eyn66b4.
#
# The 5-minute probe can be up to 5 minutes late. This watcher reads what the
# real consumers actually experienced and trips as soon as ANY of them logs the
# credit-exhaustion signature, which is typically well before the next probe.
#
# It scans a bounded window instead of following the journal, so there is no
# long-lived `journalctl -f` that can die quietly and leave us blind.
#
# THE SIGNATURE (recorded from the 2026-08-16 15:44:28 UTC incident)
#     HTTP 429
#     {"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}
#
# -32429 appeared 385 times during the incident with nothing else matching it, so
# it is a safe discriminator. A bare 429 is NOT matched here on purpose: the
# client libraries print "Server responded with 429 Too Many Requests" for
# ordinary per-second throttling, and matching that would page on traffic spikes.
set -uo pipefail

UNITS="${OPTA_WATCH_UNITS:-opta-crank opta-taker opta-trigger opta-indexer opta-writer}"
WINDOW="${OPTA_WATCH_WINDOW:-3 min ago}"
NTFY_URL="${OPTA_ALARM_NTFY_URL:-}"
COOLDOWN_S="${OPTA_WATCH_COOLDOWN_S:-1800}"
MARKER="${OPTA_WATCH_MARKER:-/var/lib/opta-rpc-alarm/last_exhaustion_alert}"

redact() {
  sed -E 's/(api-key=|api_key=|apikey=)[A-Za-z0-9_-]+/\1<REDACTED>/gi;
          s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<REDACTED>/gi'
}

args=()
for u in $UNITS; do args+=(-u "$u"); done

HITS=$(journalctl "${args[@]}" --since "$WINDOW" --no-pager 2>/dev/null \
       | grep -cE -- '-32429|max usage reached')
HITS=${HITS:-0}

if [ "$HITS" -eq 0 ]; then
  echo "{\"svc\":\"opta-rpc-watcher\",\"state\":\"CLEAR\",\"hits\":0,\"window\":\"${WINDOW}\"}"
  exit 0
fi

# Which consumers are affected — useful triage detail in the alert itself.
AFFECTED=""
for u in $UNITS; do
  n=$(journalctl -u "$u" --since "$WINDOW" --no-pager 2>/dev/null \
      | grep -cE -- '-32429|max usage reached')
  [ "${n:-0}" -gt 0 ] && AFFECTED="${AFFECTED}${u}(${n}) "
done
AFFECTED=$(printf '%s' "$AFFECTED" | redact)

echo "{\"svc\":\"opta-rpc-watcher\",\"state\":\"CREDITS_EXHAUSTED\",\"hits\":${HITS},\"affected\":\"${AFFECTED}\"}"

# Rate-limit the page: an exhausted upstream keeps producing hits every tick and
# we do not want a notification every 2 minutes for hours.
NOW=$(date +%s)
LAST=$(cat "$MARKER" 2>/dev/null || echo 0)
case "$LAST" in (*[!0-9]*|"") LAST=0 ;; esac

logger -t opta-rpc-watcher -p daemon.err \
  "upstream RPC credit exhaustion seen in consumer logs: ${AFFECTED}"

if [ $((NOW - LAST)) -lt "$COOLDOWN_S" ]; then
  echo "{\"svc\":\"opta-rpc-watcher\",\"note\":\"alert suppressed by cooldown\",\"since_last_s\":$((NOW - LAST))}"
  exit 1
fi

mkdir -p "$(dirname "$MARKER")" 2>/dev/null
printf '%s' "$NOW" > "$MARKER" 2>/dev/null

if [ -n "$NTFY_URL" ]; then
  curl -s -m 10 \
    -H "Title: Opta RPC CREDITS EXHAUSTED (seen by consumers)" \
    -H "Priority: urgent" \
    -H "Tags: rotating_light" \
    -d "Consumers are being refused by the upstream RPC for spent credits: ${AFFECTED}. Settles trading, cranks and the web/mobile proxy. Top up or raise the plan now." \
    "$NTFY_URL" >/dev/null 2>&1 \
    || logger -t opta-rpc-watcher -p daemon.err "ntfy delivery FAILED for exhaustion alert"
fi

exit 1
