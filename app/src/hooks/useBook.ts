// useBook — exchange limit-book read hook (Pass 0, unwired).
// Enumerates RestingOrder accounts via raw getProgramAccounts + manual parse.
import { useCallback, useEffect, useState } from "react";
import { useProgram } from "./useProgram";
import { fetchBook, indexBook, type BookOrder } from "../utils/exchangeData";

export type { BookOrder } from "../utils/exchangeData";

export function useBook() {
  const { program } = useProgram();
  const [orders, setOrders] = useState<BookOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!program) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      setOrders(await fetchBook(program.provider.connection, program.programId));
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => { void refetch(); }, [refetch]);

  return { orders, byOptionMint: indexBook(orders), loading, error, refetch };
}
