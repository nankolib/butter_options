#!/usr/bin/env bash
# RED-FIRST proof for the Opta upstream-RPC alarm — ticket 86eyn66b4.
#
# An alarm that cannot go red is not an alarm. This drives the probe into every
# failure state and asserts the classification, then proves it returns green.
#
# Runs the probe as the SAME user systemd uses (opta), so a permission problem
# shows up here rather than in production.
#
# The real keyfile is never touched: the KEY_INVALID case builds a corrupted
# COPY in a temp file that is deleted on exit.
#
# ntfy is suppressed for the red cases (OPTA_ALARM_NTFY_URL="") so the proof does
# not spam the channel; a single deliberate alert is fired separately afterwards.
set -uo pipefail

PROBE=/opt/opta-rpc-alarm/rpc-alarm.sh
WATCHER=/opt/opta-rpc-alarm/rpc-exhaustion-watcher.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null' EXIT
# mktemp -d under root yields a root-owned 0700 dir. The probe runs as opta and
# writes a state file, so opta needs its own writable subdir — 755 on the parent
# lets it traverse but not write, which fails every case for the wrong reason.
chmod 755 "$TMP"
install -d -o opta -g opta -m 700 "$TMP/state"

PASS=0; FAIL=0
run_case() {
  local name="$1" want="$2" url="$3"
  local out state
  out=$(sudo -u opta env \
        OPTA_ALARM_RPC_URL="$url" \
        OPTA_ALARM_NTFY_URL="" \
        OPTA_ALARM_STATE_FILE="$TMP/state/$name" \
        OPTA_ALARM_TIMEOUT=8 \
        "$PROBE" 2>&1 | tail -1)
  state=$(printf '%s' "$out" | sed -n 's/.*"state":"\([A-Z_]*\)".*/\1/p')
  if [ "$state" = "$want" ]; then
    printf '  PASS  %-22s got=%s\n' "$name" "$state"; PASS=$((PASS+1))
  else
    printf '  FAIL  %-22s want=%s got=%s\n     raw: %s\n' "$name" "$want" "${state:-<none>}" "$out"; FAIL=$((FAIL+1))
  fi
}

echo "=== (a) KEY_INVALID — corrupted key COPY, real key untouched ==="
# Deliberately mangled, structurally valid-looking key. Never derived from the
# real one, so there is no path by which the real key could leak into a log.
run_case "key_invalid_uuid"   KEY_INVALID "https://devnet.helius-rpc.com/?api-key=deadbeef-0000-0000-0000-000000000000"
run_case "key_invalid_junk"   KEY_INVALID "https://devnet.helius-rpc.com/?api-key=not-a-real-key-at-all"
run_case "key_missing"        KEY_INVALID "https://devnet.helius-rpc.com/"

echo
echo "=== (b) NETWORK — unreachable upstream ==="
run_case "network_dns"        NETWORK "https://opta-probe-nonexistent-host.invalid/"
run_case "network_timeout"    NETWORK "https://10.255.255.1/"

echo
echo "=== (c) CREDITS_EXHAUSTED — replay the exact Aug 16 15:44:28 UTC bytes ==="
# A local server returning the recorded incident response, so the real curl path
# and the real classifier are exercised. No test-only branch exists in the probe.
cat > "$TMP/srv.py" <<'PYEOF'
import http.server, sys
BODY = b'{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}'
CODE = int(sys.argv[1]); PORT = int(sys.argv[2])
BODY2 = sys.argv[3].encode() if len(sys.argv) > 3 else BODY
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))
        self.send_response(CODE)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(BODY2)))
        self.end_headers()
        self.wfile.write(BODY2)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', PORT), H).serve_forever()
PYEOF

python3 "$TMP/srv.py" 429 18429 & SRV_PID=$!
# 429 WITHOUT the -32429 body — must classify as transient, NOT as exhaustion.
python3 "$TMP/srv.py" 429 18430 '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Too many requests"}}' & SRV2_PID=$!
python3 "$TMP/srv.py" 200 18431 '{"jsonrpc":"2.0","result":"ok","id":1}' & SRV3_PID=$!
sleep 2

run_case "credits_exhausted"  CREDITS_EXHAUSTED "http://127.0.0.1:18429/"
run_case "rate_limited_not_exhausted" RATE_LIMITED "http://127.0.0.1:18430/"
# A 200 that carries no balance must not be trusted as healthy.
run_case "http200_no_balance" DEGRADED "http://127.0.0.1:18431/"
kill "$SRV_PID" "$SRV2_PID" "$SRV3_PID" 2>/dev/null; SRV_PID=""

echo
echo "=== (d) GREEN — real config, real key, via systemd (unit path, not ad-hoc) ==="
systemctl start opta-rpc-alarm.service
sleep 1
GREEN=$(journalctl -u opta-rpc-alarm -n 20 --no-pager 2>/dev/null | grep -o '"state":"[A-Z_]*"' | tail -1)
if printf '%s' "$GREEN" | grep -q '"state":"OK"'; then
  printf '  PASS  %-22s got=%s\n' "systemd_green" "$GREEN"; PASS=$((PASS+1))
else
  printf '  FAIL  %-22s want=OK got=%s\n' "systemd_green" "${GREEN:-<none>}"; FAIL=$((FAIL+1))
fi

echo
echo "=== (e) WATCHER must be able to see consumer journals as opta ==="
# Without SupplementaryGroups=systemd-journal this reports CLEAR forever, so
# assert the negative control explicitly: bare opta must FAIL to read.
BARE=$(sudo -u opta journalctl -u opta-crank -n 1 --no-pager 2>&1 | grep -c "insufficient permissions")
if [ "$BARE" -ge 1 ]; then
  printf '  PASS  %-22s bare opta cannot read journals (control holds)\n' "watcher_control"; PASS=$((PASS+1))
else
  printf '  FAIL  %-22s expected bare opta to be denied journal access\n' "watcher_control"; FAIL=$((FAIL+1))
fi

# Now the watcher through systemd (which grants the group) must find the real
# Aug 16 hits when pointed at a window containing them.
systemctl start opta-rpc-watcher.service 2>/dev/null
sleep 1
W=$(journalctl -u opta-rpc-watcher -n 10 --no-pager 2>/dev/null | grep -o '"state":"[A-Z_]*"' | tail -1)
printf '  INFO  watcher current window state = %s (CLEAR expected: incident is over)\n' "${W:-<none>}"

# Red proof for the watcher: aim it at a window that DOES contain the incident.
WRED=$(sudo -u opta -g systemd-journal env \
        OPTA_ALARM_NTFY_URL="" \
        OPTA_WATCH_MARKER="$TMP/marker" \
        OPTA_WATCH_WINDOW="2026-08-16 15:40" \
        OPTA_WATCH_UNITS="opta-trigger opta-indexer opta-taker" \
        "$WATCHER" 2>&1 | tail -2 | head -1)
if printf '%s' "$WRED" | grep -q 'CREDITS_EXHAUSTED'; then
  printf '  PASS  %-22s watcher went RED on the real incident window\n' "watcher_red"; PASS=$((PASS+1))
  printf '        %s\n' "$(printf '%s' "$WRED" | head -c 220)"
else
  printf '  FAIL  %-22s watcher did not detect the known incident\n     raw: %s\n' "watcher_red" "$WRED"; FAIL=$((FAIL+1))
fi

echo
echo "======================================"
printf 'PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || echo "RED-FIRST PROOF FAILED — do not enable the timers."
exit "$FAIL"
