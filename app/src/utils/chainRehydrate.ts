// =============================================================================
// utils/chainRehydrate.ts — indexer JSON back into Anchor's runtime shape
// =============================================================================
//
// SEPARATED FROM chainReadPath.ts ON PURPOSE. That module reads
// `import.meta.env` and calls fetch, so it cannot be imported by a Node test
// runner. This one is pure, which is what lets the fidelity test compare these
// objects against Anchor's own decode of the SAME live accounts.
//
// THE RISK BEING MANAGED
//   Call sites consume Anchor's runtime shape: BN for u64/i64/u128, PublicKey
//   for keys, `{ american: {} }` objects for enums. Handing back a JSON string
//   where a BN is expected does not fail at the boundary — it fails far away, in
//   pricing or in a transaction argument, or silently misformats. Enum VARIANT
//   ORDER below must match the Rust enums exactly, because an off-by-one there
//   turns every call into a put.
// =============================================================================

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

const bn = (v: string | number): BN => new BN(String(v));
const pk = (v: string): PublicKey => new PublicKey(v);

export const OPTION_TYPE = ["call", "put"] as const;
export const VAULT_TYPE = ["epoch", "custom"] as const;
export const EXERCISE_STYLE = ["european", "american"] as const;

const enumOf = (variants: readonly string[], i: number): Record<string, object> => {
  const name = variants[i] ?? variants[0];
  return { [name]: {} };
};

export function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

// ---------------------------------------------------------------------------
// Rehydration — JSON back into Anchor's runtime shape
// ---------------------------------------------------------------------------


export function rehydrateSharedVault(r: any) {
  return {
    market: pk(r.market),
    optionType: enumOf(OPTION_TYPE, r.optionType),
    strikePrice: bn(r.strikePrice),
    expiry: bn(r.expiry),
    vaultType: enumOf(VAULT_TYPE, r.vaultType),
    totalCollateral: bn(r.totalCollateral),
    totalShares: bn(r.totalShares),
    vaultUsdcAccount: pk(r.vaultUsdcAccount),
    collateralMint: pk(r.collateralMint),
    totalOptionsMinted: bn(r.totalOptionsMinted),
    totalOptionsSold: bn(r.totalOptionsSold),
    netPremiumCollected: bn(r.netPremiumCollected),
    premiumPerShareCumulative: bn(r.premiumPerShareCumulative),
    isSettled: r.isSettled,
    settlementPrice: bn(r.settlementPrice),
    collateralRemaining: bn(r.collateralRemaining),
    creator: pk(r.creator),
    createdAt: bn(r.createdAt),
    bump: r.bump,
    carryRateBps: r.carryRateBps,
    exerciseStyle: enumOf(EXERCISE_STYLE, r.exerciseStyle),
    exercisedOptions: bn(r.exercisedOptions),
    earlyExercisePayout: bn(r.earlyExercisePayout),
    spreadBps: r.spreadBps,
    voided: r.voided,
    writerAskCollateralSwept: bn(r.writerAskCollateralSwept),
    writerAskEquivShares: bn(r.writerAskEquivShares),
  };
}

export function rehydrateVaultMint(r: any) {
  return {
    vault: pk(r.vault),
    writer: pk(r.writer),
    optionMint: pk(r.optionMint),
    premiumPerContract: bn(r.premiumPerContract),
    quantityMinted: bn(r.quantityMinted),
    quantitySold: bn(r.quantitySold),
    createdAt: bn(r.createdAt),
    bump: r.bump,
  };
}

export function rehydrateOptionsMarket(r: any) {
  return {
    assetName: r.assetName,
    // Anchor gives [u8; 32] as a number[]; the indexer serves hex.
    pythFeedId: hexToBytes(r.pythFeedId),
    assetClass: r.assetClass,
    bump: r.bump,
    oracleSource: r.oracleSource,
  };
}

export function rehydrateEpochConfig(r: any) {
  return {
    authority: pk(r.authority),
    weeklyExpiryDay: r.weeklyExpiryDay,
    weeklyExpiryHour: r.weeklyExpiryHour,
    monthlyEnabled: r.monthlyEnabled,
    minEpochDurationDays: r.minEpochDurationDays,
    bump: r.bump,
  };
}



export const REHYDRATE: Record<string, (r: any) => unknown> = {
  sharedVault: rehydrateSharedVault,
  vaultMint: rehydrateVaultMint,
  optionsMarket: rehydrateOptionsMarket,
  epochConfig: rehydrateEpochConfig,
};

// ---------------------------------------------------------------------------
// Freshness gate
// ---------------------------------------------------------------------------

/** Matches the server's own STALE_AFTER_SEC. Duplicated deliberately: the client
 *  must be able to refuse a stale answer even if the server stops flagging it. */
export const CLIENT_MAX_AGE_SEC = 90;

/**
 * May this response be served to the UI?
 *
 * Pure so the rule can be tested directly. The dangerous direction is
 * ACCEPTING something we should not: a restarted indexer answers for minutes
 * before its first scan lands, and an empty board delivered confidently is worse
 * than a slow one — it looks like "you own nothing" rather than "still loading".
 */
export function isServableEnvelope(body: any, maxAgeSec = CLIENT_MAX_AGE_SEC): boolean {
  if (!body || typeof body !== "object") return false;
  if (!Array.isArray(body.rows)) return false;
  if (body.stale === true) return false;
  const age = body.ageSec;
  if (typeof age !== "number" || !Number.isFinite(age)) return false;
  // Negative age means never refreshed, or a clock that moved backwards.
  if (age < 0 || age > maxAgeSec) return false;
  return true;
}
