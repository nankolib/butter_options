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

  const refetch = useCallback(async () => {
    if (!program) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchUnifiedChain(program.provider.connection, program.programId));
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => { void refetch(); }, [refetch]);

  return { rows, loading, error, refetch };
}
