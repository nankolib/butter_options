import { useCallback, useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
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

export function useConnectionState(wallet: WalletConnection) {
  const [phase, setPhase] = useState<ConnectionPhase>(
    wallet.account ? "connected" : "disconnected"
  );
  const [error, setError] = useState<string | null>(null);

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
    account: wallet.account ?? null,
    connect,
    disconnect
  };
}
