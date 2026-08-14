import { FC, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";
import { hexFromBytes, formatExpiry } from "../../utils/format";
import {
  settleAllForExpiry,
  fetchHermesParsedPrice,
} from "../../utils/pythPullPost";
import { getHermesBase, inferClusterFromUrl, getSolscanTxUrl } from "../../utils/env";
import {
  classifySettleTuples,
  actionable,
  unsettleable,
  ORACLE_SWITCHBOARD,
  type SettleTuple,
  type VaultRow,
  type MarketRow,
  type RecordRow,
} from "../../pages/portfolio/settleTuples";

interface AccountRecord {
  publicKey: PublicKey;
  account: any;
}

interface AdminToolsProps {
  vaults: AccountRecord[];
  markets: AccountRecord[];
  /** Eager-fetched per locked decision 14. NOW LOAD-BEARING: SettlementRecord
   *  existence is what decides whether a tuple can be settled at all. */
  settlementRecords: AccountRecord[];
  program: any;
  onRefetch: () => void;
}

type SettleConfirm = {
  asset: string;
  expiry: number;
  price: number | null;
  txSignature: string;
  vaultsFinalized: number;
  /** True when the atomic Pyth tx was skipped because a SettlementRecord
   *  already existed — i.e. price posting was done on a prior attempt
   *  and this click only finalized previously-stuck vaults. */
  isResume: boolean;
};

type Tuple = {
  /** Stable key = `${asset}:${expiry}`. */
  key: string;
  asset: string;
  expiry: number;
  feedIdHex: string;
  /** 0 Pyth / 1 Switchboard. Drives how the receipt sources its price. */
  oracleSource: number;
  /** True when a SettlementRecord already exists — the click is a pure,
   *  oracle-free settle_vault fan-out. */
  hasRecord: boolean;
  /** PDAs of every vault sharing this (asset, expiry). One settle_vault IX
   *  fires per entry in the same click. */
  vaultPdas: PublicKey[];
};

/**
 * Adapt Anchor accounts -> the pure classifier -> PublicKey-bearing tuples.
 *
 * Exported so the collapsed Utilities header badges the SAME count the panel
 * shows. Do NOT re-derive this anywhere else.
 *
 * ⚠️ There is deliberately NO oracle-source filter here. What gates a settle is
 * whether a SettlementRecord exists, not which oracle wrote it — see
 * settleTuples.ts. The Wave-1 BLK-9 filter gated on `oracleSource === 0` and hid
 * all 45 Switchboard tuples (2,175 vaults) that were provably settleable via the
 * oracle-free settle_vault fan-out.
 */
export function settleableTuples(
  vaults: AccountRecord[],
  markets: AccountRecord[],
  settlementRecords: AccountRecord[] = [],
  nowSec: number = Math.floor(Date.now() / 1000),
): { actionable: Tuple[]; dark: Tuple[] } {
  const vaultRows: VaultRow[] = vaults.map((v) => ({
    pda: v.publicKey.toBase58(),
    market: (v.account.market as PublicKey).toBase58(),
    expiry: typeof v.account.expiry === "number" ? v.account.expiry : v.account.expiry.toNumber(),
    isSettled: !!v.account.isSettled,
  }));
  const marketRows: MarketRow[] = markets.map((m) => ({
    pda: m.publicKey.toBase58(),
    assetName: (m.account.assetName as string) ?? "",
    feedIdHex: hexFromBytes(m.account.pythFeedId as number[]),
    oracleSource: Number(m.account.oracleSource ?? 0),
  }));
  const recordRows: RecordRow[] = settlementRecords.map((r) => ({
    assetName: (r.account.assetName as string) ?? "",
    expiry: typeof r.account.expiry === "number" ? r.account.expiry : r.account.expiry.toNumber(),
  }));

  const classified = classifySettleTuples(vaultRows, marketRows, recordRows, nowSec);
  const toTuple = (t: SettleTuple): Tuple => ({
    key: t.key,
    asset: t.asset,
    expiry: t.expiry,
    feedIdHex: t.feedIdHex,
    oracleSource: t.oracleSource,
    hasRecord: t.hasRecord,
    vaultPdas: t.vaultPdas.map((p) => new PublicKey(p)),
  });
  return {
    actionable: actionable(classified).map(toTuple),
    dark: unsettleable(classified).map(toTuple),
  };
}

export const AdminTools: FC<AdminToolsProps> = ({
  vaults,
  markets,
  settlementRecords,
  program,
  onRefetch,
}) => {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const cluster = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint),
    [connection.rpcEndpoint],
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<SettleConfirm | null>(null);

  const { actionable: tuples, dark } = useMemo(
    () => settleableTuples(vaults, markets, settlementRecords),
    [vaults, markets, settlementRecords],
  );

  /** The canonical settled price for a tuple, straight off its SettlementRecord.
   *  This is the price the chain actually applied, so it is the honest number to
   *  show — and it is the ONLY one available for a Switchboard tuple, whose
   *  feedIdHex is an SB feedHash that Hermes 404s on. */
  const recordPrice = (asset: string, expiry: number): number | null => {
    const r = settlementRecords.find((x) => {
      const e = typeof x.account.expiry === "number" ? x.account.expiry : x.account.expiry.toNumber();
      return x.account.assetName === asset && e === expiry;
    });
    if (!r) return null;
    const raw = r.account.settlementPrice;
    const n = typeof raw === "number" ? raw : Number(raw?.toString?.() ?? NaN);
    return Number.isFinite(n) ? n / 1e6 : null;
  };

  useEffect(() => {
    if (!confirmation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmation(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmation]);

  const handleSettle = async (tuple: Tuple) => {
    if (!wallet) {
      showToast({
        type: "error",
        title: "Connect wallet",
        message: "A wallet is required to settle.",
      });
      return;
    }
    setBusyKey(tuple.key);
    try {
      const hermesBase = getHermesBase();
      const result = await settleAllForExpiry(
        program,
        wallet,
        tuple.asset,
        tuple.expiry,
        tuple.feedIdHex,
        tuple.vaultPdas,
        hermesBase,
      );
      // Price for the receipt. Prefer the SettlementRecord — it is the price the
      // chain applied, and for a Switchboard tuple it is the only one obtainable
      // (feedIdHex is an SB feedHash; Hermes 404s and returns null, which is what
      // used to render the receipt price as a bare "—"). Hermes stays the
      // fallback for a Pyth tuple whose record was only just written.
      const settledPrice = recordPrice(tuple.asset, tuple.expiry);
      const priceInfo =
        settledPrice != null
          ? { price: settledPrice, publishTime: 0 }
          : tuple.oracleSource === ORACLE_SWITCHBOARD
            ? null
            : await fetchHermesParsedPrice(tuple.feedIdHex, hermesBase);
      // Prefer the atomic tx sig (the post + settle_expiry) since that's
      // the most informative for explorer linking; fall back to the last
      // vault batch sig on the resume path where atomic was skipped.
      const sig =
        result.atomicSig ??
        result.vaultSigs[result.vaultSigs.length - 1] ??
        "";
      setConfirmation({
        asset: tuple.asset,
        expiry: tuple.expiry,
        price: priceInfo?.price ?? null,
        txSignature: sig,
        vaultsFinalized: result.vaultsFinalized,
        isResume: result.atomicSig === null,
      });
      onRefetch();
    } catch (err: any) {
      showToast({
        type: "error",
        title: "Settle failed",
        message: decodeError(err),
      });
    } finally {
      setBusyKey(null);
    }
  };

  if (tuples.length === 0 && dark.length === 0 && !confirmation) {
    return (
      <div className="border border-rule rounded-md p-8 text-center">
        <p className="m-0 font-sans italic font-medium leading-[1.55] text-ink-body text-[14px]">
          No expired markets need settling.
        </p>
      </div>
    );
  }

  return (
    <>
      {tuples.length === 0 && dark.length > 0 && (
        <div className="border border-rule rounded-md p-8 text-center">
          <p className="m-0 font-sans italic font-medium leading-[1.55] text-ink-body text-[14px]">
            No expired markets need settling.
          </p>
        </div>
      )}

      {tuples.length > 0 && (
      <div className="border border-rule rounded-md divide-y divide-rule-soft">
        {tuples.map((t) => {
          const isBusy = busyKey === t.key;
          const isOtherBusy = busyKey !== null && !isBusy;
          const n = t.vaultPdas.length;
          return (
            <div key={t.key} className="flex items-center gap-4 p-4">
              <div className="flex-1">
                <div className="font-mono text-[13px] text-ink">
                  {t.asset}
                  <span className="ml-3 text-ink-muted">
                    expired {formatExpiry(t.expiry)}
                  </span>
                </div>
                <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] text-ink-muted mt-1">
                  {n} vault{n === 1 ? "" : "s"} affected
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleSettle(t)}
                disabled={isBusy || isOtherBusy || !wallet}
                title={t.hasRecord
                  ? "Settlement price is already on chain — this finalizes the remaining vaults."
                  : "Posts the settlement price, then finalizes the vaults."}
                className="rounded-full border border-ink bg-ink text-paper px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
              >
                {isBusy ? "Settling…" : "Settle"}
              </button>
            </div>
          );
        })}
      </div>
      )}

      {/* Permanently unsettleable. These must NEVER sit in the actionable list:
          they are quest-earnable-looking work that no wallet can complete. A
          Switchboard quote is verifiable only while its signed_slothash is still
          in the SlotHashes sysvar (~3.5 min), so once the 300 s window closes no
          settlement price can ever be posted — by anyone, with any archive. The
          protocol's designed disposition is the reclaim_unsettled 7-day hatch. */}
      {dark.length > 0 && (
        <div className="mt-6" data-testid="settle-dark-band">
          <p className="m-0 mb-3 font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] text-ink-muted">
            Unsettleable · past the oracle window
          </p>
          <div className="border border-rule rounded-md divide-y divide-rule-soft opacity-70">
            {dark.map((t) => (
              <div key={t.key} className="flex items-center gap-4 p-4">
                <div className="flex-1">
                  <div className="font-mono text-[13px] text-ink-muted">
                    {t.asset}
                    <span className="ml-3">expired {formatExpiry(t.expiry)}</span>
                  </div>
                  <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] text-ink-muted mt-1">
                    {t.vaultPdas.length} vault{t.vaultPdas.length === 1 ? "" : "s"} · no settlement price was posted in time
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="m-0 mt-3 font-sans italic text-[12.5px] leading-[1.55] text-ink-body">
            These expiries closed without a settlement price and cannot be settled
            by anyone now. Writers reclaim their collateral pro-rata through the
            7-day grace hatch; there is nothing to do here.
          </p>
        </div>
      )}

      {confirmation && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4"
          onClick={() => setConfirmation(null)}
        >
          <div
            className="w-full max-w-md bg-paper border border-rule rounded-md p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="m-0 font-fraunces-mid font-light text-ink leading-tight tracking-[-0.01em] text-[20px]">
                {confirmation.isResume ? "Resumed" : "Settled"} —{" "}
                {confirmation.vaultsFinalized} vault
                {confirmation.vaultsFinalized === 1 ? "" : "s"} finalized
              </h3>
              <button
                type="button"
                onClick={() => setConfirmation(null)}
                aria-label="Close"
                className="font-mono text-[14px] text-ink-muted hover:text-ink transition-colors duration-200"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 mb-5">
              <Row label="Asset">{confirmation.asset}</Row>
              <Row label="Expiry">{formatExpiry(confirmation.expiry)}</Row>
              <Row label="Settlement price">
                {confirmation.price != null
                  ? `$${confirmation.price.toLocaleString()}`
                  : "—"}
              </Row>
              <Row label="Tx">
                {confirmation.txSignature ? (
                  <a
                    href={getSolscanTxUrl(confirmation.txSignature, cluster)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink-body hover:text-crimson transition-colors duration-200"
                  >
                    {confirmation.txSignature.slice(0, 8)}…
                    {confirmation.txSignature.slice(-6)} ↗
                  </a>
                ) : (
                  "—"
                )}
              </Row>
            </div>
            <button
              type="button"
              onClick={() => setConfirmation(null)}
              className="w-full rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
};

const Row: FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex items-baseline justify-between">
    <span className="font-mono font-medium text-[10.5px] uppercase tracking-[0.2em] text-ink-muted">
      {label}
    </span>
    <span className="font-mono text-[13px] text-ink">{children}</span>
  </div>
);

export default AdminTools;
