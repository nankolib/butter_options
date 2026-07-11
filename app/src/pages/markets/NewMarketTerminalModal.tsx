// =============================================================================
// NewMarketTerminalModal — terminal New-market cockpit (locked design 1a).
// =============================================================================
//
// A single 520px scroll column with lifecycle states (form → confirm → success).
// Class-first, then a SMART asset input (crypto): text → catalog search; a pasted
// token mint → resolve its symbol (T22 ext → Metaplex PDA) and match a canonical
// catalog asset (anti-spoof — the feed always comes from the matched catalog row,
// never the pasted mint). Live inline availability on the on-chain identifier.
//
// Both submit arms are the SAME create path as the legacy modal (shared leaf
// helpers in newMarketCreate.ts + buildPostUpdateAndCreateMarketTx) — presentation
// only. No user-facing string names an oracle/data provider.
// =============================================================================

import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useProgram } from "../../hooks/useProgram";
import { hexFromBytes } from "../../utils/format";
import { getCatalog, lookupByFeedId, type CatalogEntry } from "../../utils/hermesCatalog";
import { SB_FEED_DATA, lookupSbFeedDatum } from "../../utils/sbFeedData";
import { buildAssetRegistry, sbBaseTicker, type AssetRegistryEntry } from "../../utils/assetRegistry";
import { getHermesBase, getSbCreateEndpoint } from "../../utils/env";
import { getLiveness, resolveSource, type LivenessMap } from "../../utils/liveness";
import { MARKET_SEED } from "../../utils/constants";
import { buildPostUpdateAndCreateMarketTx, submitWithFallback } from "../../utils/pythPullPost";
import {
  submitSbCreateMarket,
  mapSbError,
  SbUserRejectedError,
} from "./newMarketCreate";
import { invalidateAccountScans } from "../../hooks/useFetchAccounts";
import { resolveMintSymbol, parseMintAddress } from "../../utils/resolveMintSymbol";
import { SolscanLink } from "../../components/SolscanLink";

type Props = {
  onClose: () => void;
  onCreated: () => void;
};

const CLASS_LABEL: Record<number, string> = {
  0: "Crypto",
  1: "Commodity",
  2: "Equity",
  3: "FX",
  4: "ETF",
};
const CLASS_ORDER = [0, 1, 2, 3, 4] as const;

// Fixed rent+fee estimate for one registry-only market account (8 + INIT_SPACE
// rent + a couple of signatures). Shown once a create is derivable, else "—".
const CREATE_COST = "~0.003 SOL";

const BASE58_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const normTicker = (t: string) => t.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

type FeedChoice = {
  ticker: string;
  label: string;
  assetClass: number;
  pythFeedId: string | null;
  sbFeedHash: string | null;
  canonicalSource: 0 | 1;
};

const toChoice = (e: AssetRegistryEntry): FeedChoice => ({
  ticker: e.ticker,
  label: e.commonName,
  assetClass: e.assetClass,
  pythFeedId: e.pythFeedId,
  sbFeedHash: e.sbFeedHash,
  canonicalSource: e.canonicalSource,
});

type CatalogState =
  | { kind: "loading" }
  | { kind: "fresh"; entries: CatalogEntry[] }
  | { kind: "stale"; entries: CatalogEntry[]; lastRefresh: number }
  | { kind: "failed"; error: string };

const entriesOf = (s: CatalogState): CatalogEntry[] | null =>
  s.kind === "fresh" || s.kind === "stale" ? s.entries : null;

// Smart asset input (crypto paste path) resolution state.
type Resolve =
  | { kind: "idle" }
  | { kind: "resolving" }
  | { kind: "resolved"; choice: FeedChoice; symbol: string; mint: string }
  | { kind: "no-feed"; symbol: string }
  | { kind: "not-found" }
  | { kind: "no-metadata" }
  | { kind: "transport-error" }
  | { kind: "invalid" };

// Inline availability of the on-chain identifier.
type Avail =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "live-same" }
  | { kind: "taken-diff" };

// Create lifecycle.
type Phase =
  | { kind: "form" }
  | { kind: "submitting"; label: string }
  | { kind: "success"; sig: string; assetName: string }
  | { kind: "failed"; message: string; sig?: string };

export const NewMarketTerminalModal: FC<Props> = ({ onClose, onCreated }) => {
  const { program, provider } = useProgram();
  const { publicKey, connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  const [catalog, setCatalog] = useState<CatalogState>({ kind: "loading" });
  const [liveness, setLiveness] = useState<LivenessMap | null>(null);
  const [selectedClass, setSelectedClass] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<FeedChoice | null>(null);
  const [assetName, setAssetName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pastedHex, setPastedHex] = useState("");
  const [pastedClass, setPastedClass] = useState(0);
  const [resolve, setResolve] = useState<Resolve>({ kind: "idle" });
  const [avail, setAvail] = useState<Avail>({ kind: "idle" });
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const userEditedRef = useRef(false);
  const resolveSeq = useRef(0);

  const sbEndpoint = getSbCreateEndpoint();
  // Known at class-select: a non-crypto class with no create endpoint configured
  // cannot be routed — say so upfront, never a dead-end after form-fill.
  const classNotEnabled = selectedClass !== null && selectedClass !== 0 && !sbEndpoint;

  const cryptoCatalogDead = selectedClass === 0 && catalog.kind === "failed";
  const advancedActive = advancedOpen || cryptoCatalogDead;
  const isCrypto = selectedClass === 0;
  const looksLikeAddress = isCrypto && !advancedActive && BASE58_ADDR.test(query.trim());

  // ---- catalog + liveness on mount ----
  useEffect(() => {
    let cancelled = false;
    getCatalog({ hermesBase: getHermesBase() })
      .then((res) => {
        if (cancelled) return;
        setCatalog(
          res.isStale
            ? { kind: "stale", entries: res.entries, lastRefresh: res.lastRefresh }
            : { kind: "fresh", entries: res.entries },
        );
      })
      .catch((err) => {
        if (!cancelled) setCatalog({ kind: "failed", error: err?.message ?? "unknown" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getLiveness()
      .then((m) => !cancelled && setLiveness(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc to dismiss (unless mid-submit).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase.kind !== "submitting") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase.kind]);

  const registry = useMemo<AssetRegistryEntry[]>(
    () => buildAssetRegistry(entriesOf(catalog) ?? [], SB_FEED_DATA),
    [catalog],
  );

  const results = useMemo<FeedChoice[]>(() => {
    if (selectedClass === null || looksLikeAddress) return [];
    const q = query.trim().toLowerCase();
    return registry
      .filter((r) => r.assetClass === selectedClass)
      .filter((r) => !q || r.ticker.toLowerCase().includes(q) || r.commonName.toLowerCase().includes(q))
      .slice(0, 12)
      .map(toChoice);
  }, [registry, selectedClass, query, looksLikeAddress]);

  // ---- smart paste resolution (crypto only) ----
  useEffect(() => {
    if (!looksLikeAddress) {
      setResolve({ kind: "idle" });
      return;
    }
    const raw = query.trim();
    const seq = ++resolveSeq.current;
    setResolve({ kind: "resolving" });
    const t = window.setTimeout(async () => {
      const mint = parseMintAddress(raw);
      if (!mint) {
        if (resolveSeq.current === seq) setResolve({ kind: "invalid" });
        return;
      }
      const res = await resolveMintSymbol(connection, mint);
      if (resolveSeq.current !== seq) return;
      if (res.kind === "not-found") {
        setResolve({ kind: "not-found" });
        return;
      }
      if (res.kind === "transport-error") {
        setResolve({ kind: "transport-error" });
        return;
      }
      if (res.kind === "no-metadata") {
        setResolve({ kind: "no-metadata" });
        return;
      }
      // Anti-spoof: use the resolved symbol ONLY to look up a canonical crypto
      // catalog asset; the feed is taken from that matched row, never the mint.
      const sym = normTicker(res.symbol);
      const match = registry.find((r) => r.assetClass === 0 && normTicker(r.ticker) === sym);
      if (match) {
        setResolve({
          kind: "resolved",
          choice: toChoice(match),
          symbol: res.symbol,
          mint: mint.toBase58(),
        });
      } else {
        setResolve({ kind: "no-feed", symbol: res.symbol });
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [looksLikeAddress, query, connection, registry]);

  // When a paste resolves to a catalog asset, adopt it as the selection.
  useEffect(() => {
    if (resolve.kind === "resolved") {
      setSelected(resolve.choice);
      if (!userEditedRef.current) setAssetName(resolve.choice.ticker);
    }
  }, [resolve]);

  // ---- active (feedIdHex, class, oracleSource) triple ----
  const activeFeed = useMemo<
    { feedIdHex: string; assetClass: number; oracleSource: number; stale: boolean } | null
  >(() => {
    if (selectedClass === null) return null;
    if (advancedActive) {
      const hex = pastedHex.trim().toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(hex)) return null;
      return { feedIdHex: hex, assetClass: pastedClass, oracleSource: pastedClass === 0 ? 0 : 1, stale: false };
    }
    if (!selected) return null;
    const r = resolveSource(selected, liveness);
    if (!r) return null;
    return { feedIdHex: r.feedIdHex, assetClass: selected.assetClass, oracleSource: r.oracleSource, stale: r.stale };
  }, [selectedClass, advancedActive, pastedHex, pastedClass, selected, liveness]);

  // Sync name from selection until the user edits it.
  useEffect(() => {
    if (userEditedRef.current) return;
    if (advancedActive) {
      const hex = pastedHex.trim().toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(hex)) return;
      const entries = entriesOf(catalog);
      const known = entries ? lookupByFeedId(entries, hex) : null;
      if (known) {
        setAssetName(known.suggestedTicker);
        return;
      }
      const sb = lookupSbFeedDatum(hex);
      if (sb) setAssetName(sbBaseTicker(sb.symbol));
      return;
    }
    if (selected) setAssetName(selected.ticker);
  }, [advancedActive, pastedHex, selected, catalog]);

  const assetNameValid = /^[A-Z0-9]{1,16}$/.test(assetName);

  // ---- live inline availability (debounced getAccountInfo on the market PDA) ----
  useEffect(() => {
    if (!program || !assetNameValid || !activeFeed) {
      setAvail({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setAvail({ kind: "checking" });
    const t = window.setTimeout(async () => {
      try {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
          program.programId,
        );
        const info = await program.provider.connection.getAccountInfo(pda);
        if (cancelled) return;
        if (!info) {
          setAvail({ kind: "available" });
          return;
        }
        const decoded = program.coder.accounts.decode<{ pythFeedId: number[] }>(
          "optionsMarket",
          info.data,
        );
        const existingHex = hexFromBytes(decoded.pythFeedId);
        setAvail(existingHex === activeFeed.feedIdHex ? { kind: "live-same" } : { kind: "taken-diff" });
      } catch {
        if (!cancelled) setAvail({ kind: "idle" });
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [program, assetName, assetNameValid, activeFeed]);

  const selectClass = (cls: number) => {
    if (cls === selectedClass) return;
    setSelectedClass(cls);
    setSelected(null);
    setQuery("");
    setAssetName("");
    setResolve({ kind: "idle" });
    setAvail({ kind: "idle" });
    userEditedRef.current = false;
    setPastedClass(cls);
    setAdvancedOpen(false);
  };

  const canSubmit =
    phase.kind === "form" &&
    !classNotEnabled &&
    !!program &&
    !!provider &&
    !!publicKey &&
    !!anchorWallet &&
    !!activeFeed &&
    assetNameValid &&
    avail.kind !== "taken-diff" &&
    avail.kind !== "live-same";

  const doCreate = async () => {
    if (!canSubmit || !program || !publicKey || !anchorWallet || !activeFeed) return;
    setPhase({ kind: "submitting", label: "Confirm in your wallet…" });
    try {
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
        program.programId,
      );
      // Pre-submit collision guard (final guard — the inline check is advisory).
      const existing = await program.provider.connection.getAccountInfo(marketPda);
      if (existing) {
        const decoded = program.coder.accounts.decode<{ pythFeedId: number[] }>(
          "optionsMarket",
          existing.data,
        );
        const existingHex = hexFromBytes(decoded.pythFeedId);
        if (existingHex === activeFeed.feedIdHex) {
          invalidateAccountScans(program, ["optionsMarket"]);
          onCreated();
          setPhase({ kind: "success", sig: "", assetName });
          return;
        }
        setPhase({ kind: "failed", message: `Name taken by a different asset.` });
        return;
      }

      let sig: string;
      if (activeFeed.oracleSource !== 0) {
        // --- Switchboard arm (shared leaf helper; endpoint validated) ---
        if (!sbEndpoint) {
          setPhase({ kind: "failed", message: "Creation for this class isn't enabled yet." });
          return;
        }
        sig = await submitSbCreateMarket({
          endpoint: sbEndpoint,
          connection: program.provider.connection,
          wallet: anchorWallet,
          assetName,
          feedHashHex: activeFeed.feedIdHex,
          assetClass: activeFeed.assetClass,
          userPublicKey: publicKey.toBase58(),
          onRefetch: () =>
            setPhase({ kind: "submitting", label: "Fetching a fresh quote — approve promptly…" }),
        });
      } else {
        // --- Pyth arm (byte-identical to legacy; oracle_source forwarded) ---
        const txs = await buildPostUpdateAndCreateMarketTx(
          program,
          anchorWallet,
          assetName,
          activeFeed.feedIdHex,
          activeFeed.assetClass,
          getHermesBase(),
          activeFeed.oracleSource,
        );
        sig = await submitWithFallback(program.provider.connection, anchorWallet, txs);
      }

      // Create-success refetch — drop the coalesced optionsMarket scan so the
      // parent's refetch reads chain-fresh (no manual reload).
      invalidateAccountScans(program, ["optionsMarket"]);
      onCreated();
      setPhase({ kind: "success", sig, assetName });
    } catch (e) {
      if (e instanceof SbUserRejectedError) {
        setPhase({ kind: "failed", message: "Rejected in wallet." });
      } else {
        const { message } = mapSbError(e);
        setPhase({ kind: "failed", message });
      }
    }
  };

  const submitting = phase.kind === "submitting";

  // ---- render ----
  return (
    <div
      className="fixed inset-0 z-[300] flex items-end justify-center bg-l-overlay px-0 sm:items-center sm:px-4"
      onClick={() => phase.kind !== "submitting" && onClose()}
      data-testid="new-market-modal"
    >
      <div
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[16px] border border-l-hair bg-l-bg text-l-text shadow-2xl sm:w-[520px] sm:rounded-[14px]"
        onClick={(e) => e.stopPropagation()}
        data-testid="new-market-terminal"
      >
        {/* Header */}
        <div className="flex flex-none items-center justify-between border-b border-l-hair px-6 py-[14px]">
          <span className="font-mono-plex text-[10px] uppercase tracking-[0.2em] text-l-muted">
            {phase.kind === "success" ? "● Market created" : "New market"}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
            className="font-mono-plex text-[13px] text-l-faint transition-colors hover:text-l-text disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {phase.kind === "success" ? (
            <SuccessMoment sig={phase.sig} assetName={phase.assetName} onClose={onClose} />
          ) : (
            <div className="space-y-6">
              {/* Asset class */}
              <Section label="Asset class">
                <div className="flex flex-wrap gap-2">
                  {CLASS_ORDER.map((cls) => (
                    <button
                      key={cls}
                      type="button"
                      data-testid="class-chip"
                      data-class={cls}
                      onClick={() => selectClass(cls)}
                      aria-pressed={selectedClass === cls}
                      disabled={submitting}
                      className={`rounded-[6px] border px-[13px] py-[6px] font-mono-plex text-[11px] uppercase tracking-[0.12em] transition-colors ${
                        selectedClass === cls
                          ? "border-l-text bg-l-surface text-l-text"
                          : "border-l-hair text-l-muted hover:text-l-text"
                      } disabled:opacity-50`}
                    >
                      {CLASS_LABEL[cls]}
                    </button>
                  ))}
                </div>
              </Section>

              {selectedClass === null && (
                <p className="font-mono-plex text-[12px] text-l-muted">Pick an asset class to begin.</p>
              )}

              {/* Class-route-not-enabled — known at class-select, no dead-end. */}
              {classNotEnabled && (
                <p
                  data-testid="class-not-enabled"
                  className="font-mono-plex text-[12px] leading-[1.6] text-l-muted"
                >
                  Creation for this class isn't enabled yet.
                </p>
              )}

              {/* Catalog banners (generic — no provider names) */}
              {selectedClass !== null && catalog.kind === "stale" && (
                <p className="font-mono-plex text-[10.5px] uppercase tracking-[0.12em] text-l-muted">
                  Catalog unreachable — showing cached assets from{" "}
                  {new Date(catalog.lastRefresh).toLocaleString()}
                </p>
              )}
              {selectedClass !== null && catalog.kind === "failed" && (
                <p className="font-mono-plex text-[10.5px] uppercase tracking-[0.12em] text-l-down">
                  Catalog unreachable and no cached copy. Use Advanced → paste a feed identifier.
                </p>
              )}

              {/* Asset search / smart input */}
              {selectedClass !== null && !advancedActive && !classNotEnabled && (
                <Section label="Asset">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      if (!looksLikeAddress) {
                        setSelected(null);
                        userEditedRef.current = false;
                      }
                    }}
                    disabled={submitting || (isCrypto && catalog.kind === "loading")}
                    placeholder={
                      catalog.kind === "loading"
                        ? "Loading asset catalog…"
                        : isCrypto
                          ? "Search, or paste a token address"
                          : "Search by name or ticker (e.g. XAU, AAPL)"
                    }
                    data-testid="asset-input"
                    className="w-full rounded-[6px] border border-l-hair bg-l-surface px-3 py-2 font-mono-plex text-[14px] text-l-text outline-none transition-colors focus:border-l-text placeholder:text-l-faint disabled:opacity-50"
                  />

                  {/* Smart paste resolution states (crypto) */}
                  {looksLikeAddress && <ResolveRow resolve={resolve} />}

                  {/* Text search results */}
                  {!looksLikeAddress && results.length > 0 && (
                    <ul className="mt-2 max-h-[220px] overflow-y-auto rounded-[6px] border border-l-hair">
                      {results.map((c) => {
                        const on = selected?.ticker === c.ticker;
                        return (
                          <li key={c.ticker}>
                            <button
                              type="button"
                              data-testid="asset-result"
                              onClick={() => {
                                setSelected(c);
                                userEditedRef.current = false;
                              }}
                              aria-pressed={on}
                              className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left font-mono-plex text-[12px] transition-colors ${
                                on ? "bg-l-surface text-l-text" : "text-l-muted hover:bg-l-surface hover:text-l-text"
                              }`}
                            >
                              <span className="font-medium text-l-text">{c.ticker}</span>
                              <span className="truncate text-l-muted">{c.label}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {!looksLikeAddress && selectedClass !== null && query.trim() && results.length === 0 && catalog.kind !== "loading" && (
                    <p className="mt-2 font-mono-plex text-[10.5px] uppercase tracking-[0.12em] text-l-muted">
                      No assets match "{query.trim()}".
                    </p>
                  )}
                </Section>
              )}

              {/* Advanced — feed identifier (any class) */}
              {selectedClass !== null && !classNotEnabled && (
                <div>
                  {!cryptoCatalogDead && (
                    <button
                      type="button"
                      data-testid="advanced-toggle"
                      onClick={() => setAdvancedOpen((v) => !v)}
                      disabled={submitting}
                      className="font-mono-plex text-[10.5px] uppercase tracking-[0.14em] text-l-muted transition-colors hover:text-l-text disabled:opacity-50"
                    >
                      {advancedActive ? "← Back to search" : "Advanced"}
                    </button>
                  )}
                  {advancedActive && (
                    <div className="mt-3 space-y-3">
                      <div
                        data-testid="feed-identifier-label"
                        className="font-mono-plex text-[10px] uppercase tracking-[0.16em] text-l-muted"
                      >
                        Feed identifier
                      </div>
                      <input
                        type="text"
                        value={pastedHex}
                        onChange={(e) => setPastedHex(e.target.value)}
                        placeholder="64-char hex (no 0x)"
                        spellCheck={false}
                        disabled={submitting}
                        data-testid="feed-identifier-input"
                        className="w-full rounded-[6px] border border-l-hair bg-l-surface px-3 py-2 font-mono-plex text-[14px] text-l-text outline-none focus:border-l-text placeholder:text-l-faint disabled:opacity-50"
                      />
                      <div className="flex flex-wrap gap-2">
                        {CLASS_ORDER.map((cls) => (
                          <button
                            key={cls}
                            type="button"
                            onClick={() => setPastedClass(cls)}
                            aria-pressed={pastedClass === cls}
                            disabled={submitting}
                            className={`rounded-[6px] border px-[11px] py-[4px] font-mono-plex text-[10px] uppercase tracking-[0.12em] transition-colors ${
                              pastedClass === cls
                                ? "border-l-text text-l-text"
                                : "border-l-hair text-l-muted hover:text-l-text"
                            } disabled:opacity-50`}
                          >
                            {CLASS_LABEL[cls]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* On-chain identifier + live availability */}
              {activeFeed && !classNotEnabled && (
                <Section label="On-chain identifier">
                  <input
                    type="text"
                    value={assetName}
                    onChange={(e) => {
                      userEditedRef.current = true;
                      setAssetName(e.target.value.toUpperCase().slice(0, 16));
                    }}
                    placeholder="e.g. SOL"
                    maxLength={16}
                    disabled={submitting}
                    data-testid="asset-name-input"
                    className="w-full rounded-[6px] border border-l-hair bg-l-surface px-3 py-2 font-mono-plex text-[14px] uppercase tracking-[0.04em] text-l-text outline-none focus:border-l-text placeholder:text-l-faint disabled:opacity-50"
                  />
                  <AvailabilityLine avail={avail} valid={assetNameValid} assetName={assetName} />
                </Section>
              )}

              {/* Off-hours advisory (non-crypto, never blocks) */}
              {activeFeed?.stale && (
                <p className="font-mono-plex text-[11px] leading-[1.6] text-l-muted">
                  Market-hours asset — pricing resumes at next open.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer — cost line + primary (hidden on the success moment) */}
        {phase.kind !== "success" && (
          <div className="flex flex-none flex-col gap-3 border-t border-l-hair px-6 py-[14px]">
            {phase.kind === "failed" && (
              <div className="flex items-center justify-between gap-3" data-testid="create-failed">
                <span className="font-mono-plex text-[11px] text-l-down">Failed — {phase.message}</span>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "form" })}
                  className="font-mono-plex text-[11px] uppercase tracking-[0.12em] text-l-muted transition-colors hover:text-l-text"
                >
                  Retry create
                </button>
              </div>
            )}

            {!connected && !classNotEnabled && (
              <span className="font-mono-plex text-[11px] text-l-muted">Wallet not connected.</span>
            )}

            <div className="flex items-center justify-between gap-4">
              <span className="font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-muted">
                Network fee + rent{" "}
                <span className="text-l-text">{activeFeed && !classNotEnabled ? CREATE_COST : "—"}</span>
              </span>

              {!connected && !classNotEnabled ? (
                <button
                  type="button"
                  onClick={() => setVisible(true)}
                  data-testid="create-primary"
                  className="inline-flex items-center justify-center rounded-[6px] border border-l-hair px-[16px] py-[8px] font-sans text-[13px] font-medium text-l-text transition-colors hover:bg-l-surface"
                >
                  Connect wallet
                </button>
              ) : avail.kind === "live-same" ? (
                <Link
                  to={`/trade?asset=${encodeURIComponent(assetName)}`}
                  onClick={onClose}
                  data-testid="open-market"
                  className="inline-flex items-center justify-center rounded-[6px] bg-l-up px-[16px] py-[8px] font-sans text-[13px] font-medium text-l-on-up no-underline transition-opacity hover:opacity-90"
                >
                  Open market
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={doCreate}
                  disabled={!canSubmit}
                  data-testid="create-primary"
                  className="inline-flex items-center justify-center rounded-[6px] bg-l-up px-[16px] py-[8px] font-sans text-[13px] font-medium text-l-on-up transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? phase.label : "Create market"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// -----------------------------------------------------------------------------
const Section: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="mb-2 font-mono-plex text-[10px] uppercase tracking-[0.16em] text-l-muted">{label}</div>
    {children}
  </div>
);

const ResolveRow: FC<{ resolve: Resolve }> = ({ resolve }) => {
  if (resolve.kind === "resolving") {
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-muted" data-testid="resolve-state">
        Resolving token…
      </p>
    );
  }
  if (resolve.kind === "invalid") {
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-down" data-testid="resolve-state" data-state="invalid">
        Not a valid token address.
      </p>
    );
  }
  if (resolve.kind === "not-found") {
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-muted" data-testid="resolve-state" data-state="not-found">
        Token not found.
      </p>
    );
  }
  if (resolve.kind === "transport-error") {
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-muted" data-testid="resolve-state" data-state="transport-error">
        Couldn't verify this token right now — retry.
      </p>
    );
  }
  if (resolve.kind === "no-metadata") {
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-muted" data-testid="resolve-state" data-state="no-metadata">
        Couldn't read token metadata for this address.
      </p>
    );
  }
  if (resolve.kind === "no-feed") {
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-down" data-testid="resolve-state" data-state="no-feed">
        No price feed exists for this token — it can't be listed yet.
      </p>
    );
  }
  if (resolve.kind === "resolved") {
    return (
      <div
        className="mt-2 rounded-[6px] border border-l-hair bg-l-surface px-3 py-2"
        data-testid="resolve-state"
        data-state="resolved"
      >
        <div className="flex items-center justify-between gap-3 font-mono-plex text-[12px]">
          <span className="font-medium text-l-text">{resolve.choice.ticker}</span>
          <span className="tabular-nums text-l-faint">
            {resolve.mint.slice(0, 4)}…{resolve.mint.slice(-4)}
          </span>
        </div>
        <div className="mt-1 font-mono-plex text-[10.5px] text-l-up-text">price feed available</div>
        <div className="mt-0.5 font-mono-plex text-[10.5px] text-l-muted">
          Matches catalog asset: {resolve.choice.ticker}
        </div>
      </div>
    );
  }
  return null;
};

const AvailabilityLine: FC<{ avail: Avail; valid: boolean; assetName: string }> = ({ avail, valid }) => {
  if (!valid) {
    return (
      <p className="mt-1.5 font-mono-plex text-[10px] uppercase tracking-[0.12em] text-l-faint">
        1–16 chars · A–Z, 0–9 only
      </p>
    );
  }
  if (avail.kind === "checking" || avail.kind === "idle") {
    return <p className="mt-1.5 font-mono-plex text-[10.5px] text-l-faint" data-testid="avail">Checking…</p>;
  }
  if (avail.kind === "available") {
    return (
      <p className="mt-1.5 font-mono-plex text-[10.5px] text-l-up-text" data-testid="avail" data-state="available">
        ✓ Available
      </p>
    );
  }
  if (avail.kind === "live-same") {
    return (
      <p className="mt-1.5 font-mono-plex text-[10.5px] text-l-muted" data-testid="avail" data-state="live-same">
        Already live — view market →
      </p>
    );
  }
  return (
    <p className="mt-1.5 font-mono-plex text-[10.5px] text-l-down" data-testid="avail" data-state="taken-diff">
      Name taken by a different asset
    </p>
  );
};

const SuccessMoment: FC<{ sig: string; assetName: string; onClose: () => void }> = ({ sig, assetName, onClose }) => (
  <div className="space-y-5 py-2" data-testid="create-success">
    <div className="font-mono-plex text-[10px] uppercase tracking-[0.2em] text-l-up-text">● Market created</div>
    <div className="font-mono-plex text-[30px] leading-none tracking-[0.02em] text-l-text">{assetName}</div>
    {sig && (
      <div className="flex items-center gap-2 font-mono-plex text-[11px] text-l-muted">
        <span className="text-l-faint">SIG</span>
        <span className="tabular-nums">
          {sig.slice(0, 4)}…{sig.slice(-4)}
        </span>
        <SolscanLink kind="tx" id={sig} label="transaction" />
      </div>
    )}
    <p className="font-mono-plex text-[12px] leading-[1.6] text-l-muted">
      Registered on-chain. Not tradeable until the first option is written.
    </p>
    <div className="flex flex-wrap items-center gap-3 pt-1">
      <Link
        to={`/write?asset=${encodeURIComponent(assetName)}`}
        onClick={onClose}
        data-testid="write-first-option"
        className="inline-flex items-center justify-center rounded-[6px] bg-l-up px-[16px] py-[8px] font-sans text-[13px] font-medium text-l-on-up no-underline transition-opacity hover:opacity-90"
      >
        Write first option
      </Link>
      <Link
        to="/markets"
        onClick={onClose}
        className="inline-flex items-center justify-center rounded-[6px] border border-l-hair px-[16px] py-[8px] font-sans text-[13px] font-medium text-l-muted no-underline transition-colors hover:text-l-text"
      >
        View on Markets
      </Link>
    </div>
  </div>
);

export default NewMarketTerminalModal;
