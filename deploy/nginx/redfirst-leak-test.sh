#!/usr/bin/env bash
# A4 RED-FIRST — prove the log test can detect a key, THEN prove header auth hides it.
#
# Uses a FAKE sentinel key. Using the real one would write fresh real-key lines into
# the very log we are about to purge.
#
# Two loopback-only locations, both proxying to a blackholed IP so connect() fails
# and nginx logs the upstream URL:
#   /oldway  injects via the URL   (the current production mechanism)  -> MUST leak
#   /newway  injects via a header  (the proposed fix)                  -> MUST NOT leak
set -uo pipefail
SENTINEL="SENTINELKEY-11111111-2222-3333-4444-555555555555"
CONF=/etc/nginx/conf.d/zz-leaktest.conf
trap 'rm -f "$CONF"; nginx -t >/dev/null 2>&1 && systemctl reload nginx' EXIT

cat > "$CONF" <<EOF
server {
    listen 127.0.0.1:18500;
    server_name leaktest.local;

    # 10.255.255.1 is blackholed: connect() times out, nginx logs the upstream URL.
    location /oldway {
        set \$args "api-key=$SENTINEL";
        proxy_pass https://10.255.255.1/;
        proxy_connect_timeout 2s;
    }
    location /newway {
        set \$args "";
        proxy_set_header x-api-key $SENTINEL;
        proxy_pass https://10.255.255.1/;
        proxy_connect_timeout 2s;
    }
}
EOF
chmod 600 "$CONF"

nginx -t 2>&1 | tail -1
systemctl reload nginx
sleep 1

MARK=$(wc -l < /var/log/nginx/error.log)

echo "=== trigger both failure paths ==="
curl -s -o /dev/null -m 10 -X POST "http://127.0.0.1:18500/oldway" -d '{}' -w '  oldway http=%{http_code}\n' || true
curl -s -o /dev/null -m 10 -X POST "http://127.0.0.1:18500/newway" -d '{}' -w '  newway http=%{http_code}\n' || true
sleep 1

NEW=$(tail -n +$((MARK+1)) /var/log/nginx/error.log)

echo
echo "=== RED: does the OLD mechanism put the key in the log? (must be YES) ==="
OLD_HITS=$(printf '%s' "$NEW" | grep -c "oldway.*$SENTINEL\|$SENTINEL.*oldway" || true)
OLD_ANY=$(printf '%s' "$NEW" | grep "/oldway" | grep -c "$SENTINEL" || true)
printf '  oldway lines carrying the sentinel: %s\n' "${OLD_ANY:-0}"
printf '%s' "$NEW" | grep "/oldway" | head -1 | sed -E "s/$SENTINEL/<SENTINEL-FOUND>/g" | cut -c1-200 | sed 's/^/    /'

echo
echo "=== GREEN: does the NEW mechanism keep it out? (must be ZERO) ==="
NEW_ANY=$(printf '%s' "$NEW" | grep "/newway" | grep -c "$SENTINEL" || true)
printf '  newway lines carrying the sentinel: %s\n' "${NEW_ANY:-0}"
printf '%s' "$NEW" | grep "/newway" | head -1 | cut -c1-200 | sed 's/^/    /'

echo
echo "======================================"
if [ "${OLD_ANY:-0}" -ge 1 ] && [ "${NEW_ANY:-0}" -eq 0 ]; then
  echo "PASS: the test CAN detect a leaked key (old way leaked it), and header"
  echo "      injection produces a clean log line. Leak class is closable."
else
  echo "INCONCLUSIVE: old=${OLD_ANY:-0} new=${NEW_ANY:-0}"
  echo "  old must be >=1 (else the test cannot detect a leak at all)"
  echo "  new must be 0"
fi

echo
echo "=== scrub the sentinel lines so the test leaves nothing behind ==="
if grep -qF "$SENTINEL" /var/log/nginx/error.log 2>/dev/null; then
  grep -vF "$SENTINEL" /var/log/nginx/error.log > /var/log/nginx/error.log.clean
  cat /var/log/nginx/error.log.clean > /var/log/nginx/error.log
  rm -f /var/log/nginx/error.log.clean
fi
printf '  sentinel remaining in error.log: %s\n' "$(grep -cF "$SENTINEL" /var/log/nginx/error.log 2>/dev/null || echo 0)"
