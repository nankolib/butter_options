import type { FC } from "react";
import { useMemo, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { showToast } from "./Toast";
import { inferClusterFromUrl } from "../utils/env";

/**
 * DevnetSolButton — self-gating "Get Test SOL" (0.05 SOL for gas).
 *
 * Renders ONLY when a wallet is connected AND the inferred cluster is devnet
 * (hidden on any mainnet config). Routes through the server-side faucet
 * (app/api/faucet.ts, kind:"sol") — the faucet wallet signs a fixed 0.05 SOL
 * transfer with a durable 4h per-wallet cooldown. This replaced client-side
 * connection.requestAirdrop, which couldn't enforce an amount and was
 * unreliable against the public devnet faucet.
 *
 * Sibling of DevnetFaucetButton — both mount in AppNav (the nav actually shown
 * on the live trader routes; the global Header is hidden via HEADER_HIDDEN_PATHS).
 */
export const DevnetSolButton: FC<{ className?: string }> = ({ className }) => {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [sending, setSending] = useState(false);
  const isDevnet = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint) === "devnet",
    [connection.rpcEndpoint],
  );

  if (!connected || !isDevnet) return null;

  const handleAirdrop = async () => {
    if (!publicKey) return;
    setSending(true);
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), kind: "sol" }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        if (res.status === 503) {
          showToast({ type: "error", title: "Faucet not configured", message: data.error || "Server faucet key is not set yet." });
        } else if (res.status === 429) {
          showToast({ type: "error", title: "Slow down", message: data.error || "Airdrop cooldown active — try again later." });
        } else {
          showToast({ type: "error", title: "Airdrop failed", message: data.error || "Try again in a minute." });
        }
        return;
      }
      const sol = typeof data.sol === "number" ? data.sol : 0.05;
      showToast({ type: "success", title: `Airdropped ${sol} SOL!`, message: "Devnet SOL for transaction fees." });
    } catch (err: any) {
      console.error("SOL airdrop error:", err);
      showToast({ type: "error", title: "Airdrop failed", message: err?.message || "Network error." });
    } finally {
      setSending(false);
    }
  };

  return (
    <button type="button" onClick={handleAirdrop} disabled={sending} className={className}>
      {sending ? "Sending…" : "Get Test SOL"}
    </button>
  );
};

export default DevnetSolButton;
