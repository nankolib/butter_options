#!/usr/bin/env bash
# RED-FIRST proof for the RPC proxy micro-cache — ticket 86eyn66b4 (D4).
#
# Two things have to hold, and the second matters more than the first:
#   1. the allowlisted reads actually cache (otherwise the change is pointless)
#   2. NOTHING else ever caches — a stale getSignatureStatuses would break the
#      buy-path exactly-once guard, and a stale blockhash produces transactions
#      that fail or replay
#
# Reads X-Opta-Cache ($upstream_cache_status): MISS on first fetch, HIT on a
# repeat, BYPASS whenever the cache was deliberately skipped.
set -uo pipefail

URL=https://rpc.opta.fyi/devnet
PROG=CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq
ADDR=5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk
PASS=0; FAIL=0

status_of() {
  curl -s -o /dev/null -D - -m 30 -X POST "$URL" \
    -H 'Content-Type: application/json' ${2:+-H "$2"} -d "$1" \
    | awk 'tolower($1)=="x-opta-cache:"{print $2}' | tr -d '\r' | tail -1
}

# Cache-key is the body, so a unique marker per case keeps cases independent.
uniq_id() { date +%s%N; }

# A HIT is only possible while the 2s entry is still valid, and a sequential
# harness can exceed that on a cold multi-megabyte transfer — which made an early
# version of this test flake. So assert the mechanism production actually relies
# on: concurrent identical requests collapsing via proxy_cache_lock. That is
# timing-independent, and it is exactly the Trade page's four-simultaneous-scans
# case. The sequential gap is still measured and reported for visibility.
expect_cacheable() {
  local name="$1" body="$2"
  local t0 t1 gap a b concurrent

  t0=$(date +%s%N)
  a=$(status_of "$body")
  b=$(status_of "$body")
  t1=$(date +%s%N)
  gap=$(awk -v s="$t0" -v e="$t1" 'BEGIN{printf "%.2f", (e-s)/1000000000}')

  # Concurrent pair, fresh key so it cannot be served by the entry above.
  local cbody="${body/\"id\":/\"id\":9}"
  concurrent=$( { status_of "$cbody" & status_of "$cbody" & wait; } | tr '\n' ' ')

  if [ "$b" = "HIT" ] || printf '%s' "$concurrent" | grep -q HIT; then
    printf '  PASS  %-34s seq=%s/%s (%ss) concurrent=[%s]\n' \
      "$name" "$a" "$b" "$gap" "$concurrent"; PASS=$((PASS+1))
  else
    printf '  FAIL  %-34s seq=%s/%s (%ss) concurrent=[%s] -- no HIT by either route\n' \
      "$name" "$a" "$b" "$gap" "$concurrent"; FAIL=$((FAIL+1))
  fi
}

expect_never_cached() {
  local name="$1" body="$2" hdr="${3:-}"
  local a b
  a=$(status_of "$body" "$hdr"); b=$(status_of "$body" "$hdr")
  if [ "$b" != "HIT" ] && [ "$a" != "HIT" ]; then
    printf '  PASS  %-34s first=%s second=%s (never cached)\n' "$name" "${a:-none}" "${b:-none}"; PASS=$((PASS+1))
  else
    printf '  FAIL  %-34s first=%s second=%s -- THIS MUST NEVER CACHE\n' "$name" "$a" "$b"; FAIL=$((FAIL+1))
  fi
}

echo "=== A. allowlisted reads MUST cache (the saving) ==="
ID=$(uniq_id)
expect_cacheable "getProgramAccounts" \
  "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getProgramAccounts\",\"params\":[\"$PROG\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":0}}]}"
ID=$(uniq_id)
expect_cacheable "getAccountInfo" \
  "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getAccountInfo\",\"params\":[\"$ADDR\",{\"encoding\":\"base64\"}]}"

echo
echo "=== B. the exactly-once guard: these MUST NEVER cache ==="
ID=$(uniq_id)
expect_never_cached "getSignatureStatuses" \
  "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getSignatureStatuses\",\"params\":[[\"4CgnQtRfnUekfn21meTyHYvoAc3pBQTFa6mYRFF5jXpsvBSHnCPjSHZfHqzGDNM3sZLm4kTB1mBEgvA3TjfEwXn6\"]]}"
ID=$(uniq_id)
expect_never_cached "getLatestBlockhash" \
  "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getLatestBlockhash\",\"params\":[]}"

echo
echo "=== C. writes and time-sensitive reads MUST NEVER cache ==="
ID=$(uniq_id)
expect_never_cached "sendTransaction (invalid payload)" \
  "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"sendTransaction\",\"params\":[\"AA==\",{\"encoding\":\"base64\"}]}"
ID=$(uniq_id)
expect_never_cached "simulateTransaction" \
  "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"simulateTransaction\",\"params\":[\"AA==\",{\"encoding\":\"base64\"}]}"
ID=$(uniq_id)
expect_never_cached "getSlot" \
  "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getSlot\",\"params\":[]}"

echo
echo "=== D. the batching trap: a batch carrying a write MUST NEVER cache ==="
# A method-name regex alone would see "getAccountInfo" and cache the whole batch,
# sendTransaction included. This is the case that would do real damage.
ID=$(uniq_id)
expect_never_cached "batch [getAccountInfo,sendTransaction]" \
  "[{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getAccountInfo\",\"params\":[\"$ADDR\"]},{\"jsonrpc\":\"2.0\",\"id\":$((ID+1)),\"method\":\"sendTransaction\",\"params\":[\"AA==\"]}]"
ID=$(uniq_id)
expect_never_cached "batch of two allowlisted reads" \
  "[{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getAccountInfo\",\"params\":[\"$ADDR\"]},{\"jsonrpc\":\"2.0\",\"id\":$((ID+1)),\"method\":\"getAccountInfo\",\"params\":[\"$PROG\"]}]"

echo
echo "=== E. WebSocket upgrades must bypass (nginx always keeps GET/HEAD cacheable) ==="
ID=$(uniq_id)
expect_never_cached "getAccountInfo + Upgrade header" \
  "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getAccountInfo\",\"params\":[\"$ADDR\"]}" \
  "Upgrade: websocket"

echo
echo "=== F. distinct bodies must not collide on one cache entry ==="
ID=$(uniq_id)
B1="{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getAccountInfo\",\"params\":[\"$ADDR\",{\"encoding\":\"base64\"}]}"
B2="{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"getAccountInfo\",\"params\":[\"$PROG\",{\"encoding\":\"base64\"}]}"
status_of "$B1" >/dev/null
S2=$(status_of "$B2")
if [ "$S2" != "HIT" ]; then
  printf '  PASS  %-34s different body => %s, not a false HIT\n' "distinct bodies" "$S2"; PASS=$((PASS+1))
else
  printf '  FAIL  %-34s different body returned HIT -- keys collide\n' "distinct bodies"; FAIL=$((FAIL+1))
fi

echo
echo "======================================"
printf 'PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || echo "CACHE PROOF FAILED — revert the include line."
exit "$FAIL"
