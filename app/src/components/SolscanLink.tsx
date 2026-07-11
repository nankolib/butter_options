// =============================================================================
// SolscanLink — the canonical terminal on-chain drill-down glyph (cross-page).
// =============================================================================
//
// One glyph style everywhere an on-chain identity renders: a tiny external-link
// icon that opens Solscan for the right kind + cluster. Reads the cluster from
// the active connection so devnet/mainnet swap automatically.
//
//   kind="tx"      → /tx/{sig}        (transaction signature)
//   kind="token"   → /token/{mint}    (option / series mint)
//   kind="account" → /account/{pda}   (vault · order · PDA · wallet)
//
// Styling: mono, --text-3 (l-faint) → --text-2 (l-muted) on hover, currentColor
// icon so it reads in both modes. Provenance rule still applies at the CALL SITE
// — never pass a feed/oracle account here.
//
// NOTE: the legacy paper-surface drill-down is `SolscanLinkLegacy` in
// utils/solscan.tsx (used only by the flagged-off legacy portfolio tables). This
// terminal component is canonical for all live surfaces.
// =============================================================================

import type { FC } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { inferClusterFromUrl, type Cluster } from "../utils/env";

export type SolscanKind = "tx" | "token" | "account";

/** Build a Solscan URL for the given kind + cluster. Localnet → Explorer fallback. */
export function solscanUrl(kind: SolscanKind, id: string, cluster: Cluster = "devnet"): string {
  const path = kind === "tx" ? "tx" : kind === "token" ? "token" : "account";
  if (cluster === "localnet") {
    const seg = kind === "tx" ? "tx" : "address";
    return `https://explorer.solana.com/${seg}/${id}?cluster=custom&customUrl=http://127.0.0.1:8899`;
  }
  const base = `https://solscan.io/${path}/${id}`;
  return cluster === "mainnet-beta" ? base : `${base}?cluster=${cluster}`;
}

export const SolscanLink: FC<{
  kind: SolscanKind;
  /** Signature (tx) or pubkey (token/account) — string or PublicKey. */
  id: string | PublicKey;
  /** Tooltip + aria-label noun, e.g. "vault", "mint", "transaction". */
  label?: string;
  className?: string;
}> = ({ kind, id, label, className }) => {
  const { connection } = useConnection();
  const cluster = inferClusterFromUrl(connection.rpcEndpoint);
  const key = typeof id === "string" ? id : id.toBase58();
  if (!key) return null;
  const noun = label ?? (kind === "tx" ? "transaction" : kind === "token" ? "mint" : "account");
  const url = solscanUrl(kind, key, cluster);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${noun} on Solscan`}
      aria-label={`Open ${noun} on Solscan`}
      data-testid="solscan-link"
      className={`inline-flex items-center justify-center text-l-faint transition-colors duration-200 hover:text-l-muted ${className ?? ""}`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  );
};

export default SolscanLink;
