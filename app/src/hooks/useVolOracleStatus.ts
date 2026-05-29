import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "./useProgram";
import { VOL_ORACLE_SEED } from "../utils/constants";

// =============================================================================
// useVolOracleStatus — surface vol-oracle coverage state to the Write flow
// =============================================================================
//
// Background. The vol-oracle crank polls discovered feeds on an hourly
// cadence (see project_phase2_stage_b memory + project_crank_phase1_hardening).
// Between the moment a market is permissionlessly created via create_market
// and the next crank tick, the corresponding VolOracle PDA does not exist,
// and any mint_from_vault call against that market reverts with Anchor 3007
// (AccountOwnedByWrongProgram — the on-chain doc comment in
// mint_from_vault.rs:472-475 documents this exact failure mode).
//
// W2 (crank reactive seeding via onLogs(MarketCreated)) closes that race
// window from hours to seconds. W1 (this hook) is the user-facing defense
// in the meantime: detects the gap before the user signs anything and
// surfaces a clear "Oracle pending" message instead of a confusing 3007
// in their wallet's error stream.
//
// Cache semantics
//   - "seeded" is monotonic: once we observe a VolOracle PDA exists +
//     opta-owned, we cache that result for the rest of the session and
//     never re-query it. Vol oracles are never closed.
//   - "unseeded" is volatile: re-queried on every scan and on every
//     submit-click pre-flight, since the crank may seed at any moment.
//
// Refresh triggers
//   - On mount + on the input feed list changing (assets added/removed).
//   - On document visibilitychange → visible. Matches useVersionCheck's
//     pattern; catches crank-seeded-while-page-hidden cases.
//
// checkOne — submit-click pre-flight
//   Even if the cache says "unseeded," checkOne does a fresh getAccountInfo
//   against the specific feed's PDA before throwing. This catches the
//   common race-just-closed case (the crank seeded the oracle 30 s ago,
//   the cache hasn't refreshed yet). Worst case: one wasted RPC call. Best
//   case: the user's submit succeeds without a confusing "Oracle pending"
//   block when the oracle was just seeded.
// =============================================================================

function deriveVolOraclePda(feedIdHex: string, programId: PublicKey): PublicKey {
  const hex = feedIdHex.replace(/^0x/, "").toLowerCase();
  const bytes = Buffer.from(hex, "hex");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), bytes],
    programId,
  );
  return pda;
}

function normFeed(hex: string): string {
  return hex.replace(/^0x/, "").toLowerCase();
}

export type VolOracleStatus = {
  /** Feed ids (no 0x, lowercase) confirmed to have seeded oracles. Monotonic. */
  seeded: ReadonlySet<string>;
  /** Feed ids confirmed unseeded as of the last scan. May be stale —
   *  always re-check via checkOne before throwing a hard block. */
  unseeded: ReadonlySet<string>;
  /** True while a scan is in flight. */
  loading: boolean;
  /** Trigger a fresh batched re-scan of all currently-known feeds. */
  refresh: () => void;
  /** Submit-click pre-flight. Returns true iff the oracle exists on-chain
   *  at call time. Updates the cache in either direction. */
  checkOne: (feedIdHex: string) => Promise<boolean>;
};

export function useVolOracleStatus(
  feedIdHexes: readonly string[],
): VolOracleStatus {
  const { connection } = useConnection();
  const { program } = useProgram();
  const [seeded, setSeeded] = useState<Set<string>>(new Set());
  const [unseeded, setUnseeded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  // Stable refs so callbacks don't re-create on every state update.
  const seededRef = useRef(seeded);
  seededRef.current = seeded;
  const programIdRef = useRef<PublicKey | null>(program?.programId ?? null);
  programIdRef.current = program?.programId ?? null;

  // Stable identity key over the input list — re-scan when it changes.
  const feedKey = feedIdHexes.map(normFeed).sort().join(",");

  const scan = useCallback(async () => {
    const pid = programIdRef.current;
    if (!pid) return;
    if (feedIdHexes.length === 0) return;
    setLoading(true);
    try {
      const normalized = feedIdHexes.map(normFeed);
      // Skip ones we already know are seeded (monotonic property).
      const toCheck = normalized.filter((f) => !seededRef.current.has(f));
      if (toCheck.length === 0) {
        // Reset unseeded to empty — everything we know about is seeded.
        setUnseeded(new Set());
        return;
      }
      const pdas = toCheck.map((f) => deriveVolOraclePda(f, pid));
      const infos = await connection.getMultipleAccountsInfo(pdas, "confirmed");
      const newSeeded = new Set(seededRef.current);
      const newUnseeded = new Set<string>();
      for (let i = 0; i < toCheck.length; i++) {
        const acct = infos[i];
        const exists = !!acct && acct.owner.equals(pid);
        if (exists) newSeeded.add(toCheck[i]);
        else newUnseeded.add(toCheck[i]);
      }
      setSeeded(newSeeded);
      setUnseeded(newUnseeded);
    } catch (err) {
      console.warn("[useVolOracleStatus] scan failed:", err);
      // Leave existing cache state untouched on transient RPC errors.
    } finally {
      setLoading(false);
    }
    // feedKey is the stable membership-fingerprint; we depend on it not
    // the raw array to avoid re-firing on every render with a new array
    // identity but identical content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, feedKey]);

  useEffect(() => {
    scan();
  }, [scan]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) scan();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [scan]);

  const checkOne = useCallback(
    async (feedIdHex: string): Promise<boolean> => {
      const pid = programIdRef.current;
      if (!pid) return false;
      const normalized = normFeed(feedIdHex);
      if (seededRef.current.has(normalized)) return true;
      const pda = deriveVolOraclePda(normalized, pid);
      try {
        const info = await connection.getAccountInfo(pda, "confirmed");
        const exists = !!info && info.owner.equals(pid);
        if (exists) {
          setSeeded((prev) => {
            const next = new Set(prev);
            next.add(normalized);
            return next;
          });
          setUnseeded((prev) => {
            if (!prev.has(normalized)) return prev;
            const next = new Set(prev);
            next.delete(normalized);
            return next;
          });
        } else {
          setUnseeded((prev) => {
            if (prev.has(normalized)) return prev;
            const next = new Set(prev);
            next.add(normalized);
            return next;
          });
        }
        return exists;
      } catch (err) {
        // Network blip — don't poison the cache. Treat as unknown by
        // returning false to err on the side of refusing the submit;
        // the user can retry.
        console.warn("[useVolOracleStatus] checkOne RPC failed:", err);
        return false;
      }
    },
    [connection],
  );

  return { seeded, unseeded, loading, refresh: scan, checkOne };
}
