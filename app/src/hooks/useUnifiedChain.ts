// useUnifiedChain — exchange-spec Pass F data collapse (Pass 0, unwired).
// One row per series + legacy per-event vault, provenance-marked, in the
// unified-chain shape Pass 1's GRID will render. Returns the shape only.
//
// NOTE: this is a NEW, parallel data hook. The existing useTradeData (which the
// current Trade page renders from) is left untouched — Pass 0 is non-visual.
import { useCallback, useEffect, useState } from "react";
import { useProgram } from "./useProgram";
import { fetchUnifiedChain, invalidateBookCache, invalidateVaultCache, type UnifiedChainRow } from "../utils/exchangeData";
import { subscribeMutations } from "../utils/mutationBus";

export type { UnifiedChainRow } from "../utils/exchangeData";

/** @param market Optional market pubkey — RENDERING context (the board on
 *  screen). Narrows the vault read; the book is never narrowed.
 *
 *  THREE STATES, matching useVaults:
 *    undefined -> every board
 *    "<pubkey>" -> that board only
 *    null       -> the caller WILL narrow but the board is not resolved yet;
 *                  fetch nothing and stay loading.
 *
 *  Without the third state /trade fetches every vault on first render and then
 *  fetches the board again once the asset resolves. The asset dropdown does not
 *  depend on this: TradePageV2 unions these rows with td.availableAssets, which
 *  is markets-derived and loads independently. */
export function useUnifiedChain(market?: string | null) {
  const { program } = useProgram();
  const [rows, setRows] = useState<UnifiedChainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refetch = useCallback(async (fresh = false) => {
    if (!program) { setLoading(false); return; }
    // null = "narrowing, board not resolved yet". Stay loading rather than
    // reporting an empty chain over data that is about to arrive.
    if (market === null) return;
    // `fresh` (mutation-triggered) drops the coalesced vault + book scans so the
    // chain's best bid/ask reflect the just-confirmed order change, not a snapshot
    // taken before it. Normal refetches stay coalesced.
    if (fresh) {
      invalidateVaultCache(program.programId);
      invalidateBookCache(program.programId);
    }
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchUnifiedChain(program.provider.connection, program.programId, market ?? undefined));
      setLoaded(true);
    } catch (e: any) {
      // Keep the previously-loaded rows on failure (a wallet-connect refetch or a
      // rate-limited/timed-out scan must NOT blank an already-rendered chain).
      // The timeout in coalescedProgramAccounts guarantees this resolves.
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
    // `market` is a dependency: switching boards must refetch the incoming one.
  }, [program, market]);

  useEffect(() => { void refetch(); }, [refetch]);
  // A confirmed order mutation refetches the chain chain-fresh (fixes the grid's
  // bid/ask staying stale after a cancel fired from OpenOrders / the inspector).
  useEffect(() => subscribeMutations(() => { void refetch(true); }), [refetch]);

  return { rows, loading, error, loaded, refetch };
}
