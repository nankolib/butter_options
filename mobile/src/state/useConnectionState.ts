import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { ConnectionPhase } from "./models";
import { sanitizeUserVisibleText } from "./displaySafety";

type WalletAccount = {
  address: PublicKey;
};

type WalletConnection = {
  account?: WalletAccount;
  connect: () => Promise<WalletAccount>;
  disconnect: () => Promise<void>;
};

function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return sanitizeUserVisibleText(error.message);
  return "Connection declined";
}

function normalizeAccount(account: WalletAccount | undefined): WalletAccount | null {
  if (!account) return null;
  const addr = account.address as unknown;
  // A rehydrated session deserializes address as a base58 string (the wallet
  // lib's cache reviver only revives "publicKey", not "address"), so coerce
  // anything that isn't already a PublicKey back into one.
  const address = addr && typeof (addr as PublicKey).toBase58 === "function"
    ? (addr as PublicKey)
    : new PublicKey(addr as string);
  return { ...account, address };
}

export function useConnectionState(wallet: WalletConnection) {
  const [phase, setPhase] = useState<ConnectionPhase>(
    wallet.account ? "connected" : "disconnected"
  );
  const [error, setError] = useState<string | null>(null);

  // A rehydrated session deserializes `address` as a base58 string, so
  // normalizeAccount mints a FRESH PublicKey on every render. Consumers use the
  // result as a hook dependency (App.tsx -> useMarketState), where a new identity
  // each render re-runs the load effect, and that effect's cleanup bumps
  // requestId — silently invalidating the in-flight snapshot before it can call
  // setPhase. The screen then sits on skeletons forever with no error.
  // Memoize on the wallet's own account object, which the wallet lib holds stable
  // via a nanostores computed.
  const account = useMemo(() => normalizeAccount(wallet.account), [wallet.account]);

  useEffect(() => {
    if (wallet.account) {
      setPhase("connected");
      setError(null);
    } else if (phase === "connected") {
      setPhase("disconnected");
    }
  }, [wallet.account, phase]);

  const connect = useCallback(async (): Promise<WalletAccount | null> => {
    setPhase("connecting");
    setError(null);
    try {
      const account = await wallet.connect();
      setPhase("connected");
      return account;
    } catch (nextError) {
      setError(connectionErrorMessage(nextError));
      setPhase("rejected");
      return null;
    }
  }, [wallet]);

  const disconnect = useCallback(async () => {
    try {
      await wallet.disconnect();
    } finally {
      setPhase("disconnected");
      setError(null);
    }
  }, [wallet]);

  return {
    phase,
    error,
    account,
    connect,
    disconnect
  };
}
