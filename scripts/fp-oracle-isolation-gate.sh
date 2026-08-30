#!/usr/bin/env bash
# =============================================================================
# fp-oracle-isolation-gate.sh -- enforce the FP-ORACLE module boundary
# =============================================================================
#
# Spec FP_ORACLE_MODULE_SPEC_V2 section 7: zero commits touch canonical program
# code paths until the plug ceremony. Run before every push to `fp-oracle`.
#
# The spec's first cut of this gate allowlisted only the new module files. That
# was wrong and would have failed on the first commit: a new instruction cannot
# compile without being registered in instructions/mod.rs, state/mod.rs, lib.rs
# and errors.rs. Those four ARE canonical files.
#
# So the gate has two tiers:
#
#   TIER 1 - MODULE FILES. New files, wholly owned by the module. Any diff.
#   TIER 2 - REGISTRATION FILES. Canonical, but may be touched ADDITIVELY ONLY:
#            zero deleted lines. A pure-addition diff to a mod/lib/errors file
#            cannot change existing behaviour, which is the property that makes
#            the module detachable. One deletion and the gate fails.
#
# Everything else under programs/opta/src is forbidden and fails the gate.
#
# The six oracle_source match arms are NOT exempted and never will be. Arming
# them deletes and rewrites lines in canonical read paths, so this gate MUST go
# red on the `arm-6-sites` commit. That is the signal that the module has left
# isolation and the plug ceremony has begun -- not a reason to weaken the gate.
# =============================================================================

set -uo pipefail

BASE="${1:-origin/master}"
SCOPE="programs/opta/src"

MODULE_FILES='^programs/opta/src/(state/opta_price_feed\.rs|utils/opta_price_read\.rs|instructions/(init_opta_price_feed|push_opta_price|set_feed_authority|set_oracle_source)\.rs)$'
REGISTRATION_FILES='^programs/opta/src/(lib\.rs|errors\.rs|state/mod\.rs|instructions/mod\.rs|utils/mod\.rs)$'

fail=0

echo "FP-ORACLE isolation gate — diff base: ${BASE}"
echo

changed=$(git diff --name-only "${BASE}...HEAD" -- "${SCOPE}")
if [ -z "${changed}" ]; then
  echo "  no canonical-scope changes at all — gate GREEN"
  exit 0
fi

echo "TIER 1 — module files (any diff allowed):"
echo "${changed}" | grep -E "${MODULE_FILES}" | sed 's/^/    ok   /' || echo "    (none)"
echo

echo "TIER 2 — registration files (additive only, zero deletions):"
while read -r f; do
  [ -z "${f}" ] && continue
  # numstat: <added> <deleted> <path>
  del=$(git diff --numstat "${BASE}...HEAD" -- "${f}" | awk '{print $2}')
  add=$(git diff --numstat "${BASE}...HEAD" -- "${f}" | awk '{print $1}')
  if [ "${del:-0}" -eq 0 ]; then
    printf '    ok   %-40s +%s -0\n' "${f}" "${add:-0}"
  else
    printf '    FAIL %-40s +%s -%s  (deletions are not additive)\n' "${f}" "${add:-0}" "${del}"
    fail=1
  fi
done < <(echo "${changed}" | grep -E "${REGISTRATION_FILES}")
echo

echo "FORBIDDEN — anything else in ${SCOPE}:"
others=$(echo "${changed}" | grep -Ev "${MODULE_FILES}" | grep -Ev "${REGISTRATION_FILES}")
if [ -n "${others}" ]; then
  echo "${others}" | sed 's/^/    FAIL /'
  fail=1
else
  echo "    (none)"
fi
echo

# ---- TIER 3: build identity ------------------------------------------------
# The ONE canonical-path edit the module is allowed outside its own files: the
# cfg-gated declare_id! block that repoints a --features fp-scratch build at the
# throwaway devnet program. Anchor 0.32 checks the declared id at dispatch
# (anchor-syn entry.rs:52 -> DeclaredProgramIdMismatch 4100), so a scratch deploy
# is impossible without it.
#
# Tier 2 would already let this through as an additive lib.rs diff — git sees
# pure insertion because the original declare_id line survives verbatim inside
# the block. That is too weak. Tier 3 NAMES the block and proves it is free.
#
# Skip the (slow, Linux-only) build proof with FP_GATE_SKIP_IDENTITY=1 for a
# quick structural check; CI and any pre-push run must NOT skip it.
echo "TIER 3 — build identity (cfg-gated declare_id):"
T3_MARKER="FP-ORACLE SCRATCH BUILD IDENTITY"
if grep -q "${T3_MARKER}" programs/opta/src/lib.rs 2>/dev/null; then
  # The scratch id may appear ONLY inside that block, and ONLY under cfg.
  scratch_hits=$(grep -c 'declare_id!("E9XHfJr4ExaLYafGzcKk6Lnem5KsrcM3LJdXgvwLqJpS")' programs/opta/src/lib.rs)
  cfg_hits=$(grep -c '#\[cfg(feature = "fp-scratch")\]' programs/opta/src/lib.rs)
  canon_hits=$(grep -c 'declare_id!("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq")' programs/opta/src/lib.rs)
  if [ "${scratch_hits}" -eq 1 ] && [ "${cfg_hits}" -eq 1 ] && [ "${canon_hits}" -eq 1 ]; then
    printf '    ok   block shape: 1 scratch id, 1 cfg guard, 1 canonical id
'
  else
    printf '    FAIL block shape: scratch=%s cfg=%s canonical=%s (expected 1/1/1)
'       "${scratch_hits}" "${cfg_hits}" "${canon_hits}"
    fail=1
  fi
  # The scratch id must appear NOWHERE else under programs/opta/src.
  stray=$(grep -rl "E9XHfJr4ExaLYafGzcKk6Lnem5KsrcM3LJdXgvwLqJpS" programs/opta/src 2>/dev/null | grep -v '^programs/opta/src/lib.rs$' || true)
  if [ -n "${stray}" ]; then
    echo "${stray}" | sed 's/^/    FAIL scratch id leaked into /'
    fail=1
  else
    printf '    ok   scratch id confined to lib.rs
'
  fi
  if [ "${FP_GATE_SKIP_IDENTITY:-0}" = "1" ]; then
    printf '    SKIP identity proof (FP_GATE_SKIP_IDENTITY=1) — do not skip before a push
'
  elif bash scripts/fp-oracle-identity-proof.sh >/tmp/_fp_identity.log 2>&1; then
    printf '    ok   identity proof: feature-free build is byte-identical to ungated
'
    grep -E '^  (gated|canonical)' /tmp/_fp_identity.log | sed 's/^/      /'
  else
    printf '    FAIL identity proof — the cfg gate now changes the production binary
'
    tail -6 /tmp/_fp_identity.log | sed 's/^/      /'
    fail=1
  fi
else
  printf '    (block absent — plug ceremony has removed it, or it is not yet added)
'
fi
echo

if [ "${fail}" -ne 0 ]; then
  echo "CANONICAL PATH TOUCHED — STOP."
  echo "If this is the deliberate arm-6-sites commit, the plug ceremony has begun:"
  echo "say so explicitly and get the P0/P1 gate, do not edit this script."
  exit 1
fi

echo "gate GREEN — module is still detachable."
exit 0
