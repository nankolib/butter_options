import type { Connection, GetProgramAccountsResponse } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { Buffer } from "buffer";

/**
 * coalescedProgramAccounts — one getProgramAccounts per (program, discriminator)
 * in flight at a time, with a hard timeout.
 *
 * Why: the Trade page mounts ~4 hooks that each scan the whole program by
 * discriminator (useVaults, useTradeData, useUnifiedChain, useBook), and
 * sharedVault / vaultMint / optionsMarket / restingOrder are each scanned TWICE
 * concurrently. On the preview (VITE_RPC_URL unset → public devnet) that burst
 * rate-limits: partial loads (assets drop) and stalls ("Loading…" forever).
 *
 * This merges truly-simultaneous identical scans into one request — IN-FLIGHT
 * ONLY, no TTL cache — so a refetch triggered AFTER a trade is never served a
 * stale snapshot (it starts a fresh scan once the burst has settled). The
 * timeout guarantees `loading` always resolves instead of hanging.
 */
const inflight = new Map<string, Promise<GetProgramAccountsResponse>>();
const DEFAULT_TIMEOUT_MS = 25_000;

export async function coalescedProgramAccounts(
  connection: Connection,
  programId: PublicKey,
  disc: readonly number[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GetProgramAccountsResponse> {
  const bytes = utils.bytes.bs58.encode(Buffer.from(disc));
  const key = `${programId.toBase58()}:${bytes}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    const gpa = connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes } }],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`getProgramAccounts timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([gpa, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  inflight.set(key, p);
  // Clear the in-flight entry once it settles (success OR failure) so the next
  // call starts a fresh scan. Swallow here — callers handle their own errors.
  p.then(
    () => { if (inflight.get(key) === p) inflight.delete(key); },
    () => { if (inflight.get(key) === p) inflight.delete(key); },
  );
  return p;
}
