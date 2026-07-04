import type { FC } from "react";
import { useMemo, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { showToast } from "./Toast";
import { inferClusterFromUrl } from "../utils/env";

/**
 * DevnetFaucetButton — self-gating "Get Test USDC" control.
 *
 * Renders ONLY when a wallet is connected AND the inferred cluster is devnet
 * (kept off any mainnet config). Calls the server-side faucet route
 * (app/api/faucet.ts, H-04) — the browser holds no signing key.
 *
 * Extracted so it can live in AppNav (the nav actually mounted on the live
 * trader routes) rather than the global Header, which App.tsx hides on every
 * current route via HEADER_HIDDEN_PATHS. `className` lets each host style it to
 * its own surface (AppNav paper vs Header dark).
 */
export const DevnetFaucetButton: FC<{ className?: string }> = ({ className }) => {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [minting, setMinting] = useState(false);
  const isDevnet = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint) === "devnet",
    [connection.rpcEndpoint],
  );

  // Hidden off-devnet or when disconnected — never renders on a mainnet config.
  if (!connected || !isDevnet) return null;

  const handleUsdcFaucet = async () => {
    if (!publicKey) return;
    setMinting(true);
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        if (res.status === 503) {
          showToast({ type: "error", title: "Faucet not configured", message: data.error || "Server faucet key is not set yet." });
        } else if (res.status === 429) {
          showToast({ type: "error", title: "Slow down", message: data.error || "Faucet cooldown active — try again shortly." });
        } else {
          showToast({ type: "error", title: "USDC faucet failed", message: data.error || "Try again in a minute." });
        }
        return;
      }
      const usd = typeof data.balance === "number" ? `$${data.balance.toLocaleString()} USDC` : "USDC";
      showToast({ type: "success", title: "Got test USDC!", message: `Your balance: ${usd}` });
    } catch (err: any) {
      console.error("USDC faucet error:", err);
      showToast({ type: "error", title: "USDC faucet failed", message: err?.message || "Network error." });
    } finally {
      setMinting(false);
    }
  };

  return (
    <button type="button" onClick={handleUsdcFaucet} disabled={minting} className={className}>
      {minting ? "Sending…" : "Get Test USDC"}
    </button>
  );
};

export default DevnetFaucetButton;
