// useBook — exchange limit-book read hook, backed by a SHARED module-level store.
//
// Every consumer (OrderTicket, OrderBookLadder, OpenOrders) subscribes to ONE
// cache. A single refetch() — triggered after any post/cancel/fill — invalidates
// all of them at once, so no consumer can dispatch against a stale/closed order
// pubkey (root cause of the 3012 AccountNotInitialized on market-buy). Mirrors
// the module-cache pattern in usePythPrices.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Program } from "@coral-xyz/anchor";
import { useProgram } from "./useProgram";
import { fetchBook, indexBook, type BookOrder } from "../utils/exchangeData";

export type { BookOrder } from "../utils/exchangeData";

// ---- Shared store (single source of truth across all useBook consumers) ------
let sharedOrders: BookOrder[] = [];
let sharedLoading = true;
let sharedError: string | null = null;
let version = 0; // bumped on every state change; the external-store snapshot
let inflight: Promise<void> | null = null;
const subscribers = new Set<() => void>();

function notify() {
  version += 1;
  for (const cb of subscribers) cb();
}

async function fetchInto(program: Program<any> | null): Promise<void> {
  if (!program) {
    sharedLoading = false;
    notify();
    return;
  }
  // Coalesce concurrent refetches (many consumers mount at once).
  if (inflight) return inflight;
  sharedLoading = true;
  sharedError = null;
  notify();
  inflight = (async () => {
    try {
      sharedOrders = await fetchBook(program.provider.connection, program.programId);
      sharedError = null;
    } catch (e: any) {
      sharedError = e?.message ?? String(e);
      sharedOrders = [];
    } finally {
      sharedLoading = false;
      inflight = null;
      notify();
    }
  })();
  return inflight;
}

const subscribe = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};
const getSnapshot = () => version;

export function useBook() {
  const { program } = useProgram();
  // Re-render this consumer whenever the shared store changes.
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Ensure the store is (re)loaded when the program becomes available.
  useEffect(() => {
    void fetchInto(program ?? null);
  }, [program]);
  const refetch = useCallback(() => fetchInto(program ?? null), [program]);

  return {
    orders: sharedOrders,
    byOptionMint: indexBook(sharedOrders),
    loading: sharedLoading,
    error: sharedError,
    refetch,
  };
}
