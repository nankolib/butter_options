// ============================================================================
// crank/vaultShellRule.ts — PURE vault "shell" classifier for the SB cutover.
// ============================================================================
// Extracted from _cutover_rebirth.ts so the close/orphan decision is unit-
// testable in isolation (no chain). A "shell" is a vault safe to ORPHAN under
// the SB rebirth (same market PDA) because it holds NOTHING real. Everything
// else is NON-SHELL and must be settled/drained/discharged, or closed over by an
// EXPLICIT founder ruling (--override).
//
// This MUST match the hardened scripts/preflight_close_market.ts standard: a
// vault is inert ONLY if empty on ALL axes — funds AND live positions. The old
// cutover rule looked at SharedVault fields only (total_collateral / total_shares
// / vault_usdc) and so mis-classified EWwhESru (a settled/void husk whose value
// lives in its writer-ask POT + an option HOLDER) as an empty shell.
// ============================================================================

export interface VaultShellInput {
  /** vault_usdc token-account balance (base units). */
  vaultUsdc: bigint;
  /** writer_ask_pot_usdc PDA token-account balance (base units). The pot is
   *  NOT a SharedVault field — it is where resting-ask premium/collateral sits,
   *  and it survives settlement/void. EWwhESru's $246 lives here. */
  potUsdc: bigint;
  /** option-mint holders (amount>0) owned by a REAL on-curve wallet. A single
   *  one is a genuine external claim → hard STOP class (never a silent shell). */
  userHolders: number;
  /** option-mint holders (amount>0) owned by an OFF-curve PDA (protocol escrow /
   *  protocol_state). Not a user, but still real tokens → non-shell (discharge). */
  protocolHolders: number;
  /** writerPosition accounts with shares>0 (pool writers). */
  writers: number;
  /** writerAskPosition accounts with collateral_committed>0 (ask backers). */
  backers: number;
  /** SharedVault.total_collateral — a STALE historical counter (drained vaults
   *  keep tc>0 with $0 real funds). Informational ONLY; never decides shell. */
  staleTotalCollateral: bigint;
  /** SharedVault.total_shares — same stale-counter caveat. Informational. */
  staleTotalShares: bigint;
}

export interface VaultShellVerdict {
  /** true ⇒ empty on every axis ⇒ safe to orphan under the SB rebirth. */
  isShell: boolean;
  /** true ⇒ a real on-curve wallet holds a position. This is NOT a founder-owned
   *  orphan — closing over it forfeits a third party's claim. Hard STOP unless an
   *  explicit ruling accepts that. */
  hasUserClaim: boolean;
  /** human-readable classification, mirrors preflight's per-vault line. */
  reason: string;
}

export function classifyVaultShell(s: VaultShellInput): VaultShellVerdict {
  // Preflight parity: block on REAL state only. total_collateral / total_shares
  // are stale historical counters (drained vaults keep them >0 with $0 funds), so
  // they NEVER decide shell — they are informational. A vault is orphanable ONLY
  // if it holds no funds (vault_usdc AND pot) AND carries no live position
  // (any holder, writer, or backer).
  const hasFunds = s.vaultUsdc > 0n || s.potUsdc > 0n;
  const hasPosition = s.userHolders > 0 || s.protocolHolders > 0 || s.writers > 0 || s.backers > 0;
  const isShell = !hasFunds && !hasPosition;
  const hasUserClaim = s.userHolders > 0;

  let reason: string;
  if (isShell) {
    reason = s.staleTotalCollateral > 0n
      ? `inert (stale tc=$${(Number(s.staleTotalCollateral) / 1e6).toFixed(2)}, $0 funds, no positions → orphanable)`
      : "inert (empty shell → orphanable)";
  } else {
    const parts: string[] = [];
    if (s.vaultUsdc > 0n) parts.push(`vault_usdc=$${(Number(s.vaultUsdc) / 1e6).toFixed(2)}`);
    if (s.potUsdc > 0n) parts.push(`pot_usdc=$${(Number(s.potUsdc) / 1e6).toFixed(2)}`);
    if (s.userHolders > 0 || s.protocolHolders > 0 || s.writers > 0 || s.backers > 0)
      parts.push(`positions userHolders=${s.userHolders} protoHolders=${s.protocolHolders} writers=${s.writers} backers=${s.backers}`);
    reason = (hasUserClaim ? "NON-SHELL/USER-CLAIM " : "NON-SHELL ") + parts.join(" ");
  }
  return { isShell, hasUserClaim, reason };
}
