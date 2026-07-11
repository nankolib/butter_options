// =============================================================================
// solscan.ts — Solscan account-URL helper + tiny `<SolscanLink />` component.
// =============================================================================
//
// Sister to env.ts's `getSolscanTxUrl`, which targets transactions. This
// targets accounts (vaults, mints, positions) and is consumed by the
// portfolio tables to give every row a one-click drill-down to Solscan
// for the underlying on-chain state.
//
// Cluster inference is shared with env.ts via `inferClusterFromUrl`, so
// devnet / mainnet swaps automatically when the connection RPC changes
// (matches the StatementHeader cluster label pattern).
//
// Pulled forward from the original Step 5 sequencing in WRITER_PF_PLAN.md
// because the WriterPositionsTable in Step 4 needs a working icon link
// before the buyer-side retrofit can layer on top.
// =============================================================================

import type { FC } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { type Cluster, inferClusterFromUrl } from "./env";

/**
 * Build a Solscan account URL with the right cluster query param.
 * Mainnet has no param (Solscan defaults to it); other clusters get
 * ?cluster=<name>. Localnet falls back to the standard Solana Explorer
 * with a customUrl param since Solscan can't index a local validator.
 */
export function solscanAccountUrl(
  pda: PublicKey | string,
  cluster: Cluster = "devnet",
): string {
  const key = typeof pda === "string" ? pda : pda.toBase58();
  if (cluster === "localnet") {
    return `https://explorer.solana.com/address/${key}?cluster=custom&customUrl=http://127.0.0.1:8899`;
  }
  if (cluster === "mainnet-beta") {
    return `https://solscan.io/account/${key}`;
  }
  return `https://solscan.io/account/${key}?cluster=${cluster}`;
}

type SolscanLinkProps = {
  /** Account to link to. Vault PDA for portfolio rows; could be any pubkey. */
  pda: PublicKey;
  /** Optional aria-label override; defaults to a truncated-key description. */
  ariaLabel?: string;
};

/**
 * Tiny circular icon link. Reads cluster from the active connection
 * context so devnet/mainnet swap automatically. Rendered inline at the
 * end of each portfolio row — opens Solscan in a new tab on click.
 *
 * Visual register: matches the row's editorial palette — 1px paper-rule
 * border, ink-60 base color, ink on hover, mono "↗" glyph at 11px.
 */
export const SolscanLinkLegacy: FC<SolscanLinkProps> = ({ pda, ariaLabel }) => {
  const { connection } = useConnection();
  const cluster = inferClusterFromUrl(connection.rpcEndpoint);
  const url = solscanAccountUrl(pda, cluster);
  const fallbackLabel = `View ${pda.toBase58().slice(0, 8)}… on Solscan`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={ariaLabel ?? fallbackLabel}
      title="Open on Solscan"
      className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-rule text-ink-muted hover:border-ink hover:text-ink transition-colors duration-300 ease-opta no-underline"
    >
      <span aria-hidden="true" className="font-mono text-[11px] leading-none">↗</span>
    </a>
  );
};

export default SolscanLinkLegacy;
