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
import { fetchBook, indexBook, suppressOrders, invalidateBookCache, type BookOrder } from "../utils/exchangeData";
import { subscribeMutations } from "../utils/mutationBus";

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

async function fetchInto(program: Program<any> | null, fresh = false): Promise<void> {
  if (!program) {
    sharedLoading = false;
    notify();
    return;
  }
  // `fresh` (mutation-triggered) forces a chain-fresh scan: drop the coalesced
  // RestingOrder cache AND this store's in-flight so we can't be served a
  // snapshot taken before the mutation. Normal mounts stay coalesced.
  if (fresh) {
    invalidateBookCache(program.programId);
    inflight = null;
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

// ---- Optimistic layer (instant UI before the reconcile refetch lands) -------
/** Remove orders NOW (cancel / fully-filled) + suppress them so a lagging scan
 *  can't re-add them before the chain index catches up. */
export function optimisticRemoveOrders(pubkeys: string[]): void {
  if (!pubkeys.length) return;
  suppressOrders(pubkeys);
  const drop = new Set(pubkeys);
  sharedOrders = sharedOrders.filter((o) => !drop.has(o.pubkey));
  notify();
}
/** Insert/replace an order NOW (just-posted resting order). Reconcile replaces it
 *  with chain truth under the same (derived) pubkey — no duplicate. */
export function optimisticUpsertOrder(order: BookOrder): void {
  sharedOrders = [order, ...sharedOrders.filter((o) => o.pubkey !== order.pubkey)];
  notify();
}

export function useBook() {
  const { program } = useProgram();
  // Re-render this consumer whenever the shared store changes.
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Ensure the store is (re)loaded when the program becomes available.
  useEffect(() => {
    void fetchInto(program ?? null);
  }, [program]);
  // A confirmed order mutation (from any surface) refetches the book chain-fresh.
  useEffect(() => subscribeMutations(() => { void fetchInto(program ?? null, true); }), [program]);
  const refetch = useCallback((fresh = false) => fetchInto(program ?? null, fresh), [program]);

  return {
    orders: sharedOrders,
    byOptionMint: indexBook(sharedOrders),
    loading: sharedLoading,
    error: sharedError,
    refetch,
  };
}
