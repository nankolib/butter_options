// =============================================================================
// pnl.ts — realized PnL + the conservation identity (PURE)
// =============================================================================
//
// THE MODEL. Every USDC movement on the tape is a transfer between exactly three
// kinds of holder:
//
//     WALLETS   users and bots
//     VAULTS    program-held collateral + premium pots (SharedVault PDAs)
//     TREASURY  protocol fees and swept dust
//
// We only ever observe DELTAS, never balances, and every tape event is a
// transfer between two of the three. So the books must close exactly:
//
//     Σ_wallets (usdc_in - usdc_out)          [W]
//   + Σ_vaults  vault_balance                 [V]
//   + Σ         fees_to_treasury              [F]
//   + Σ         unattributed_payouts          [U]
//   = 0
//
// [U] is a NAMED term, not a fudge. `HoldersFinalized` / `WritersFinalized` are
// batch payouts that carry only an AGGREGATE total — the tape genuinely does not
// say which wallets were paid. Those dollars leave a vault and land in wallets we
// cannot name. Booking them explicitly is honest; folding them into a residual
// would hide a known hole.
//
// PER-WALLET
//
//     realized_pnl(w) = [ usdc_in(w) - usdc_out(w) ] + deployed(w)
//
//   deployed(w) is w's attributable share of the vaults it funded — pro-rata by
//   net deposits. A wallet that deposits 100 and has not withdrawn shows
//   (in-out) = -100, deployed = +100, realized = 0: capital at work is not a loss.
//
// FEE SEMANTICS verified at fill_order.rs:90 — `counterparty_share = total - fee`,
// so the BUYER pays `total`, the SELLER receives `total - fee`, and `fee` leaves
// the participant set.
//
// THE RESIDUAL IS REPORTED, NEVER TUNED. A non-zero residual means a movement the
// allowlist still does not see; the number is the finding.
// =============================================================================

import type { TapeSource } from "../db";
import { ORDER_KIND } from "../tape/allowlist";

export interface WalletFlows {
  wallet: string;
  usdcIn: bigint;
  usdcOut: bigint;
  deployed: bigint;
  realizedPnl: bigint;
  volumeUsdc: bigint;
  writerPremium: bigint;
  /** Net deposits into vaults — the basis for pro-rata `deployed` attribution. */
  netDeposits: bigint;
}

export interface Reconciliation {
  walletNet: bigint;
  vaultBalance: bigint;
  fees: bigint;
  unattributedPayouts: bigint;
  /** W + V + F + U. Zero when every movement is accounted for. */
  residual: bigint;
  residualRatio: number;
  grossFlows: bigint;
  totalRealizedPnl: bigint;
  /** Vault balance that could not be attributed to any depositor. */
  unattributedVaultBalance: bigint;
}

export interface PnlResult {
  byWallet: Map<string, WalletFlows>;
  vaultBalances: Map<string, bigint>;
  reconciliation: Reconciliation;
}

const big = (n: number | null | undefined): bigint => BigInt(Math.trunc(n ?? 0));

const blank = (wallet: string): WalletFlows => ({
  wallet,
  usdcIn: 0n,
  usdcOut: 0n,
  deployed: 0n,
  realizedPnl: 0n,
  volumeUsdc: 0n,
  writerPremium: 0n,
  netDeposits: 0n,
});

export function computePnl(tape: TapeSource): PnlResult {
  const byWallet = new Map<string, WalletFlows>();
  const get = (w: string) => {
    let r = byWallet.get(w);
    if (!r) byWallet.set(w, (r = blank(w)));
    return r;
  };

  const vaultBalances = new Map<string, bigint>();
  const vaultMove = (v: string | null, delta: bigint) => {
    if (!v || delta === 0n) return;
    vaultBalances.set(v, (vaultBalances.get(v) ?? 0n) + delta);
  };
  /** Deposits per (wallet, vault), for pro-rata attribution of what's left. */
  const depositsByVault = new Map<string, Map<string, bigint>>();
  const noteDeposit = (w: string, v: string | null, delta: bigint) => {
    if (!v) return;
    let m = depositsByVault.get(v);
    if (!m) depositsByVault.set(v, (m = new Map()));
    m.set(w, (m.get(w) ?? 0n) + delta);
    get(w).netDeposits += delta;
  };

  let fees = 0n;
  let unattributedPayouts = 0n;

  const openEscrow = new Map<string, bigint>();
  const escrowOwner = new Map<string, string>();

  for (const e of tape()) {
    const amt = big(e.amount_usdc);
    let fields: Record<string, string> = {};
    try {
      fields = JSON.parse(e.fields_json) as Record<string, string>;
    } catch {
      /* never let a parse kill accounting */
    }
    const fee = BigInt(fields.fee ?? "0");

    switch (e.name) {
      case "OrderFilled": {
        const taker = e.wallet;
        const maker = e.counterparty;
        fees += fee;

        if (e.kind === ORDER_KIND.Bid) {
          // Resting BID: maker buys, taker sells. Maker's USDC was escrowed.
          if (taker) {
            get(taker).usdcIn += amt - fee;
            get(taker).volumeUsdc += amt;
          }
          if (maker) {
            get(maker).volumeUsdc += amt;
            const k = fields.order ?? "";
            const held = openEscrow.get(k) ?? 0n;
            openEscrow.set(k, held > amt ? held - amt : 0n);
          }
        } else {
          // Resting ASK: taker buys and pays the full total.
          if (taker) {
            get(taker).usdcOut += amt;
            get(taker).volumeUsdc += amt;
          }
          if (e.kind === ORDER_KIND.VaultPeg) {
            // The "maker" is the SharedVault PDA: premium lands in the vault and
            // is realised later via PremiumClaimed / post-settlement withdrawal.
            vaultMove(e.vault, amt - fee);
          } else if (maker) {
            get(maker).usdcIn += amt - fee;
            get(maker).volumeUsdc += amt;
            if (e.kind === ORDER_KIND.WriterAsk) get(maker).writerPremium += amt - fee;
          }
        }
        break;
      }

      case "OrderPosted":
        if (e.kind === ORDER_KIND.Bid && e.wallet) {
          get(e.wallet).usdcOut += amt;
          const k = fields.order ?? "";
          openEscrow.set(k, (openEscrow.get(k) ?? 0n) + amt);
          escrowOwner.set(k, e.wallet);
        }
        break;

      case "OrderCancelled":
      case "OrderSwept":
        if (e.kind === ORDER_KIND.Bid && e.wallet) {
          get(e.wallet).usdcIn += amt;
          openEscrow.set(fields.order ?? "", 0n);
        }
        break;

      case "VaultDeposited":
        if (e.wallet) {
          get(e.wallet).usdcOut += amt;
          vaultMove(e.vault, amt);
          noteDeposit(e.wallet, e.vault, amt);
        }
        break;

      case "VaultWithdrawn":
      case "VaultPostSettlementWithdraw":
      case "VaultReclaimed":
      case "WriterAskResidualWithdrawn":
        if (e.wallet) {
          get(e.wallet).usdcIn += amt;
          vaultMove(e.vault, -amt);
          noteDeposit(e.wallet, e.vault, -amt);
        }
        break;

      case "PremiumClaimed":
        if (e.wallet) {
          get(e.wallet).usdcIn += amt;
          get(e.wallet).writerPremium += amt;
          vaultMove(e.vault, -amt);
        }
        break;

      case "VaultPurchased":
        if (e.wallet) {
          get(e.wallet).usdcOut += amt;
          get(e.wallet).volumeUsdc += amt;
          vaultMove(e.vault, amt);
        }
        break;

      case "VaultListingFilled":
        fees += fee;
        if (e.wallet) {
          get(e.wallet).usdcOut += amt;
          get(e.wallet).volumeUsdc += amt;
        }
        if (e.counterparty) {
          get(e.counterparty).usdcIn += amt - fee;
          get(e.counterparty).volumeUsdc += amt;
        }
        break;

      case "VaultExercised":
        if (e.wallet) get(e.wallet).usdcIn += amt;
        vaultMove(e.vault, -amt);
        break;

      case "TriggerExecuted":
        if (!e.wallet) break;
        if (e.kind === 0) {
          get(e.wallet).usdcOut += amt; // StopEntryBuy pays premium
          get(e.wallet).volumeUsdc += amt;
        } else {
          get(e.wallet).usdcIn += amt; // TakeProfitSell receives payout
          get(e.wallet).volumeUsdc += amt;
        }
        break;

      // ---- Aggregate batch payouts: vault -> wallets we cannot name --------
      case "HoldersFinalized":
      case "WritersFinalized": {
        const paid = amt;
        vaultMove(e.vault, -paid);
        unattributedPayouts += paid;
        const dust = BigInt(fields.dust_swept_to_treasury ?? "0");
        if (dust > 0n) {
          vaultMove(e.vault, -dust);
          fees += dust;
        }
        break;
      }

      case "SettledWriterAskVaultClosed":
        vaultMove(e.vault, -amt);
        fees += amt;
        break;

      default:
        break;
    }
  }

  // ---- Attribute remaining vault balance to depositors, pro-rata ----------
  let unattributedVaultBalance = 0n;
  for (const [vault, balance] of vaultBalances) {
    if (balance <= 0n) continue;
    const deps = depositsByVault.get(vault);
    let totalPositive = 0n;
    if (deps) for (const d of deps.values()) if (d > 0n) totalPositive += d;
    if (!deps || totalPositive === 0n) {
      unattributedVaultBalance += balance;
      continue;
    }
    let assigned = 0n;
    const holders = [...deps.entries()].filter(([, d]) => d > 0n).sort(([a], [b]) => (a < b ? -1 : 1));
    holders.forEach(([w, d], i) => {
      const share = i === holders.length - 1 ? balance - assigned : (balance * d) / totalPositive;
      assigned += share;
      get(w).deployed += share;
    });
  }
  // Live bid escrow is deployed capital too (it never entered a vault).
  for (const [order, v] of openEscrow) {
    if (v <= 0n) continue;
    const owner = escrowOwner.get(order);
    if (owner) get(owner).deployed += v;
  }

  let totalRealized = 0n;
  let walletNet = 0n;
  let gross = 0n;
  for (const f of byWallet.values()) {
    f.realizedPnl = f.usdcIn - f.usdcOut + f.deployed;
    totalRealized += f.realizedPnl;
    walletNet += f.usdcIn - f.usdcOut;
    gross += f.usdcIn + f.usdcOut;
  }

  let vaultTotal = 0n;
  for (const b of vaultBalances.values()) vaultTotal += b;

  // Books close: W + V + F + U == 0. Bid escrow is already inside W (paid out at
  // OrderPosted) but is NOT in V, so add it back as still-held wallet capital.
  let liveEscrow = 0n;
  for (const v of openEscrow.values()) if (v > 0n) liveEscrow += v;

  const residual = walletNet + vaultTotal + fees + unattributedPayouts + liveEscrow;

  return {
    byWallet,
    vaultBalances,
    reconciliation: {
      walletNet,
      vaultBalance: vaultTotal,
      fees,
      unattributedPayouts,
      residual,
      residualRatio:
        gross === 0n ? 0 : Number(((residual < 0n ? -residual : residual) * 1_000_000n) / gross) / 1_000_000,
      grossFlows: gross,
      totalRealizedPnl: totalRealized,
      unattributedVaultBalance,
    },
  };
}
