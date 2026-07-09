/**
 * mutationBus — a tiny module-level pub/sub so a confirmed order mutation (fired
 * from OrderTicket / OpenOrders / the docked inspector) can invalidate every data
 * hook that shows order/position state (useBook, useUnifiedChain, useTradeDockData)
 * regardless of component topology. Each hook subscribes and refetches on emit.
 *
 * Paired with an OPTIMISTIC layer (useBook.optimistic*) for instant UI + a
 * short suppression window (exchangeData) so a lagging getProgramAccounts can't
 * re-introduce a just-removed order before the chain index catches up.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeMutations(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function emitMutation(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* a subscriber throwing must not block the others */ }
  }
}
