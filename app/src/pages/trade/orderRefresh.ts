import type { Program } from "@coral-xyz/anchor";
import { invalidateBookCache, invalidateVaultCache, type BookOrder } from "../../utils/exchangeData";
import { optimisticRemoveOrders, optimisticUpsertOrder } from "../../hooks/useBook";
import { emitMutation } from "../../utils/mutationBus";

/**
 * refreshAfterMutation — the ONE post-confirmation refresh every order-mutating
 * call site invokes (post / cancel / fill·buy / write). Two layers:
 *
 *   OPTIMISTIC (instant): remove the cancelled/fully-filled order and/or insert
 *   the just-posted order in the shared book store, so the chain grid / book /
 *   open-orders react immediately (removed pubkeys are also SUPPRESSED so a
 *   lagging getProgramAccounts can't re-add them).
 *
 *   RECONCILE (chain truth): invalidate the coalesced RestingOrder + vault scans
 *   and emit on the mutation bus twice — now, and again after a short delay for
 *   getProgramAccounts index propagation — so every subscribed hook (useBook,
 *   useUnifiedChain, useTradeDockData) refetches fresh and replaces the optimistic
 *   state with what's actually on-chain.
 */
const RECONCILE_MS = 1300;

export function refreshAfterMutation(
  program: Program<any>,
  opts: { removed?: string[]; added?: BookOrder } = {},
): void {
  if (opts.removed?.length) optimisticRemoveOrders(opts.removed);
  if (opts.added) optimisticUpsertOrder(opts.added);

  const invalidateAndEmit = () => {
    invalidateBookCache(program.programId);
    invalidateVaultCache(program.programId);
    emitMutation();
  };
  invalidateAndEmit();                          // immediate (suppression guards removed)
  setTimeout(invalidateAndEmit, RECONCILE_MS);  // reconcile once the index catches up
}
