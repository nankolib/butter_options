#!/usr/bin/env bash
# Keeper wallet low-balance alarm — 2B item 4. HARD GATE for 2C.
#
# WHY
#   execute_trigger is permissionless and the KEEPER pays: payerKey is the crank
#   wallet. So the protocol subsidises every user trigger, and a keeper that runs
#   out of SOL stops firing stops-losses without anything failing loudly — the
#   ticks keep running, they just cannot send. That is the quiet failure this
#   exists to make loud.
#
#   At 0.0009 SOL per Switchboard fire, 1 SOL is roughly 1,100 fires of runway —
#   enough warning to top up before anything is missed, and far enough above zero
#   that a burst cannot cross it unnoticed.
#
# THRESHOLD IS A SEAM
#   OPTA_KEEPER_MIN_SOL exists so the alarm can be driven red WITHOUT draining a
#   live wallet. Draining to test would be a real outage staged to prove a monitor.
set -uo pipefail

WALLET="${OPTA_KEEPER_WALLET:-5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa}"
MIN_SOL="${OPTA_KEEPER_MIN_SOL:-1.0}"
RPC="${OPTA_KEEPER_RPC:-https://api.devnet.solana.com}"
NTFY="${OPTA_ALARM_NTFY_URL:-}"
STATE="${OPTA_KEEPER_STATE:-/var/lib/opta-rpc-alarm/keeper_balance_state}"

REQ='{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["'"$WALLET"'"]}'
BODY=$(curl -s -m 20 -X POST "$RPC" -H 'Content-Type: application/json' -d "$REQ" 2>/dev/null)
RC=$?

LAMPORTS=$(printf '%s' "$BODY" | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p')

if [ "$RC" -ne 0 ] || [ -z "$LAMPORTS" ]; then
  # Unreadable is NOT the same as low. Say so rather than paging for a balance
  # nobody measured.
  echo "{\"svc\":\"opta-keeper-wallet\",\"state\":\"UNREADABLE\",\"curl_exit\":$RC}"
  logger -t opta-keeper-wallet -p daemon.warning "keeper balance unreadable (curl $RC)"
  exit 0
fi

SOL=$(awk -v l="$LAMPORTS" 'BEGIN{printf "%.6f", l/1000000000}')
LOW=$(awk -v s="$SOL" -v m="$MIN_SOL" 'BEGIN{print (s < m) ? 1 : 0}')
STATE_NOW=$([ "$LOW" = "1" ] && echo LOW || echo OK)

echo "{\"svc\":\"opta-keeper-wallet\",\"state\":\"$STATE_NOW\",\"sol\":$SOL,\"threshold\":$MIN_SOL,\"wallet\":\"${WALLET:0:8}\"}"

mkdir -p "$(dirname "$STATE")" 2>/dev/null
PREV=$(cat "$STATE" 2>/dev/null || echo UNKNOWN)
printf '%s' "$STATE_NOW" > "$STATE" 2>/dev/null

if [ "$STATE_NOW" = "LOW" ]; then
  FIRES=$(awk -v s="$SOL" 'BEGIN{printf "%d", s/0.0009}')
  MSG="Keeper wallet ${WALLET:0:8}… is at ${SOL} SOL, below ${MIN_SOL}. About ${FIRES} trigger fires of runway left. execute_trigger is keeper-paid: at zero, TP/SL stops firing while the crank still looks healthy."
  logger -t opta-keeper-wallet -p daemon.err "$MSG"
  if [ -n "$NTFY" ]; then
    curl -s -m 10 -H "Title: Opta keeper wallet LOW" -H "Priority: urgent" \
      -H "Tags: rotating_light" -d "$MSG" "$NTFY" >/dev/null 2>&1 \
      || logger -t opta-keeper-wallet -p daemon.err "ntfy delivery FAILED for keeper-low"
  fi
  exit 1
fi

# Recovery notice only on transition, so a funded wallet stays silent.
if [ "$PREV" = "LOW" ]; then
  logger -t opta-keeper-wallet -p daemon.notice "keeper wallet recovered: ${SOL} SOL"
  [ -n "$NTFY" ] && curl -s -m 10 -H "Title: Opta keeper wallet recovered" \
    -H "Priority: default" -d "Keeper wallet back to ${SOL} SOL (threshold ${MIN_SOL})." \
    "$NTFY" >/dev/null 2>&1
fi
exit 0
