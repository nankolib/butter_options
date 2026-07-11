import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "./useProgram";

const PROTOCOL_SEED = "protocol_v2";

/**
 * useIsAdmin — true iff the connected wallet matches `protocol_state.admin`.
 *
 * Source-of-truth wrapper around the on-chain ProtocolState fetch. Used to gate
 * admin-only CTAs (e.g. MigrateFeedTools). NOTE: market creation is permissionless
 * post-HIGH-5 — the New-market modal is connect-gated only and does NOT consult
 * this hook. Only MigrateFeedSection currently depends on it.
 *
 * Returns false when:
 *   - Wallet not connected (no admin to check)
 *   - Program not yet ready (fetch can't fire)
 *   - ProtocolState fetch in flight (no flash before knowing)
 *   - Fetch fails (degrade safe; non-admin majority sees the same state)
 *
 * The on-chain handlers are authoritative — admin gates here are
 * cosmetic UX, hiding buttons that would otherwise revert with
 * `Unauthorized` (code 6000).
 */
export function useIsAdmin(): boolean {
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!program || !publicKey) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(PROTOCOL_SEED)],
          program.programId,
        );
        const ps = await program.account.protocolState.fetch(pda);
        if (!cancelled) setIsAdmin(ps.admin.equals(publicKey));
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [program, publicKey]);

  return isAdmin;
}
