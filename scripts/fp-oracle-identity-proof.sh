#!/usr/bin/env bash
# =============================================================================
# fp-oracle-identity-proof.sh — TIER 3 of the FP-ORACLE isolation gate
# =============================================================================
#
# THE CLAIM UNDER TEST
#   The cfg-gated declare_id! block in programs/opta/src/lib.rs costs a
#   feature-free (production) build NOTHING. Enabling no features must produce
#   the same program as if the block had never been written.
#
# WHY NOT JUST DIFF AGAINST PRE-EDIT HEAD
#   Because that comparison FAILS for a reason that has nothing to do with the
#   feature gate, and a proof that fails for the wrong reason teaches nothing.
#   Measured 2026-08-30:
#
#     pre-edit HEAD, feature-free      a22f8ca538334ee9...
#     edited tree,   feature-free      b5d58b274bba757b...
#     30 PURE COMMENT LINES inserted
#       above declare_id, no gate      b5d58b274bba757b...   <-- identical
#
#   The third build changes no logic whatsoever, and it lands on exactly the
#   same hash as the gated tree. Anchor's error machinery embeds file!()/line!(),
#   so ANY insertion above a require!/msg! shifts bytes. The pre-edit hash
#   therefore differs by line numbering alone, and the cfg block itself
#   contributes zero.
#
# WHAT THIS SCRIPT COMPARES INSTEAD — the question that actually matters
#   Feature-free build of the tree AS IT IS, versus feature-free build of a
#   variant where the whole tier-3 block is replaced by the SAME NUMBER OF LINES
#   of plain comment plus the bare canonical declare_id!. Line numbers are held
#   constant, so the ONLY variable left is the cfg gate. If those two hashes
#   diverge, the gate has started costing production something and tier 3 is no
#   longer free.
#
# This is a strictly STRONGER statement than the pre-edit diff would have been.
#
# Usage:  bash scripts/fp-oracle-identity-proof.sh
# Exit 0 = identical (tier 3 is free). Exit 1 = DIVERGENCE (STOP).
# Exit 2 = could not run (no toolchain / build failed) — INCONCLUSIVE, not a pass.
# Requires: WSL/Linux with the anchor toolchain. Takes ~2 builds.
# =============================================================================

set -uo pipefail

LIB="programs/opta/src/lib.rs"
SO="target/deploy/opta.so"
BACKUP="$(mktemp)"
MARKER="FP-ORACLE SCRATCH BUILD IDENTITY"
CANON='declare_id!("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");'

[ -f "$LIB" ] || { echo "run from the repo root"; exit 1; }
cp "$LIB" "$BACKUP"
# Restore on ANY exit path. A half-restored lib.rs is worse than a failed proof,
# and this script deliberately mutates a canonical file.
trap 'cp "$BACKUP" "$LIB"; rm -f "$BACKUP"' EXIT INT TERM

if ! grep -q "$MARKER" "$LIB"; then
  echo "tier 3 block not present in $LIB — nothing to prove."
  echo "If the plug ceremony has removed it, delete this script and the tier-3"
  echo "gate step together."
  exit 0
fi

# Exit 2 (not 1) when the TOOLCHAIN is the problem rather than the code. A proof
# that cannot run is not a proof that failed, and reporting "the cfg gate now
# changes the production binary" because `anchor` is not on PATH is a false STOP
# — which trains people to ignore the gate. Observed 2026-08-30: run from Git
# Bash on Windows, both builds failed and the gate cried divergence while the
# same proof passed cleanly under WSL.
if ! command -v anchor >/dev/null 2>&1; then
  echo "TOOLCHAIN UNAVAILABLE — \`anchor\` is not on PATH."
  echo "This proof needs the Anchor toolchain (run it from WSL, not Git Bash)."
  echo "NOT a divergence: the comparison never ran."
  exit 2
fi

build_hash() {
  anchor build >/dev/null 2>&1 || { echo "BUILD FAILED"; return 1; }
  sha256sum "$SO" | awk '{print $1}'
}

echo "FP-ORACLE identity proof (tier 3)"
echo

echo "[1/2] feature-free build of the tree AS IS (cfg-gated declare_id) ..."
GATED="$(build_hash)" || exit 2
echo "      $GATED"

# Build the line-count-matched canonical-only variant.
python3 - "$LIB" "$MARKER" "$CANON" <<'PY'
import io, sys
lib, marker, canon = sys.argv[1], sys.argv[2], sys.argv[3]
lines = io.open(lib, encoding="utf-8").read().split("\n")
start = next(i for i, l in enumerate(lines) if marker in l)
# The block opens on the "// ====" line immediately above the marker.
while start > 0 and lines[start - 1].startswith("// ="):
    start -= 1
end = next(i for i, l in enumerate(lines) if l.startswith('declare_id!("CtzJ'))
n = end - start + 1          # total lines the block occupies, inclusive
repl = ["// identity-proof pad — canonical-only variant"] * (n - 1) + [canon]
assert len(repl) == n, (len(repl), n)
io.open(lib, "w", encoding="utf-8", newline="\n").write("\n".join(lines[:start] + repl + lines[end + 1:]))
print(f"      variant: block ({n} lines) -> {n-1} comment lines + bare canonical declare_id")
PY

echo "[2/2] feature-free build of the canonical-only variant (same line count) ..."
PLAIN="$(build_hash)" || exit 2
echo "      $PLAIN"
echo

if [ "$GATED" = "$PLAIN" ]; then
  echo "IDENTITY PROOF PASSED — tier 3 costs a feature-free build nothing."
  echo "  gated        $GATED"
  echo "  canonical    $PLAIN"
  exit 0
fi
echo "IDENTITY PROOF FAILED — the cfg gate now changes the production binary."
echo "  gated        $GATED"
echo "  canonical    $PLAIN"
echo "STOP. Tier 3 is only defensible while these match."
exit 1
