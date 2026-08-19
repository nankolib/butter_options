import { useEffect, useState, useCallback, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "./useProgram";
import { safeFetchAll } from "./useFetchAccounts";
import { USE_V2_VAULTS, isPostPhase2Vault } from "../utils/constants";

// Precision multiplier matching Rust's 1e12 for premium_per_share_cumulative
const PRECISION = new BN("1000000000000");

/**
 * Detect if a vault is an Epoch vault. Handles all possible Anchor enum serialization formats:
 *   - object with lowercase key: { epoch: {} }
 *   - object with PascalCase key: { Epoch: {} }
 *   - numeric discriminator: 0 (Epoch is first variant)
 *   - string: "epoch" / "Epoch"
 * Exported so other modules can use the same check.
 */
export function isEpochVault(vault: any): boolean {
  const vt = vault?.account?.vaultType ?? vault?.vaultType;
  if (!vt) return false;
  if (typeof vt === "object") {
    return "epoch" in vt || "Epoch" in vt;
  }
  if (typeof vt === "number") return vt === 0;
  if (typeof vt === "string") return vt.toLowerCase() === "epoch";
  return false;
}

export function isCustomVault(vault: any): boolean {
  const vt = vault?.account?.vaultType ?? vault?.vaultType;
  if (!vt) return false;
  return !isEpochVault(vault);
}

interface VaultAccount {
  publicKey: PublicKey;
  account: any;
}

/**
 * Hook providing convenient access to v2 shared vault data.
 *
 * Fetches SharedVault, WriterPosition, VaultMint, and EpochConfig accounts
 * and provides helpers for common lookups and calculations.
 */
/**
 * @param market Optional market pubkey. When given, the vault and series reads
 *   are narrowed to that board — 52KB instead of 3.74MB on the measured worst
 *   case. RENDERING CONTEXT ONLY: it is the board on screen, never anything
 *   feeding transaction assembly.
 *
 *   Portfolio and Markets pass nothing, because a wallet's positions and the
 *   market list legitimately span every board. Only /trade narrows, because
 *   /trade only ever draws one.
 *
 *   Advisory, not a guarantee: the chain fallback cannot filter, so callers must
 *   still tolerate receiving every board. Every consumer here already filters by
 *   asset downstream, so a superset is harmless — a SUBSET would not be.
 *
 *   THREE STATES, deliberately:
 *     undefined -> fetch every board (Portfolio, Markets)
 *     "<pubkey>" -> fetch that board only (/trade)
 *     null       -> the caller WILL narrow but does not know the market yet;
 *                   fetch nothing and wait.
 *
 *   Without the third state /trade would pull all 3.74MB on first render and
 *   then fetch the board again once the asset resolved — paying the full cost
 *   to avoid paying it.
 */
export function useVaults(
  market?: string | null,
  opts?: {
    /**
     * Wait for the browser to go idle before the FIRST fetch.
     *
     * For consumers that are BELOW THE FOLD. The trade dock legitimately needs
     * every board (a wallet's positions are not confined to the board on
     * screen), which is a 5MB read — and it was firing during first paint,
     * competing for bandwidth with the 92KB the chain actually needs to draw a
     * row. Same work, off the critical path.
     *
     * Not a cancellation: the data still loads, just after the thing the user is
     * looking at.
     */
    deferUntilIdle?: boolean;
  },
) {
  const { program } = useProgram();
  const { publicKey } = useWallet();

  const [vaults, setVaults] = useState<VaultAccount[]>([]);
  const [writerPositions, setWriterPositions] = useState<VaultAccount[]>([]);
  const [vaultMints, setVaultMints] = useState<VaultAccount[]>([]);
  const [epochConfig, setEpochConfig] = useState<VaultAccount | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!program || !USE_V2_VAULTS) {
      setIsLoading(false);
      return;
    }
    // null = "narrowing, market not resolved yet". Stay loading: the board is
    // coming, and reporting "loaded, zero vaults" here would render the empty
    // state over data that is about to arrive.
    if (market === null) return;
    setIsLoading(true);
    try {
      const scope = market ? { market } : undefined;
      const [sv, wp, vm, ec] = await Promise.all([
        safeFetchAll(program, "sharedVault", scope),
        // writerPosition is NEVER indexed (position-shaped) and epochConfig is a
        // single row, so neither takes a scope.
        safeFetchAll(program, "writerPosition"),
        safeFetchAll(program, "vaultMint", scope),
        safeFetchAll(program, "epochConfig"),
      ]);
      // Phase 2 cutoff — hide pre-Phase-2 vaults and cascade to their related records.
      const filteredSv = sv.filter(isPostPhase2Vault);
      const validVaultKeys = new Set(filteredSv.map((v) => v.publicKey.toBase58()));
      const filteredWp = wp.filter((p: any) => validVaultKeys.has((p.account.vault as PublicKey).toBase58()));
      const filteredVm = vm.filter((m: any) => validVaultKeys.has((m.account.vault as PublicKey).toBase58()));
      setVaults(filteredSv);
      setWriterPositions(filteredWp);
      setVaultMints(filteredVm);
      setEpochConfig(ec.length > 0 ? ec[0] : null);
    } catch (err) {
      console.error("Failed to fetch vault accounts:", err);
    } finally {
      setIsLoading(false);
    }
    // `market` IS a dependency: switching boards must refetch the incoming one,
    // which is the entire point of narrowing the read.
  }, [program, market]);

  useEffect(() => {
    if (opts?.deferUntilIdle) {
      let cancelled = false;
      const run = () => { if (!cancelled) void refetch(); };
      const w = window as any;
      // The timeout is a ceiling, not a hope: on a page that never goes idle the
      // data must still arrive.
      const id = typeof w.requestIdleCallback === "function"
        ? w.requestIdleCallback(run, { timeout: 4000 })
        : window.setTimeout(run, 1200);
      return () => {
        cancelled = true;
        if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(id);
        else window.clearTimeout(id);
      };
    }
    refetch();
  }, [refetch, opts?.deferUntilIdle]);

  // Current wallet's writer positions
  const myPositions = useMemo(() => {
    if (!publicKey) return [];
    return writerPositions.filter(
      (wp) => (wp.account.owner as PublicKey).equals(publicKey),
    );
  }, [writerPositions, publicKey]);

  // Helper: get all vaults for a specific market
  const getVaultsForMarket = useCallback(
    (marketKey: PublicKey) =>
      vaults.filter((v) => (v.account.market as PublicKey).equals(marketKey)),
    [vaults],
  );

  // Helper: get current wallet's position in a specific vault
  const getMyPosition = useCallback(
    (vaultKey: PublicKey) =>
      myPositions.find((wp) =>
        (wp.account.vault as PublicKey).equals(vaultKey),
      ) ?? null,
    [myPositions],
  );

  // Helper: get all mints for a specific vault
  const getMintsForVault = useCallback(
    (vaultKey: PublicKey) =>
      vaultMints.filter((vm) =>
        (vm.account.vault as PublicKey).equals(vaultKey),
      ),
    [vaultMints],
  );

  // Helper: is this vault an epoch vault? Wraps the robust exported helper.
  const isEpochVaultHelper = useCallback(
    (vault: any) => isEpochVault(vault.account ? vault : { account: vault }),
    [],
  );

  // Helper: calculate unclaimed premium for a writer position.
  // Matches Rust claim_premium.rs exactly:
  //   total_earned = (shares * cumulative) / 1e12
  //   earned_since_deposit = total_earned - debt  (clamped to 0)
  //   claimable = earned_since_deposit - claimed  (clamped to 0)
  const getUnclaimedPremium = useCallback(
    (vault: any, position: any): BN => {
      const cumulative = new BN(vault.premiumPerShareCumulative.toString());
      const shares = new BN(position.shares.toString());
      const debt = new BN(position.premiumDebt.toString());
      const claimed = new BN(position.premiumClaimed.toString());
      const totalEarned = shares.mul(cumulative).div(PRECISION);
      const earnedSinceDeposit = BN.max(totalEarned.sub(debt), new BN(0));
      return BN.max(earnedSinceDeposit.sub(claimed), new BN(0));
    },
    [],
  );

  return {
    vaults,
    myPositions,
    vaultMints,
    epochConfig,
    isLoading,
    refetch,
    getVaultsForMarket,
    getMyPosition,
    getMintsForVault,
    isEpochVault: isEpochVaultHelper,
    getUnclaimedPremium,
  };
}
