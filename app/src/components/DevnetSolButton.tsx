import type { FC } from "react";
import { useMemo, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { showToast } from "./Toast";
import { inferClusterFromUrl } from "../utils/env";

/**
 * DevnetSolButton — self-gating "Get Test SOL" airdrop (1 SOL for gas).
 *
 * Renders ONLY when a wallet is connected AND the inferred cluster is devnet
 * (hidden on any mainnet config). Uses the public devnet airdrop faucet
 * (connection.requestAirdrop), which can be rate-limited.
 *
 * Sibling of DevnetFaucetButton — both mount in AppNav (the nav actually shown
 * on the live trader routes; the global Header is hidden via HEADER_HIDDEN_PATHS).
 */
export const DevnetSolButton: FC<{ className?: string }> = ({ className }) => {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [airdropping, setAirdropping] = useState(false);
  const isDevnet = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint) === "devnet",
    [connection.rpcEndpoint],
  );

  if (!connected || !isDevnet) return null;

  const handleAirdrop = async () => {
    if (!publicKey) return;
    setAirdropping(true);
    try {
      const sig = await connection.requestAirdrop(publicKey, 1_000_000_000); // 1 SOL
      await connection.confirmTransaction(sig, "confirmed");
      showToast({ type: "success", title: "Airdropped 1 SOL!", message: "You now have devnet SOL for transaction fees." });
    } catch {
      showToast({ type: "error", title: "Airdrop failed", message: "Devnet may be rate-limited. Try again in a minute." });
    } finally {
      setAirdropping(false);
    }
  };

  return (
    <button type="button" onClick={handleAirdrop} disabled={airdropping} className={className}>
      {airdropping ? "Sending…" : "Get Test SOL"}
    </button>
  );
};

export default DevnetSolButton;
