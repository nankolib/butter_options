// =============================================================================
// provenance.ts — Part A projection: where did this wallet's capital come from?
// =============================================================================
//
//   pct_faucet = faucet_in / (faucet_in + external_in)
//
// Profit-board eligibility (D5 from the spec): pct_faucet >= 0.90 AND
// faucet_in > 0. A wallet funded from outside devnet's faucet is not competing
// on the same footing, so it is excluded — and the REASON is recorded, because
// an unexplained exclusion looks like a bug to whoever reads the board.
//
// ⚠ external_in is only as complete as the ATA poller (D9, O(wallets), capped at
// OPTA_INDEXER_ATA_MAX). When the cap is hit the poller logs loudly; a wallet
// whose external inflows were never polled would look 100% faucet-funded and
// wrongly qualify. That is the single most important limitation of this module.
// =============================================================================

export const PROFIT_BOARD_MIN_PCT_FAUCET = 0.9;

export interface ProvenanceRow {
  wallet: string;
  faucetIn: number;
  externalIn: number;
  externalOut: number;
  pctFaucet: number | null;
  eligible: boolean;
  ineligibleReason: string | null;
}

export interface FlowRow {
  wallet: string;
  direction: string;
  source: string;
  amount_usdc: number;
}

export function computeProvenance(flows: readonly FlowRow[], wallets: readonly string[]): Map<string, ProvenanceRow> {
  const out = new Map<string, ProvenanceRow>();
  const ensure = (w: string): ProvenanceRow => {
    let r = out.get(w);
    if (!r) {
      out.set(
        w,
        (r = {
          wallet: w,
          faucetIn: 0,
          externalIn: 0,
          externalOut: 0,
          pctFaucet: null,
          eligible: false,
          ineligibleReason: null,
        }),
      );
    }
    return r;
  };

  for (const w of wallets) ensure(w);

  for (const f of flows) {
    const r = ensure(f.wallet);
    if (f.direction === "in" && f.source === "faucet") r.faucetIn += f.amount_usdc;
    else if (f.direction === "in") r.externalIn += f.amount_usdc;
    else if (f.direction === "out") r.externalOut += f.amount_usdc;
  }

  for (const r of out.values()) {
    const totalIn = r.faucetIn + r.externalIn;
    r.pctFaucet = totalIn > 0 ? r.faucetIn / totalIn : null;
    if (r.faucetIn <= 0) {
      r.eligible = false;
      r.ineligibleReason = "no faucet claim on record";
    } else if ((r.pctFaucet ?? 0) < PROFIT_BOARD_MIN_PCT_FAUCET) {
      r.eligible = false;
      r.ineligibleReason = `pct_faucet ${((r.pctFaucet ?? 0) * 100).toFixed(1)}% < 90%`;
    } else {
      r.eligible = true;
      r.ineligibleReason = null;
    }
  }
  return out;
}
