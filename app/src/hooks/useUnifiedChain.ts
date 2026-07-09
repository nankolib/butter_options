// useUnifiedChain — exchange-spec Pass F data collapse (Pass 0, unwired).
// One row per series + legacy per-event vault, provenance-marked, in the
// unified-chain shape Pass 1's GRID will render. Returns the shape only.
//
// NOTE: this is a NEW, parallel data hook. The existing useTradeData (which the
// current Trade page renders from) is left untouched — Pass 0 is non-visual.
import { useCallback, useEffect, useState } from "react";
import { useProgram } from "./useProgram";
import { fetchUnifiedChain, type UnifiedChainRow } from "../utils/exchangeData";

export type { UnifiedChainRow } from "../utils/exchangeData";

export function useUnifiedChain() {
  const { program } = useProgram();
  const [rows, setRows] = useState<UnifiedChainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async () => {
    if (!program) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchUnifiedChain(program.provider.connection, program.programId));
      setLoaded(true);
    } catch (e: any) {
      // Keep the previously-loaded rows on failure (a wallet-connect refetch or a
      // rate-limited/timed-out scan must NOT blank an already-rendered chain).
      // The timeout in coalescedProgramAccounts guarantees this resolves.
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => { void refetch(); }, [refetch]);

  return { rows, loading, error, loaded, refetch };
}
