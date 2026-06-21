// useSeries — canonical series-record read hook (Pass 0, unwired).
// Enumerates sentineled series VaultMint records via raw getProgramAccounts.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useProgram } from "./useProgram";
import { fetchSeries, type SeriesRecord } from "../utils/exchangeData";

export type { SeriesRecord } from "../utils/exchangeData";

export function useSeries() {
  const { program } = useProgram();
  const [series, setSeries] = useState<SeriesRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!program) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      setSeries(await fetchSeries(program.provider.connection, program.programId));
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setSeries([]);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => { void refetch(); }, [refetch]);

  const byOptionMint = useMemo(
    () => new Map(series.map((s) => [s.optionMint, s])),
    [series],
  );

  return { series, byOptionMint, loading, error, refetch };
}
