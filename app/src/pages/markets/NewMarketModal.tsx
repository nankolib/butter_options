import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { showToast } from "../../components/Toast";
import { decodeError } from "../../utils/errorDecoder";
import { hexFromBytes } from "../../utils/format";
import {
  getCatalog,
  lookupByFeedId,
  type CatalogEntry,
} from "../../utils/hermesCatalog";
import { SB_FEED_DATA, lookupSbFeedDatum } from "../../utils/sbFeedData";
import {
  buildAssetRegistry,
  sbBaseTicker,
  type AssetRegistryEntry,
} from "../../utils/assetRegistry";
import { getHermesBase, getSbCreateEndpoint } from "../../utils/env";
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
/**
 * A selectable asset in the create list. Carries BOTH oracle ids + the
 * currently-resolved default source (see assetRegistry.ts) so routing picks the
 * matching feed id at create time. Pyth and SB are PEERS — `canonicalSource` is
 * a per-row default, not a permanent preference (Phase 2 re-resolves per-create).
 */
type FeedChoice = {
  /** Suggested on-chain asset name (the list/selection key). */
  ticker: string;
  /** Secondary display label (Hermes symbol or SB symbol). */
  label: string;
  /** On-chain asset_class u8 (0-4). */
  assetClass: number;
  /** 64-hex Pyth feed id, or null. */
  pythFeedId: string | null;
  /** 64-hex SB feed hash, or null. */
  sbFeedHash: string | null;
  /** Resolved default source: 0 Pyth / 1 SB. */
  canonicalSource: 0 | 1;
};

function registryEntryToChoice(e: AssetRegistryEntry): FeedChoice {
  return {
    ticker: e.ticker,
    label: e.commonName,
    assetClass: e.assetClass,
    pythFeedId: e.pythFeedId,
    sbFeedHash: e.sbFeedHash,
    canonicalSource: e.canonicalSource,
  };
}

// ===========================================================================
// Switchboard create-market flow (FE side)
// ===========================================================================
//
// The FE does NO Switchboard SDK work — it POSTs to the VPS builder endpoint,
// receives an UNSIGNED VersionedTransaction (base64), signs it with the user's
// wallet, and submits. The endpoint is stateless + freshness-bound (the tx
// blockhash expires before the embedded oracle quote does), so on a genuine
// stale failure we RE-POST for a fresh tx and re-sign the FRESH one — never
// re-submit or re-sign the stale tx. DELIBERATELY imports NO @switchboard-xyz/*
// or crank code; all SB SDK work lives server-side.

type SbCreateResponse = {
  transactionBase64: string;
  marketPda: string;
  lastValidBlockHeight: number;
};

/** A non-2xx response from the create endpoint, carrying the HTTP status so the
 *  caller can map it to a clean toast. Fails fast — never retried. */
class SbEndpointError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "SbEndpointError";
  }
}
/** The endpoint was unreachable (fetch threw). Fails fast — never retried. */
class SbNetworkError extends Error {
  constructor() {
    super("Could not reach create service.");
    this.name = "SbNetworkError";
  }
}
/** The user declined the wallet signature. Fails fast — never retried; surfaced
 *  as a neutral (info) toast, not an error. */
class SbUserRejectedError extends Error {
  constructor() {
    super("Signature cancelled");
    this.name = "SbUserRejectedError";
  }
}

type WalletSigner = {
  publicKey: PublicKey;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
};

/** True ONLY for a wallet user-rejection — must NOT be treated as stale (no
 *  retry) and surfaces as a neutral toast. */
function isUserRejection(e: any): boolean {
  if (e?.code === 4001) return true;
  const msg = String(e?.message ?? e ?? "").toLowerCase();
  return (
    msg.includes("user rejected") ||
    msg.includes("user denied") ||
    msg.includes("rejected the request") ||
    msg.includes("request rejected")
  );
}

/** True ONLY for a genuine blockhash-expiry / quote-staleness signal during
 *  submit/confirm — the ONE error class that triggers the single refetch-retry.
 *  Deliberately narrow: a user rejection, a 4xx/5xx, a network error, or any
 *  other program error returns false and fails fast. */
function isStaleSubmitError(e: any): boolean {
  const name = String(e?.name ?? "");
  if (
    name === "TransactionExpiredBlockheightExceededError" ||
    name === "TransactionExpiredTimeoutError"
  ) {
    return true;
  }
  const msg = String(e?.message ?? e ?? "").toLowerCase();
  return (
    msg.includes("block height exceeded") ||
    msg.includes("blockhash not found") ||
    msg.includes("transactionexpired") ||
    // On-chain SB quote staleness — rare (blockhash expires first per the
    // endpoint's documented freshness invariant), included defensively.
    msg.includes("switchboardverifyfailed")
  );
}

/** POST to the create endpoint for a fresh unsigned tx. Throws SbNetworkError
 *  (unreachable) or SbEndpointError (non-2xx / malformed) — both fail fast. */
async function postSbCreate(
  endpoint: string,
  body: {
    assetName: string;
    feedHashHex: string;
    assetClass: number;
    userPublicKey: string;
  },
): Promise<SbCreateResponse> {
  let resp: Response;
  try {
    resp = await fetch(`${endpoint}/sb-create-market`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SbNetworkError();
  }
  if (!resp.ok) {
    let msg = "";
    try {
      const j = await resp.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* non-JSON error body — leave msg empty, mapped by status */
    }
    throw new SbEndpointError(resp.status, msg);
  }
  let json: any;
  try {
    json = await resp.json();
  } catch {
    throw new SbEndpointError(resp.status, "malformed response from create service");
  }
  if (
    typeof json?.transactionBase64 !== "string" ||
    typeof json?.lastValidBlockHeight !== "number"
  ) {
    throw new SbEndpointError(resp.status, "malformed response from create service");
  }
  return {
    transactionBase64: json.transactionBase64,
    marketPda: typeof json.marketPda === "string" ? json.marketPda : "",
    lastValidBlockHeight: json.lastValidBlockHeight,
  };
}

/**
 * Fetch → deserialize → sign → submit → confirm the SB create tx, with a
 * retry-once policy that fires ONLY on a genuine stale signal.
 *
 * Error-class routing (precise by design — a too-broad retry would be a bug):
 *   - postSbCreate throw (network / 4xx / 5xx) → propagates, NO retry.
 *   - signTransaction throw → if user-rejection, SbUserRejectedError (NO retry);
 *     any other sign error propagates (NO retry).
 *   - send/confirm throw → ONLY isStaleSubmitError triggers ONE refetch-retry
 *     (re-POST + re-sign the FRESH tx). Anything else propagates immediately.
 * Capped at exactly one refetch (2 attempts total).
 */
async function submitSbCreateMarket(args: {
  endpoint: string;
  connection: Connection;
  wallet: WalletSigner;
  assetName: string;
  feedHashHex: string;
  assetClass: number;
  userPublicKey: string;
}): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // 1. Fresh tx every attempt (stateless endpoint). Endpoint/network errors
    //    propagate here — NOT candidates for the stale-retry.
    const resp = await postSbCreate(args.endpoint, {
      assetName: args.assetName,
      feedHashHex: args.feedHashHex,
      assetClass: args.assetClass,
      userPublicKey: args.userPublicKey,
    });
    const tx = VersionedTransaction.deserialize(
      Buffer.from(resp.transactionBase64, "base64"),
    );

    // 2. Sign the FRESH tx. A user rejection is NOT stale — fail fast clean.
    let signed: VersionedTransaction;
    try {
      signed = await args.wallet.signTransaction(tx);
    } catch (e) {
      if (isUserRejection(e)) throw new SbUserRejectedError();
      throw e; // other sign error — fail fast, no retry
    }

    // 3. Submit + confirm. ONLY a genuine stale signal here triggers the single
    //    refetch-retry; everything else fails fast.
    try {
      const sig = await args.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await args.connection.confirmTransaction(
        {
          signature: sig,
          blockhash: tx.message.recentBlockhash,
          lastValidBlockHeight: resp.lastValidBlockHeight,
        },
        "confirmed",
      );
      return sig;
    } catch (e) {
      if (attempt === 0 && isStaleSubmitError(e)) {
        // Stale → loop re-POSTs a FRESH tx + re-signs it. Never re-submit the
        // stale tx.
        continue;
      }
      throw e; // non-stale, or already retried once — fail fast
    }
  }
  // Unreachable: the loop returns on success or throws. Defensive only.
  throw new Error("SB create: exhausted retries");
}

/** Map an SB create failure to a clean inline toast message (title fixed to
 *  match the Pyth arm). User-rejection is handled separately by the caller. */
function mapSbError(e: unknown): { title: string; message: string } {
  const title = "Create market failed";
  if (e instanceof SbNetworkError) {
    return { title, message: "Could not reach create service." };
  }
  if (e instanceof SbEndpointError) {
    switch (e.status) {
      case 400:
        return { title, message: e.message || "Invalid request." };
      case 403:
      case 404:
        return { title, message: "SB create unavailable." };
      case 413:
      case 429:
        return { title, message: "Too many requests, try shortly." };
      case 502:
        return { title, message: "Switchboard quote unavailable, please retry." };
      default:
        return { title, message: e.message || "Create service error." };
    }
  }
  if (isStaleSubmitError(e)) {
    return { title, message: "Transaction expired — please try again." };
  }
  return { title, message: decodeError(e) };
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
    // Route by the row's resolved default source + pick the matching feed id.
    // Dual-source rows carry both ids; Phase 2 re-resolves this per-create from a
    // liveness map (Pyth/SB are peers, not preferred-vs-fallback).
    const feedIdHex =
      selected.canonicalSource === 0 ? selected.pythFeedId : selected.sbFeedHash;
    if (!feedIdHex) return null; // guard — canonicalSource guarantees its id is set
    return {
      feedIdHex,
      assetClass: selected.assetClass,
      oracleSource: selected.canonicalSource,
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
      if (knownSb) setAssetName(sbBaseTicker(knownSb.symbol));
      return;
    }
    if (selected) setAssetName(selected.ticker);
  }, [advancedActive, pastedHex, selected, catalogState]);

  // Unified registry: the live Pyth catalog (broad base) merged with sbFeedData
  // (SB hashes). DEGRADES on an empty/loading catalog — buildAssetRegistry([], …)
  // yields SB-only rows (gold) and never throws, so the modal stays usable.
  const registry = useMemo<AssetRegistryEntry[]>(
    () => buildAssetRegistry(entriesFromState(catalogState) ?? [], SB_FEED_DATA),
    [catalogState],
  );

  // One merged, class-filtered list (replaces the old crypto-vs-SB branch). Every
  // class now draws from the same registry; a TradFi row carries its Pyth id +
  // (where matched) its SB hash, and routes by canonicalSource at create time.
  const results = useMemo<FeedChoice[]>(() => {
    if (selectedClass === null) return [];
    const q = query.trim().toLowerCase();
    return registry
      .filter((r) => r.assetClass === selectedClass)
      .filter(
        (r) =>
          !q ||
          r.ticker.toLowerCase().includes(q) ||
          r.commonName.toLowerCase().includes(q),
      )
      .slice(0, 12)
      .map(registryEntryToChoice);
  }, [registry, selectedClass, query]);

  // Empty-state copy — uniform across classes now.
  const emptyMsg: string | null = (() => {
    if (selectedClass === null || results.length > 0) return null;
    if (catalogState.kind === "loading") return null; // input shows the loading hint
    if (query) return "No matches in catalog";
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

      // --- Switchboard arm (oracle_source = 1): build via the VPS endpoint, ---
      // sign client-side, submit. The FE pulls in NO @switchboard-xyz/* — the
      // endpoint does all SB SDK work and returns an unsigned tx.
      if (activeFeed.oracleSource !== 0) {
        const endpoint = getSbCreateEndpoint();
        if (!endpoint) {
          showToast({
            type: "error",
            title: "SB create not configured",
            message:
              "Switchboard market creation isn't configured for this deployment.",
          });
          return;
        }
        try {
          const sig = await submitSbCreateMarket({
            endpoint,
            connection: program.provider.connection,
            wallet: anchorWallet,
            assetName,
            feedHashHex: activeFeed.feedIdHex,
            assetClass: activeFeed.assetClass,
            userPublicKey: publicKey.toBase58(),
          });
          showToast({
            type: "success",
            title: "Market created",
            message: `${assetName} registered on-chain`,
            txSignature: sig,
          });
          onCreated();
          onClose();
        } catch (e) {
          if (e instanceof SbUserRejectedError) {
            // Neutral, not error-looking — the user chose to cancel.
            showToast({
              type: "info",
              title: "Signature cancelled",
              message: "You declined the transaction.",
            });
          } else {
            const { title, message } = mapSbError(e);
            showToast({ type: "error", title, message });
          }
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

  // The Hermes/Pyth catalog now feeds EVERY class (the broad base of the merge),
  // so its stale/failed banners are relevant for all classes, not just crypto.
  const showCatalogBanners = selectedClass !== null;
  const showSearchBlock = selectedClass !== null && !advancedActive;
  const searchPlaceholder =
    catalogState.kind === "loading"
      ? "Loading Hermes catalog…"
      : "Search by name or ticker (e.g. SOL, XAU, AAPL)";

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
        {showCatalogBanners && catalogState.kind === "stale" && (
          <div className="border border-rule-soft rounded-sm p-3 mb-5 text-[11px] font-mono font-medium uppercase tracking-[0.16em] text-ink-body">
            ⚠ Hermes unreachable — showing cached catalog from{" "}
            {new Date(catalogState.lastRefresh).toLocaleString()}
          </div>
        )}
        {showCatalogBanners && catalogState.kind === "failed" && (
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
                  const isSelected = selected?.ticker === choice.ticker;
                  return (
                    <li key={choice.ticker}>
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
