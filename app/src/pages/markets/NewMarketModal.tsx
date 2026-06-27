import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { showToast } from "../../components/Toast";
import { decodeError } from "../../utils/errorDecoder";
import { hexFromBytes } from "../../utils/format";
import {
  getCatalog,
  searchAssets,
  lookupByFeedId,
  type CatalogEntry,
} from "../../utils/hermesCatalog";
import {
  SB_FEED_DATA,
  normSbFeedHash,
  lookupSbFeedDatum,
  type SbFeedDatum,
} from "../../utils/sbFeedData";
import { getHermesBase } from "../../utils/env";
import {
  buildPostUpdateAndCreateMarketTx,
  submitWithFallback,
} from "../../utils/pythPullPost";

type NewMarketModalProps = {
  onClose: () => void;
  onCreated: () => void;
};

const ASSET_CLASS_LABEL: Record<number, string> = {
  0: "Crypto",
  1: "Commodity",
  2: "Equity",
  3: "FX",
  4: "ETF",
};

const CLASS_ORDER = [0, 1, 2, 3, 4] as const;

// On-chain seed constant — must match Rust (programs/opta/src/state/market.rs:65).
const MARKET_SEED = "market";

type CatalogState =
  | { kind: "loading" }
  | { kind: "fresh"; entries: CatalogEntry[] }
  | { kind: "stale"; entries: CatalogEntry[]; lastRefresh: number }
  | { kind: "failed"; error: string };

/** Unified, source-agnostic selection shape rendered in the result list and
 *  consumed by the create call. Built from either a Hermes CatalogEntry
 *  (crypto / Pyth) or an SbFeedDatum (commodity/equity/forex/etf / Switchboard). */
type FeedChoice = {
  /** 64-char lowercase hex, no 0x prefix. */
  feedIdHex: string;
  /** Suggested on-chain asset name. */
  ticker: string;
  /** Secondary display label (Hermes symbol or SB symbol). */
  label: string;
  /** On-chain asset_class u8 (0-4). */
  assetClass: number;
};

/** Derive a /^[A-Z0-9]{1,16}$/-friendly default ticker from an SB symbol like
 *  "XAU/USD" → "XAU". Strips the quote leg + non-alphanumerics. User-editable. */
function sbTickerFromSymbol(symbol: string): string {
  const base = symbol.split("/")[0] ?? symbol;
  return base.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);
}

function catalogEntryToChoice(e: CatalogEntry): FeedChoice {
  return {
    feedIdHex: e.feedIdHex,
    ticker: e.suggestedTicker,
    label: e.hermesSymbol,
    assetClass: e.suggestedAssetClass,
  };
}

function sbDatumToChoice(d: SbFeedDatum): FeedChoice {
  return {
    feedIdHex: normSbFeedHash(d.feedHashHex),
    ticker: sbTickerFromSymbol(d.symbol),
    label: d.symbol,
    assetClass: d.suggestedAssetClass,
  };
}

/**
 * Switchboard create-market builder — STUB (this increment).
 *
 * The real SB create needs a fresh ed25519-signed Switchboard quote (Crossbar
 * fetch + on-chain QuoteVerifier existence proof) — confirmed required by the
 * on-chain create_market SB arm; static accounts alone don't pass. That pulls
 * the heavy SB SDK into the FE bundle, so it lands in a later increment. Until
 * then this throws a clean coming-soon error the modal surfaces inline.
 *
 * DELIBERATELY imports NO @switchboard-xyz/* or crank code — keeps the SB SDK
 * out of the FE bundle.
 */
async function buildSbCreateMarketTx(): Promise<never> {
  throw new Error("Switchboard market creation is not yet wired — coming soon");
}

/**
 * Paper-aesthetic New Market modal — CLASS-FIRST.
 *
 * Step 1: the user picks an asset class (crypto/commodity/equity/FX/ETF).
 * Step 2: a class-scoped asset search appears. Crypto searches the live Hermes
 * catalog (filtered to class 0) and routes to the Pyth create path. The other
 * four classes search the SB feed registry (sbFeedData) and route to Switchboard
 * — currently stubbed (clean "coming soon" inline error). Advanced paste-feed-id
 * stays available as the manual escape hatch, its class pill pre-filled from the
 * chosen class but user-overridable.
 *
 * Submit does a pre-check via getAccountInfo to detect name collisions
 * (source-agnostic): same feed_id → idempotent success; different feed_id →
 * friendly "name taken"; none → route by oracle_source.
 *
 * Esc and click-outside dismiss the modal.
 */
export const NewMarketModal: FC<NewMarketModalProps> = ({
  onClose,
  onCreated,
}) => {
  const { program, provider } = useProgram();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();

  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: "loading" });
  const [selectedClass, setSelectedClass] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<FeedChoice | null>(null);
  const [assetName, setAssetName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pastedHex, setPastedHex] = useState("");
  const [pastedClass, setPastedClass] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);

  // A dead Hermes catalog only blocks CRYPTO (the SB classes don't use it), so a
  // Hermes failure forces Advanced paste for crypto ONLY. SB classes keep showing
  // their feed list normally even when Hermes is down. `advancedActive` folds in
  // the user's manual Advanced toggle.
  const cryptoCatalogDead =
    selectedClass === 0 && catalogState.kind === "failed";
  const advancedActive = advancedOpen || cryptoCatalogDead;

  // Resolve the active (feedIdHex, assetClass, oracleSource) triple from either
  // the scoped selection or the advanced paste-feed-id form. oracleSource is
  // derived from the resolved asset_class: class 0 (crypto) → Pyth (0); every
  // other class → Switchboard (1). This is correct for both the scoped path
  // (selection class == selectedClass) and advanced (class == pastedClass).
  const activeFeed:
    | { feedIdHex: string; assetClass: number; oracleSource: number }
    | null = useMemo(() => {
    if (selectedClass === null) return null;
    if (advancedActive) {
      const hex = pastedHex.trim().toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(hex)) return null;
      return {
        feedIdHex: hex,
        assetClass: pastedClass,
        oracleSource: pastedClass === 0 ? 0 : 1,
      };
    }
    if (!selected) return null;
    return {
      feedIdHex: selected.feedIdHex,
      assetClass: selected.assetClass,
      oracleSource: selected.assetClass === 0 ? 0 : 1,
    };
  }, [selectedClass, advancedActive, pastedHex, pastedClass, selected]);

  // Load catalog on mount. React-18-canonical fetch-on-mount: rely on
  // the per-mount `cancelled` flag to suppress stale-mount setter calls.
  // A useRef-based "run once" guard would persist across StrictMode's
  // double-mount and break the cancellation contract — see the failure
  // mode hunted down in the P4c smoke session.
  useEffect(() => {
    let cancelled = false;
    getCatalog({ hermesBase: getHermesBase() })
      .then((res) => {
        if (cancelled) return;
        if (res.isStale) {
          setCatalogState({
            kind: "stale",
            entries: res.entries,
            lastRefresh: res.lastRefresh,
          });
        } else {
          setCatalogState({ kind: "fresh", entries: res.entries });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // Record the failure. We do NOT globally force Advanced here — only
        // crypto needs the catalog, so the crypto-only `cryptoCatalogDead`
        // derivation routes crypto to Advanced while leaving SB classes on
        // their (catalog-independent) feed list.
        setCatalogState({ kind: "failed", error: err?.message ?? "unknown" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Sync assetName from selection, but only when the user hasn't started
  // editing it. Once they've typed anything, leave their value alone.
  const userEditedRef = useRef(false);
  useEffect(() => {
    if (userEditedRef.current) return;
    if (advancedActive) {
      // In advanced mode, suggest a ticker if the pasted feed_id is a known
      // catalog entry (Hermes first, then SB registry); else leave it editable.
      const hex = pastedHex.trim().toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(hex)) return;
      const entries = entriesFromState(catalogState);
      const knownHermes = entries ? lookupByFeedId(entries, hex) : null;
      if (knownHermes) {
        setAssetName(knownHermes.suggestedTicker);
        return;
      }
      const knownSb = lookupSbFeedDatum(hex);
      if (knownSb) setAssetName(sbTickerFromSymbol(knownSb.symbol));
      return;
    }
    if (selected) setAssetName(selected.ticker);
  }, [advancedActive, pastedHex, selected, catalogState]);

  // Class-scoped crypto results (Hermes catalog, filtered to class 0).
  const cryptoResults = useMemo<FeedChoice[]>(() => {
    if (selectedClass !== 0) return [];
    const entries = entriesFromState(catalogState);
    if (!entries) return [];
    return searchAssets(entries, query)
      .filter((e) => e.suggestedAssetClass === 0)
      .slice(0, 12)
      .map(catalogEntryToChoice);
  }, [selectedClass, catalogState, query]);

  // Class-scoped Switchboard results (sbFeedData, filtered to selectedClass).
  const sbResults = useMemo<FeedChoice[]>(() => {
    if (selectedClass === null || selectedClass === 0) return [];
    const q = query.trim().toLowerCase();
    return SB_FEED_DATA.filter((d) => d.suggestedAssetClass === selectedClass)
      .filter(
        (d) =>
          !q ||
          d.symbol.toLowerCase().includes(q) ||
          sbTickerFromSymbol(d.symbol).toLowerCase().includes(q),
      )
      .slice(0, 12)
      .map(sbDatumToChoice);
  }, [selectedClass, query]);

  const results = selectedClass === 0 ? cryptoResults : sbResults;

  const sbClassHasAnyFeed =
    selectedClass !== null &&
    selectedClass !== 0 &&
    SB_FEED_DATA.some((d) => d.suggestedAssetClass === selectedClass);

  // Empty-state copy for the active scope.
  const emptyMsg: string | null = (() => {
    if (results.length > 0) return null;
    if (selectedClass === 0) {
      return catalogState.kind !== "loading" && query ? "No matches in catalog" : null;
    }
    if (selectedClass !== null) {
      if (!sbClassHasAnyFeed)
        return "No Switchboard feeds available for this class yet";
      if (query) return "No matches";
    }
    return null;
  })();

  const assetNameValid = /^[A-Z0-9]{1,16}$/.test(assetName);

  const canSubmit =
    !submitting &&
    !!program &&
    !!provider &&
    !!publicKey &&
    !!anchorWallet &&
    !!activeFeed &&
    assetNameValid;

  // Pick an asset class — resets all selection state so a stale pick from a
  // previous class can't ride into the new class's create call, and pre-fills
  // the Advanced class pill (overridable).
  const handleSelectClass = (cls: number) => {
    if (cls === selectedClass) return;
    setSelectedClass(cls);
    setSelected(null);
    setQuery("");
    setAssetName("");
    userEditedRef.current = false;
    setPastedClass(cls);
  };

  const handleSubmit = async () => {
    if (
      !canSubmit ||
      !program ||
      !provider ||
      !publicKey ||
      !anchorWallet ||
      !activeFeed
    )
      return;
    setSubmitting(true);
    try {
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
        program.programId,
      );

      // Pre-submit collision check (source-agnostic — runs for BOTH arms).
      // Avoids burning rent + RPC on a known-bad call when the asset name is
      // already taken with a different feed_id, and lets us offer a friendlier
      // message than the chain's raw AssetMismatch error.
      const existing = await program.provider.connection.getAccountInfo(marketPda);
      if (existing) {
        const decoded = program.coder.accounts.decode<{
          assetName: string;
          pythFeedId: number[];
          assetClass: number;
        }>("optionsMarket", existing.data);
        const existingHex = hexFromBytes(decoded.pythFeedId);
        if (existingHex === activeFeed.feedIdHex) {
          showToast({
            type: "success",
            title: "Market already exists",
            message: `${assetName} is already registered with this feed_id.`,
          });
          onCreated();
          onClose();
          return;
        }
        showToast({
          type: "error",
          title: "Asset name taken",
          message: `An asset named "${assetName}" already exists with a different feed_id. Pick a different name or contact admin to migrate.`,
        });
        return;
      }

      // --- Switchboard arm (oracle_source = 1): routed but not yet wired. ---
      // The local stub throws a clean coming-soon error; surface it inline (no
      // crash) and bail. NO @switchboard-xyz/* import reaches the FE bundle.
      if (activeFeed.oracleSource !== 0) {
        try {
          await buildSbCreateMarketTx();
        } catch (sbErr: any) {
          showToast({
            type: "error",
            title: "Coming soon",
            message:
              sbErr?.message ?? "Switchboard market creation is not yet wired",
          });
        }
        return;
      }

      // --- Pyth arm (oracle_source = 0): unchanged from the pre-class-first
      // flow. HIGH-5 (audit Run-7): create_market requires a fresh Pyth
      // PriceUpdateV2 proving the feed_id is real; the helper posts a Hermes
      // /latest update + invokes create_market in one atomic tx (ephemeral
      // account rent-reclaimed via closeUpdateAccounts).
      const txs = await buildPostUpdateAndCreateMarketTx(
        program,
        anchorWallet,
        assetName,
        activeFeed.feedIdHex,
        activeFeed.assetClass,
        getHermesBase(),
      );
      const tx = await submitWithFallback(
        program.provider.connection,
        anchorWallet,
        txs,
      );

      showToast({
        type: "success",
        title: "Market created",
        message: `${assetName} registered on-chain`,
        txSignature: tx,
      });
      onCreated();
      onClose();
    } catch (err: any) {
      const decoded = decodeError(err);
      // Race condition: another tx grabbed the PDA between our pre-check
      // and the RPC. Surface the same friendly text the pre-check would.
      if (typeof decoded === "string" && decoded.includes("AssetMismatch")) {
        showToast({
          type: "error",
          title: "Asset name taken",
          message: `An asset named "${assetName}" already exists with a different feed_id. Pick a different name or contact admin to migrate.`,
        });
      } else {
        showToast({
          type: "error",
          title: "Create market failed",
          message: decoded,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const showCryptoCatalogBanners = selectedClass === 0;
  const showSearchBlock = selectedClass !== null && !advancedActive;
  const searchPlaceholder =
    selectedClass === 0
      ? catalogState.kind === "loading"
        ? "Loading Hermes catalog…"
        : "Search by ticker or symbol (e.g. SOL, BTC)"
      : "Search (e.g. XAU, gold)";

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-paper border border-rule rounded-md p-5 sm:p-8 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="m-0 font-fraunces-mid font-light text-ink leading-tight tracking-[-0.01em] text-[24px]">
            New market
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="font-mono text-[14px] text-ink-muted hover:text-ink transition-colors duration-200"
          >
            ✕
          </button>
        </div>

        {/* Step 1 — asset class (first interaction). Routes the oracle
            invisibly: crypto → Pyth, all others → Switchboard. */}
        <Field label="Asset class">
          <div className="flex flex-wrap gap-2">
            {CLASS_ORDER.map((cls) => (
              <button
                key={cls}
                type="button"
                onClick={() => handleSelectClass(cls)}
                aria-pressed={selectedClass === cls}
                className={`rounded-full border px-4 py-1.5 font-mono font-medium text-[11px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                  selectedClass === cls
                    ? "border-ink bg-ink text-paper"
                    : "border-rule text-ink-muted hover:text-ink hover:border-ink"
                }`}
              >
                {ASSET_CLASS_LABEL[cls]}
              </button>
            ))}
          </div>
        </Field>

        {selectedClass === null && (
          <div className="font-sans italic font-medium text-ink-body text-[14px] leading-[1.55] mb-2">
            Pick an asset class to begin.
          </div>
        )}

        {/* Hermes catalog banners — crypto only (SB classes don't use it). */}
        {showCryptoCatalogBanners && catalogState.kind === "stale" && (
          <div className="border border-rule-soft rounded-sm p-3 mb-5 text-[11px] font-mono font-medium uppercase tracking-[0.16em] text-ink-body">
            ⚠ Hermes unreachable — showing cached catalog from{" "}
            {new Date(catalogState.lastRefresh).toLocaleString()}
          </div>
        )}
        {showCryptoCatalogBanners && catalogState.kind === "failed" && (
          <div className="border border-rule-soft rounded-sm p-3 mb-5 text-[11px] font-mono uppercase tracking-[0.16em] text-crimson">
            Hermes unreachable & no cached catalog. Use Advanced → paste feed_id hex.
            <div className="text-ink-body normal-case mt-1.5 tracking-normal">
              {catalogState.error}
            </div>
          </div>
        )}

        {/* Step 2 — class-scoped asset search */}
        {showSearchBlock && (
          <Field label="Asset">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              disabled={selectedClass === 0 && catalogState.kind === "loading"}
              className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[16px] text-ink focus:outline-none focus:border-ink transition-colors duration-200 disabled:opacity-50"
            />
            {results.length > 0 && (
              <ul className="border border-rule-soft rounded-sm mt-2 max-h-[240px] overflow-y-auto">
                {results.map((choice) => {
                  const isSelected = selected?.feedIdHex === choice.feedIdHex;
                  return (
                    <li key={choice.feedIdHex}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(choice);
                          userEditedRef.current = false;
                        }}
                        aria-pressed={isSelected}
                        className={`w-full flex items-center justify-between text-left px-3 py-2 font-mono text-[12px] transition-colors duration-200 ${
                          isSelected
                            ? "bg-ink text-paper"
                            : "text-ink-body hover:text-ink hover:bg-paper-2"
                        }`}
                      >
                        <span>
                          <span className="font-medium">{choice.ticker}</span>
                          <span className="ml-2 text-ink-muted">{choice.label}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {emptyMsg && (
              <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] text-ink-muted mt-2">
                {emptyMsg}
              </div>
            )}
          </Field>
        )}

        {/* Advanced: paste feed_id hex — manual escape hatch (any class). The
            toggle is hidden when crypto's catalog is dead (Advanced is then the
            only path, so there is nothing to toggle back to). */}
        {selectedClass !== null && (
          <Field label="">
            {!cryptoCatalogDead && (
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] text-ink-muted hover:text-crimson transition-colors duration-300 ease-opta"
              >
                {advancedActive ? "← Back to catalog search" : "Advanced — paste feed_id hex"}
              </button>
            )}
            {advancedActive && (
              <div className="border border-rule-soft rounded-sm p-3 mt-2 space-y-2">
                <input
                  type="text"
                  value={pastedHex}
                  onChange={(e) => setPastedHex(e.target.value)}
                  placeholder="64-char hex (no 0x)"
                  className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[16px] text-ink focus:outline-none focus:border-ink"
                  spellCheck={false}
                />
                <div className="flex flex-wrap gap-2">
                  {[0, 1, 2, 3, 4].map((cls) => (
                    <button
                      key={cls}
                      type="button"
                      onClick={() => setPastedClass(cls)}
                      aria-pressed={pastedClass === cls}
                      className={`rounded-full border px-3 py-1 font-mono font-medium text-[10px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                        pastedClass === cls
                          ? "border-ink text-ink"
                          : "border-rule text-ink-muted hover:text-ink hover:border-ink"
                      }`}
                    >
                      {ASSET_CLASS_LABEL[cls]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Field>
        )}

        {/* asset_name (editable, validated) */}
        {activeFeed && (
          <Field label="Asset name (on-chain identifier)">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={assetName}
                onChange={(e) => {
                  userEditedRef.current = true;
                  setAssetName(e.target.value.toUpperCase());
                }}
                placeholder="e.g. SOL"
                maxLength={16}
                className="flex-1 bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[16px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
              />
              <span
                className={`font-mono text-[12px] ${assetNameValid ? "text-emerald-700" : "text-crimson"}`}
                aria-label={assetNameValid ? "valid" : "invalid"}
              >
                {assetNameValid ? "✓" : "✕"}
              </span>
            </div>
            <div className="font-mono font-medium text-[10px] uppercase tracking-[0.18em] text-ink-muted mt-1.5">
              1-16 chars · A-Z, 0-9 only · Class:{" "}
              {ASSET_CLASS_LABEL[activeFeed.assetClass]}
            </div>
          </Field>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full border border-rule px-4 py-3 font-mono font-medium text-[11px] uppercase tracking-[0.2em] text-ink-muted hover:text-ink hover:border-ink transition-colors duration-300 ease-opta"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1 rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
          >
            {submitting ? "Creating…" : "Create Market"}
          </button>
        </div>
      </div>
    </div>
  );
};

const Field: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="mb-5">
    {label && (
      <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.2em] text-ink-muted mb-2">
        {label}
      </div>
    )}
    {children}
  </div>
);

function entriesFromState(state: CatalogState): CatalogEntry[] | null {
  if (state.kind === "fresh") return state.entries;
  if (state.kind === "stale") return state.entries;
  return null;
}

export default NewMarketModal;
