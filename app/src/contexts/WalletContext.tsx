import { FC, ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";
import { EXPECTED_CLUSTER } from "../utils/constants";
import { inferClusterFromUrl } from "../utils/env";

// Import wallet adapter CSS
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * WalletContextProvider wraps the entire app with Solana wallet connectivity.
 *
 * - Connects to devnet RPC
 * - Supports Phantom wallet (primary for hackathon demo)
 * - Provides the wallet modal UI for connecting/disconnecting
 */
export const WalletContextProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  // VITE_RPC_URL from app/.env.local — falls back to public devnet if unset.
  //
  // MED-3 cluster coherence guard: assert the inferred cluster matches the
  // build-time EXPECTED_CLUSTER. Lockstep with PROGRAM_ID / DEVNET_USDC_MINT
  // in constants.ts — a mainnet RPC URL with stale constants would silently
  // point the app at mainnet while using devnet artifacts. The throw fails
  // the React render at boot, surfacing the mismatch immediately rather
  // than producing confusing "AccountNotFound" errors at every action.
  const endpoint = useMemo(
    () => {
      const url = import.meta.env.VITE_RPC_URL || clusterApiUrl("devnet");
      const inferred = inferClusterFromUrl(url);
      if (inferred !== EXPECTED_CLUSTER) {
        throw new Error(
          `[opta] cluster mismatch: RPC URL infers "${inferred}" but build expects "${EXPECTED_CLUSTER}". ` +
          `Update PROGRAM_ID, EXPECTED_CLUSTER, and DEVNET_USDC_MINT in lockstep — see constants.ts header.`,
        );
      }
      return url;
    },
    [],
  );

  // Wallets to support. Phantom is the primary wallet for Solana.
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
