// =============================================================================
// utils/indexerRegistry.ts — how the FE hands its indexer reader to safeFetchAll
// =============================================================================
//
// WHY A REGISTRY AND NOT A PLAIN IMPORT
//
//   safeFetchAll lives in hooks/useFetchAccounts.ts, which several CRANK scripts
//   import directly through the @app/* alias under CommonJS/ts-node. The
//   indexer reader needs `import.meta.env` to read its feature flag, and
//   `import.meta` is an ESM-ONLY SYNTAX MARKER: its mere presence anywhere in
//   the import graph makes Node treat the file as an ES module and crash the
//   crank with "exports is not defined in ES module scope".
//
//   That is not hypothetical. It took the crank down on 2026-07-21, and
//   utils/constants.ts still carries the warning. A static import from
//   safeFetchAll to the read-path module would have reproduced it exactly.
//
//   So this module — which is pure, ESM-marker-free and safe for the crank —
//   holds a slot. The FE fills it at startup; the crank never does, and
//   therefore reads chain directly. That is the correct behaviour for the crank
//   anyway: a keeper deciding whether to fire must never act on an index.
// =============================================================================

import type { PublicKey } from "@solana/web3.js";

export interface IndexerRows<T> {
  rows: { publicKey: PublicKey; account: T }[];
  slot: number;
  ageSec: number;
}

/** Returns null whenever the indexer cannot serve this read, for ANY reason. */
export type IndexerReader = (
  accountName: string,
  params?: { market?: string },
) => Promise<IndexerRows<unknown> | null>;

let reader: IndexerReader | null = null;

/** Called once from the FE entry point. The crank never calls it. */
export function registerIndexerReader(fn: IndexerReader): void {
  reader = fn;
}

export function getIndexerReader(): IndexerReader | null {
  return reader;
}

/** Test seam. */
export function clearIndexerReader(): void {
  reader = null;
}
