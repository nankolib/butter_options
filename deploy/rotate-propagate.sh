#!/usr/bin/env bash
# Key propagation for ticket 86eynebyz, Stage B, Amendment 1.
#
# The founder writes the new key ONCE to /root/.opta-rpc-helius.new. This script
# then does an exact-bytes substitution of old -> new across every target, leaving
# every other byte of every file untouched. `cat > FILE` was rejected because most
# targets are multi-variable files: it would have wiped NTFY_TOPIC out of
# rpc-alarm.env and the rest of the crank's configuration.
#
# The key never reaches argv, history or a log: both values are read from files by
# python, and nothing is ever echoed.
#
#   --dry-run              report what would change, touch nothing
#   --sandbox DIR          operate on copies under DIR (for the red-first proof)
#   --verify               fingerprint every target, no writes
set -uo pipefail

OLDF=/root/.opta-rpc-helius
NEWF=/root/.opta-rpc-helius.new

TARGETS=(
  /root/.opta-rpc-helius
  /etc/opta/rpc-alarm.env
  /opt/opta-crank/.env
  /opt/opta-taker/.env
  /opt/opta-writer/.env
  /opt/opta-trigger/.env
  /opt/opta-indexer/.env
  /opt/crossbar/.env
  /etc/nginx/sites-available/rpc.opta.fyi
)

MODE=apply
SANDBOX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry ;;
    --verify)  MODE=verify ;;
    --sandbox) SANDBOX="$2"; shift ;;
  esac
  shift
done

export OPTA_OLDF="$OLDF" OPTA_NEWF="$NEWF" OPTA_MODE="$MODE" OPTA_SANDBOX="$SANDBOX"
printf '%s\n' "${TARGETS[@]}" > /dev/shm/.rot_targets
export OPTA_TARGETS=/dev/shm/.rot_targets

python3 <<'PYEOF'
import hashlib, os, re, sys

oldf, newf = os.environ["OPTA_OLDF"], os.environ["OPTA_NEWF"]
mode, sandbox = os.environ["OPTA_MODE"], os.environ["OPTA_SANDBOX"]
targets = [l.strip() for l in open(os.environ["OPTA_TARGETS"]) if l.strip()]

def fp(b):
    return hashlib.sha256(b).hexdigest()[:12]

old = open(oldf, "rb").read().strip()
if not old:
    print("FATAL: old keyfile empty"); sys.exit(2)

new = b""
if mode != "verify":
    if not os.path.exists(newf):
        print(f"FATAL: {newf} does not exist — the founder has not written the new key yet")
        sys.exit(3)
    new = open(newf, "rb").read().strip()
    # Guardrails. A malformed new key propagated to 10 files then a revocation
    # would take the whole platform down with no way back.
    if not new:
        print("FATAL: new keyfile is empty"); sys.exit(4)
    if new == old:
        print("FATAL: new key is identical to the old key — nothing to rotate"); sys.exit(5)
    if len(new) < 20:
        print(f"FATAL: new key is only {len(new)} bytes — refusing (expected ~36)"); sys.exit(6)
    if b"\n" in new or b" " in new:
        print("FATAL: new key contains whitespace — paste error?"); sys.exit(7)
    print(f"  old fingerprint : {fp(old)}   ({len(old)} bytes)")
    print(f"  new fingerprint : {fp(new)}   ({len(new)} bytes)")
    print()

# Per-file extraction so verification reads the key AS STORED, rather than
# assuming the substitution worked.
def extract(path, data):
    base = os.path.basename(path)
    if base.startswith(".opta-rpc-helius"):
        return [data.strip()]
    found = []
    found += re.findall(rb'api-key=([A-Za-z0-9_-]+)', data)
    found += re.findall(rb'x-api-key\s+([A-Za-z0-9_-]+)\s*;', data)
    return found

ok = bad = 0
for t in targets:
    src = (sandbox + t) if sandbox else t
    if not os.path.exists(src):
        print(f"  MISSING   {t}"); bad += 1; continue
    data = open(src, "rb").read()

    if mode == "verify":
        got = extract(src, data)
        fps = sorted({fp(g) for g in got})
        print(f"  {t:<46} keys={len(got)} fp={','.join(fps) or 'none'}")
        continue

    n = data.count(old)
    if n == 0:
        print(f"  NO-OLD-KEY {t}  (already rotated, or not a key holder)"); bad += 1; continue

    out = data.replace(old, new)

    # Non-destructiveness proof: substituting back must reproduce the original
    # byte-for-byte. If it does not, something other than the key changed.
    if out.replace(new, old) != data:
        print(f"  FATAL {t}: round-trip mismatch, refusing to write"); bad += 1; continue
    if len(out) - len(data) != n * (len(new) - len(old)):
        print(f"  FATAL {t}: unexpected length delta, refusing to write"); bad += 1; continue

    if mode == "dry":
        print(f"  would replace {n}x in {t}  (len {len(data)} -> {len(out)})")
        ok += 1
        continue

    st = os.stat(src)
    tmp = src + ".rot.tmp"
    with open(tmp, "wb") as fh:
        fh.write(out)
    os.chmod(tmp, st.st_mode & 0o7777)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, src)          # atomic, preserves nothing stale

    back = open(src, "rb").read()
    got = extract(src, back)
    if back.count(old) != 0:
        print(f"  FAIL {t}: old key still present"); bad += 1; continue
    if not got or any(g != new for g in got):
        print(f"  FAIL {t}: stored key does not match the new value"); bad += 1; continue
    print(f"  OK  {t:<44} {n}x  fp={fp(got[0])}  perms={oct(st.st_mode & 0o777)[2:]}")
    ok += 1

print()
print(f"  ok={ok} problems={bad}")
sys.exit(1 if bad else 0)
PYEOF
RC=$?
rm -f /dev/shm/.rot_targets
exit $RC
