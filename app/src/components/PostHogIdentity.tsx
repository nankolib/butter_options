import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import posthog from "posthog-js";

/**
 * Wires the Solana wallet's connected pubkey into PostHog as the
 * identified user. Mounts under WalletContextProvider (via AppShell)
 * so useWallet() resolves. Returns null — no DOM.
 *
 * On pubkey present: posthog.identify(pubkey.toBase58())
 * On pubkey absent (initial render OR disconnect): posthog.reset()
 *
 * posthog-js no-ops gracefully when VITE_POSTHOG_KEY is unset and
 * .init() was therefore skipped in main.tsx — no guard needed here.
 */
export function PostHogIdentity(): null {
  const { publicKey } = useWallet();

  useEffect(() => {
    if (publicKey) {
      posthog.identify(publicKey.toBase58());
    } else {
      posthog.reset();
    }
  }, [publicKey]);

  return null;
}
