// =============================================================================
// assetRollup — per-asset profitability rollup (pure, React-free).
// =============================================================================
//
// One row per asset with any exposure (holdings or written). Fully honest from
// on-chain state + the SAME mark the ledgers display:
//   WRITER P&L      = Σ_vaults[ (premiumClaimed + claimable) − markPerCt × optionsSold ]
//   PREMIUM EARNED  = Σ (premiumClaimed + claimable)                 (all vaults)
//   HOLDINGS VALUE  = Σ position.currentValue                        (holdings)
//   CLAIMABLE       = Σ holder settled-ITM value + Σ writer claimable premium
//   COLLATERAL      = Σ collateralDeposited                          (all vaults)
//
// markPerCt (writer): settled → intrinsic payoutPerContract; live/pending →
// B-S at current spot (same source as holdings mark); spot missing → UNAVAILABLE
// → that vault is EXCLUDED from WRITER P&L (row tagged `partial`, value never 0).
//
// Honesty bias (approved): "sold outstanding" uses cumulative optionsSold —
// early-American-exercise reduction isn't tracked FE-side, so a live American
// vault's liability can be slightly OVERstated (P&L reads slightly worse, never
// better). Refinement rides the indexer arc.
// =============================================================================

import {
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../../utils/blackScholes";
import { usdcToNumber } from "../../../utils/format";
import type { Position } from "../positions";
import type { WriterRow } from "../writerRows";

export type AssetRollupRow = {
  asset: string;
  /** null = no writer exposure OR all marks unavailable (render "—"). */
  writerPnl: number | null;
  /** true = some writer vault's mark was unavailable and excluded from writerPnl. */
  partial: boolean;
  premiumEarned: number;
  holdingsValue: number;
  claimable: number;
  collateral: number;
};

type Accum = {
  asset: string;
  writerVaultCount: number;
  includedCount: number;
  pnlIncluded: number;
  premiumEarned: number;
  holdingsValue: number;
  claimable: number;
  collateral: number;
};

/** Writer mark per contract, or null when the live spot needed to price it is missing. */
function writerMarkPerContract(row: WriterRow, spot: number | undefined, now: number): number | null {
  if (row.settlementPrice != null) return row.payoutPerContract; // realized intrinsic
  if (!spot || spot <= 0) return null;
  const days = Math.max(0, (row.expiry - now) / 86400);
  if (days <= 0) return null;
  const vol = getDefaultVolatility(row.asset);
  return row.side === "call"
    ? calculateCallPremium(spot, row.strike, days, vol)
    : calculatePutPremium(spot, row.strike, days, vol);
}

export function buildAssetRollup(
  positions: Position[],
  writerRows: WriterRow[],
  spotPrices: Record<string, number>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  /** SLICE 2B — collateral committed to resting writer-asks, per asset.
   *  Optional so existing call sites and tests are unchanged; when supplied it
   *  is ADDED to the collateral column only. Nothing else in the rollup moves:
   *  a resting ask has no P&L and no premium until it is filled, so folding it
   *  into those would invent performance that has not happened. */
  askCollateralByAsset?: ReadonlyMap<string, number>,
): AssetRollupRow[] {
  const byAsset = new Map<string, Accum>();
  const get = (asset: string): Accum => {
    let a = byAsset.get(asset);
    if (!a) {
      a = { asset, writerVaultCount: 0, includedCount: 0, pnlIncluded: 0, premiumEarned: 0, holdingsValue: 0, claimable: 0, collateral: 0 };
      byAsset.set(asset, a);
    }
    return a;
  };

  // Writer side
  for (const row of writerRows) {
    const a = get(row.asset);
    const premium = row.premiumClaimed + usdcToNumber(row.claimableUsdc);
    a.premiumEarned += premium;
    a.collateral += row.collateralDeposited;
    a.claimable += usdcToNumber(row.claimableUsdc); // writer claimable premium
    a.writerVaultCount += 1;
    const mark = writerMarkPerContract(row, spotPrices[row.asset], nowSeconds);
    if (mark != null) {
      a.includedCount += 1;
      a.pnlIncluded += premium - mark * row.optionsSold;
    }
  }

  // SLICE 2B — resting-ask collateral. Added to the COLLATERAL column only.
  // Deliberately after the writer loop and before the holder loop, and touching
  // no other accumulator: an unfilled ask has produced no premium and no P&L, so
  // crediting it with either would report performance that has not happened.
  if (askCollateralByAsset) {
    for (const [asset, amount] of askCollateralByAsset) {
      if (!asset || amount <= 0) continue;
      get(asset).collateral += amount;
    }
  }

  // Holder side
  for (const p of positions) {
    const a = get(p.asset);
    a.holdingsValue += p.currentValue;
    if (p.state === "settled-itm") a.claimable += p.currentValue;
  }

  return [...byAsset.values()]
    .map((a): AssetRollupRow => {
      let writerPnl: number | null;
      let partial: boolean;
      if (a.writerVaultCount === 0) {
        writerPnl = null;
        partial = false; // holdings-only asset — no writer exposure, not "missing data"
      } else if (a.includedCount === 0) {
        writerPnl = null;
        partial = true; // has writer vaults but every mark was unavailable
      } else {
        writerPnl = a.pnlIncluded;
        partial = a.includedCount < a.writerVaultCount;
      }
      return {
        asset: a.asset,
        writerPnl,
        partial,
        premiumEarned: a.premiumEarned,
        holdingsValue: a.holdingsValue,
        claimable: a.claimable,
        collateral: a.collateral,
      };
    })
    .sort((x, y) => x.asset.localeCompare(y.asset));
}
