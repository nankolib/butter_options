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

/**
 * BLK-4 (audit 2026-08-04). A single 25s attempt with no retry meant roughly one
 * in five /markets loads rendered a COMPLETELY empty page — all five strip
 * metrics "—", "Showing 0 assets", every tile "No live contracts" — because both
 * the vault scan and the market scan timed out together. That is the first thing
 * a visitor sees.
 *
 * The scan is genuinely heavy (3,365 SharedVault + 464 OptionsMarket + 482
 * RestingOrder accounts, unfiltered) and rpc.opta.fyi/devnet is occasionally slow
 * rather than down, so the answer is a longer ceiling plus retries, not a shorter
 * one. Attempt budgets escalate: a slow-but-alive RPC gets more room each time.
 *
 * dataSlice-ing the vault scan to the fields the page reads is the real
 * reduction and is deliberately NOT done here (next phase).
 */
const ATTEMPT_TIMEOUTS_MS = [20_000, 30_000, 45_000] as const;
/** Backoff BEFORE attempts 2 and 3. Short — the user is staring at a spinner. */
const RETRY_BACKOFF_MS = [400, 1_200] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function coalescedProgramAccounts(
  connection: Connection,
  programId: PublicKey,
  disc: readonly number[],
  timeoutMs?: number,
): Promise<GetProgramAccountsResponse> {
  const bytes = utils.bytes.bs58.encode(Buffer.from(disc));
  const key = `${programId.toBase58()}:${bytes}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  // An explicit timeoutMs from a caller is a single-attempt budget and is
  // honoured verbatim — callers that pass one have their own retry/refresh
  // cadence and must not have this one layered underneath.
  const budgets = timeoutMs != null ? [timeoutMs] : ATTEMPT_TIMEOUTS_MS;

  const p = (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < budgets.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1_200);
      const budget = budgets[attempt];
      // A fresh request per attempt: the previous one is abandoned, not awaited.
      const gpa = connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes } }],
      });
      // The abandoned request still rejects eventually; swallow it so a losing
      // attempt cannot surface as an unhandled rejection.
      gpa.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`getProgramAccounts timeout after ${budget}ms`)),
          budget,
        );
      });
      try {
        return await Promise.race([gpa, timeout]);
      } catch (err) {
        lastErr = err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("getProgramAccounts failed after retries");
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

/**
 * Drop any in-flight coalesced scan for (program, discriminator). Called after a
 * confirmed on-chain mutation so the NEXT fetch starts a FRESH scan instead of
 * joining a snapshot taken before the mutation (the stale-UI-after-cancel bug).
 */
export function invalidateProgramAccounts(programId: PublicKey, disc: readonly number[]): void {
  const key = `${programId.toBase58()}:${utils.bytes.bs58.encode(Buffer.from(disc))}`;
  inflight.delete(key);
}
