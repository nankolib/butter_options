import { useMemo } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Opta } from "../idl/opta";
import idl from "../idl/opta.json";
import { withPollingConfirm } from "../utils/txOutcome";

/**
 * Hook that returns an Anchor Program instance for Opta.
 *
 * If no wallet is connected, returns a read-only provider (can fetch accounts
 * but cannot send transactions).
 */
export function useProgram(): {
  program: Program<Opta> | null;
  provider: AnchorProvider | null;
} {
  const { connection: rawConnection } = useConnection();
  const wallet = useAnchorWallet();

  // Confirmation goes over HTTP polling, not a websocket. web3.js's
  // signature-only confirmTransaction has no polling path at all, so a
  // websocket that cannot open turns every single send into a 30s timeout —
  // which is exactly what prod did on 2026-08-09 (measured: 902 ms by polling
  // vs 30 468 ms by socket wait). See txOutcome.withPollingConfirm.
  //
  // Wrapped here rather than at the send sites so it covers .rpc(),
  // sendAndConfirm and direct confirmTransaction calls alike, and so a future
  // send path inherits it without having to remember.
  const connection = useMemo(() => withPollingConfirm(rawConnection), [rawConnection]);

  return useMemo(() => {
    // Create a provider — if no wallet, use a dummy for read-only access
    const provider = wallet
      ? new AnchorProvider(connection, wallet, { commitment: "confirmed" })
      : null;

    if (!provider) {
      // Read-only: create a minimal provider for fetching accounts
      try {
        const readOnlyProvider = {
          connection,
        } as any;
        const program = new Program(
          idl as any,
          readOnlyProvider,
        ) as unknown as Program<Opta>;
        return { program, provider: null };
      } catch {
        return { program: null, provider: null };
      }
    }

    const program = new Program(
      idl as any,
      provider,
    ) as unknown as Program<Opta>;
    return { program, provider };
  }, [connection, wallet]);
}
