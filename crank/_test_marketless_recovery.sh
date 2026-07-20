#!/usr/bin/env bash
# ============================================================================
# _test_marketless_recovery.sh — proves the two _cutover_rebirth.ts guards that
# came out of the MSFT marketless incident (2026-07-20).
# ============================================================================
# INCIDENT: MSFT's close_market landed, then all 10 create attempts threw
# "feedHash ... not in SB registry" (switchboardCreateMarket.ts) because the
# equity feeds weren't registered -> MSFT was left MARKETLESS. Worse, the
# die(21) escalation told the operator to "re-run, it's idempotent", but step 0
# die(10)'d on the absent PDA, so the advertised recovery was impossible.
#
# TEST 1 (recovery): an ABSENT market PDA is exactly the marketless state. The
#   patched driver must take the recovery branch (skip scan+close -> create),
#   NOT die(10). Reproduced with a bogus asset name + a REGISTERED feedHash.
# TEST 2 (prerequisite gate): an UNREGISTERED feedHash must die(12) BEFORE any
#   close, so the incident class cannot recur.
#
# Read-only (dry run, no --execute). Run from crank/:
#   bash _test_marketless_recovery.sh
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"
export OPTA_RPC_URL="${OPTA_RPC_URL:-$(cat ~/.opta-rpc-helius)}"
RUN="npx ts-node --transpile-only -r tsconfig-paths/register _cutover_rebirth.ts"

MSFT_HASH=b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56
UNREG_HASH=00000000000000000000000000000000000000000000000000000000deadbeef
BOGUS_ASSET=ZZNOMARKET   # PDA guaranteed absent == the marketless state

pass=0; fail=0
want()    { if [[ "$2" == *"$3"* ]]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 — missing: $3"; echo "$2" | tail -4; fail=$((fail+1)); fi; }
wantNot() { if [[ "$2" != *"$3"* ]]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 — present: $3"; fail=$((fail+1)); fi; }
wantRc()  { if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 — rc=$2 want $3"; fail=$((fail+1)); fi; }

echo "TEST 1 — absent PDA (marketless) routes to RECOVERY, not die(10)"
OUT1=$($RUN "$BOGUS_ASSET" "$MSFT_HASH" 2 2>&1 | grep -v "bigint: Failed"); RC1=$?
want    "recovery branch taken (reports MARKETLESS)"      "$OUT1" "MARKETLESS"
want    "routes to create (no close)"                     "$OUT1" "Would: create_market"
wantNot "did NOT die(10) 'nothing to close'"              "$OUT1" "nothing to close"
wantRc  "exit 0 (recoverable, not fatal)"                 "$RC1"  "0"

# NOTE: must use a still-PYTH asset. An already-SB asset early-exits at the
# "already reborn" skip before the registry gate is reached.
echo "TEST 2 — unregistered feedHash dies BEFORE any close (prerequisite gate)"
OUT2=$($RUN AAPL "$UNREG_HASH" 2 2>&1 | grep -v "bigint: Failed"); RC2=$?
want    "die(12) names the registry as the cause"         "$OUT2" "NOT in the SB registry"
wantNot "no close was attempted"                          "$OUT2" '"ev":"closed"'
wantRc  "exit 12"                                         "$RC2"  "12"

echo ""
echo "RESULT: $pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
