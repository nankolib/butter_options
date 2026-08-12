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
import {
  isMarketHours,
  nextOpenLabel,
  ASSET_CLASS_EQUITY,
  ASSET_CLASS_ETF,
  ASSET_CLASS_FX,
  type AssetClass,
} from "../../utils/marketHours";
import { buildPostUpdateAndCreateMarketTx, submitWithFallback } from "../../utils/pythPullPost";
import {
  submitSbCreateMarket,
  submitPythCreateWithRetry,
  mapSbError,
  SbUserRejectedError,
} from "./newMarketCreate";
import {
  IDENTITY_TIMEOUT_MS,
  looksLikeMint,
  resolveTokenIdentity,
  type TokenIdentity,
} from "../../utils/tokenIdentity";
import { VOL_ORACLE_EXPECTED_WAIT, VOL_ORACLE_POLL_MS } from "../../hooks/useVolOracleStatus";
import { VOL_ORACLE_SEED } from "../../utils/constants";
import { invalidateAccountScans } from "../../hooks/useFetchAccounts";
import { parseMintAddress, resolveMintSymbol } from "../../utils/resolveMintSymbol";
import { SolscanLink } from "../../components/SolscanLink";
import {
  checkAlreadyRequested,
  submitListingRequest,
  type ListingOutcome,
} from "../../utils/listingRequest";

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

/** Classes with zero end-to-end proof on this deployment. Measured 2026-08-11:
 *  FX has 2 markets and ZERO vaults ever; ETF has never had a market created at
 *  all. Crypto, commodity and equity have all written AND sold. */
const UNPROVEN_CLASSES = new Set<number>([3, 4]);

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

// ---------------------------------------------------------------------------
// SLICE 2A — identity and listability are TWO questions, asked in that order.
//
// The old state machine collapsed them: a token with no price feed produced
// "no-feed" and nothing else, so a real, verified, well-known token rendered as
// a bare rejection with no name attached. Worse, identity failure and feed
// absence shared a code path, so "we could not read this token" and "this token
// cannot be listed" were indistinguishable to the user.
//
// Now: resolve WHO it is first and always show that. Then, separately, say
// whether it can be listed. BP is "Backpack, verified — no settlement feed yet",
// which is the truth; it used to be twelve seconds of spinner followed by a
// one-line refusal.
// ---------------------------------------------------------------------------
type Resolve =
  | { kind: "idle" }
  | { kind: "resolving" }
  /** Identity known AND a catalog feed matched — this can be created. */
  | { kind: "listable"; identity: TokenIdentity; choice: FeedChoice }
  /** Identity known, no settlement feed. An honest dead end, with a name on it. */
  | { kind: "no-feed"; identity: TokenIdentity }
  /** Every source answered; none knows this token. */
  | { kind: "unknown" }
  /** We could not check (timeout / transport). NOT the same as unknown. */
  | { kind: "unavailable"; reason: "timeout" | "transport" }
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
  | { kind: "success"; sig: string; assetName: string; feedIdHex: string; oracleSource: number }
  | { kind: "failed"; message: string; sig?: string };

export const NewMarketTerminalModal: FC<Props> = ({ onClose, onCreated }) => {
  const { program, provider } = useProgram();
  const { publicKey, connected, signMessage } = useWallet();
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

  // WHEN do we ask the identity service? A pasted address always. A typed name
  // ONLY once our own asset list has come up empty — otherwise every keystroke
  // toward a listed asset would fire a lookup we do not need. This is what lets
  // someone type "backpack", get no local match, and still be told what the
  // token is and why it cannot be listed, instead of a bare "No assets match".
  const identityQuery = useMemo(() => {
    if (!isCrypto || advancedActive || classNotEnabled) return "";
    const q = query.trim();
    if (looksLikeAddress) return q;
    if (q.length >= 2 && results.length === 0 && catalog.kind !== "loading") return q;
    return "";
  }, [isCrypto, advancedActive, classNotEnabled, looksLikeAddress, query, results.length, catalog.kind]);

  // ---- SLICE 2A: identity resolution (bounded, catalog-first) ----
  //
  // WHAT THIS REPLACES. The previous effect called an RPC-only resolver that
  // walked 2-5 sequential round-trips with a silent retry and NO TIMEOUT.
  // Measured on 2026-08-11 against the app's own mainnet fallback RPC, a single
  // BP mint read took 12,292 ms, and the same read repeated ran 4,676 / 215 /
  // 1,663 ms. That is the "infinite spinner": not a hang, an unbounded wait.
  // Both reported dead ends (BP, 9cRCn9…pump) were real, resolvable tokens —
  // "Backpack" and "ANSEM" — that simply never got the chance to say so.
  //
  // resolveTokenIdentity is catalog-first (~0.4 s) with the on-chain resolver
  // kept as the fallback for tokens no catalog has indexed, and a HARD deadline
  // over the whole thing. It cannot hang.
  //
  // Runs for a pasted ADDRESS or a typed NAME once the local catalog has no
  // match — so a user who types "backpack" and gets nothing from our own asset
  // list still learns what the token is and why it is not listable.
  useEffect(() => {
    const raw = query.trim();
    if (!identityQuery) {
      setResolve({ kind: "idle" });
      return;
    }
    const seq = ++resolveSeq.current;
    const ctrl = new AbortController();
    setResolve({ kind: "resolving" });

    const t = window.setTimeout(async () => {
      const isAddr = looksLikeMint(raw);
      const mint = isAddr ? parseMintAddress(raw) : null;
      if (isAddr && !mint) {
        if (resolveSeq.current === seq) setResolve({ kind: "invalid" });
        return;
      }

      const out = await resolveTokenIdentity(raw, {
        endpoint: sbEndpoint,
        mint,
        // The on-chain resolver is injected rather than imported by the identity
        // module, so that module stays free of ./env and therefore testable.
        chainFallback: async (mk) => {
          const r = await resolveMintSymbol(connection, mk);
          if (r.kind === "resolved") {
            return {
              kind: "found",
              identity: {
                mint: mk.toBase58(),
                symbol: r.symbol,
                name: r.name,
                // On-chain metadata is self-asserted: never inherits a badge.
                verified: false,
                tags: [],
                decimals: null,
                tokenProgram: null,
                iconDataUri: null,
                origin: "chain",
              },
            };
          }
          if (r.kind === "transport-error") return { kind: "unavailable", reason: "transport" };
          return { kind: "unknown" };
        },
        timeoutMs: IDENTITY_TIMEOUT_MS,
        signal: ctrl.signal,
      });
      if (resolveSeq.current !== seq) return;

      if (out.kind === "unavailable") {
        setResolve({ kind: "unavailable", reason: out.reason });
        return;
      }
      if (out.kind === "unknown") {
        setResolve({ kind: "unknown" });
        return;
      }

      // Identity is known. NOW ask the separate question: is it listable?
      //
      // ANTI-SPOOF, unchanged and load-bearing: the resolved symbol only ever
      // SELECTS a canonical catalog row. The feed a market is created against
      // always comes from that row, never from the pasted mint or the catalog's
      // own metadata — so a spoofed symbol can at worst point at a legitimate
      // asset, and can never inject a feed.
      const sym = normTicker(out.identity.symbol);
      const match = sym
        ? registry.find((r) => r.assetClass === 0 && normTicker(r.ticker) === sym)
        : undefined;
      setResolve(
        match
          ? { kind: "listable", identity: out.identity, choice: toChoice(match) }
          : { kind: "no-feed", identity: out.identity },
      );
    }, 250);

    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [identityQuery, query, connection, registry, sbEndpoint]);

  // A listable identity becomes the selection (and seeds the on-chain name).
  useEffect(() => {
    if (resolve.kind === "listable") {
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

  // ---- SLICE 2B item 7: is this asset's settlement venue open RIGHT NOW? ----
  //
  // A create needs a live price: the SB arm needs a fresh signed quote, the Pyth
  // arm needs a fresh Hermes update. Neither exists while the venue is shut, so
  // an equity create between 20:00 and 13:30 UTC cannot succeed — and until now
  // it failed with "Verification quote unavailable — retry.", which is wrong
  // twice: retrying cannot work, and it never said when it could.
  //
  // Keyed on the ACTIVE class (the Advanced paste path can pick its own), and
  // computed for NOW rather than for an expiry — this is about whether we can
  // read a price this second.
  const venue = useMemo(() => {
    const cls = activeFeed?.assetClass;
    if (cls !== ASSET_CLASS_EQUITY && cls !== ASSET_CLASS_ETF && cls !== ASSET_CLASS_FX) {
      return null; // crypto + commodity are never venue-gated
    }
    const r = isMarketHours(Math.floor(Date.now() / 1000), cls as AssetClass);
    if (r.ok) return null;
    return {
      label: r.nextValidUnixSec !== undefined ? nextOpenLabel(r.nextValidUnixSec) : null,
      reason: r.reason,
    };
  }, [activeFeed]);

  // ---- SLICE 2C: listing demand for a token we cannot list ----------------
  //
  // The no-feed verdict is honest but terminal: the user learns the answer is
  // no and has nowhere to put the fact that they wanted it. This is where that
  // goes. Signed, so the demand is attributable and spam-resistant; the whole
  // value of the table is that somebody real asked.
  type ListingState =
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "signing" }
    | { kind: "sending" }
    | { kind: "done"; already: boolean }
    | { kind: "failed"; message: string };
  const [listing, setListing] = useState<ListingState>({ kind: "idle" });

  // The token currently sitting in the no-feed verdict, if any.
  const noFeedMint =
    resolve.kind === "no-feed" ? resolve.identity.mint : null;
  const noFeedIdentity = resolve.kind === "no-feed" ? resolve.identity : null;

  // On verdict render, ask whether THIS wallet already requested THIS mint, so
  // a revisit shows the recorded state instead of offering the action again.
  useEffect(() => {
    if (!noFeedMint || !publicKey) {
      setListing({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setListing({ kind: "checking" });
    checkAlreadyRequested("", publicKey.toBase58(), noFeedMint)
      .then((already) => {
        if (cancelled) return;
        // NULL means we could not tell — show the button. Offering an action
        // twice is a far smaller failure than hiding one never taken.
        setListing(already === true ? { kind: "done", already: true } : { kind: "idle" });
      })
      .catch(() => !cancelled && setListing({ kind: "idle" }));
    return () => {
      cancelled = true;
    };
  }, [noFeedMint, publicKey]);

  const requestListing = async () => {
    if (!noFeedIdentity || !publicKey || !signMessage) return;
    setListing({ kind: "signing" });
    const out: ListingOutcome = await submitListingRequest(
      {
        mint: noFeedIdentity.mint,
        symbol: noFeedIdentity.symbol || "?",
        assetClass: selectedClass ?? 0,
      },
      {
        apiBase: "", // same-origin: nginx fronts the points API on opta.fyi
        wallet: publicKey.toBase58(),
        sign: signMessage,
        nowUnix: Math.floor(Date.now() / 1000),
      },
    );
    if (out.kind === "recorded") setListing({ kind: "done", already: false });
    else if (out.kind === "already-requested") setListing({ kind: "done", already: true });
    // A decline is a DECISION: back to the idle button, nothing red.
    else if (out.kind === "declined") setListing({ kind: "idle" });
    else if (out.kind === "rejected") setListing({ kind: "failed", message: out.reason });
    else setListing({ kind: "failed", message: "Couldn't reach the listing service — try again." });
  };

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
    // A closed venue cannot produce the price this create needs. Blocking here
    // turns a confusing on-chain failure into a stated opening time.
    venue === null &&
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
          setPhase({
            kind: "success",
            sig: "",
            assetName,
            feedIdHex: activeFeed.feedIdHex,
            oracleSource: activeFeed.oracleSource,
          });
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
        // --- Pyth arm — now with the single refetch the SB arm has had since
        // `62f228e`, and which this arm has NEVER had. It serves every
        // non-curated asset, i.e. almost everything a user can create, so a
        // slow wallet approve here was a dead end with no recovery at all.
        // The retry REBUILDS (fresh price update + fresh blockhash) rather than
        // resending bytes that are already expired.
        sig = await submitPythCreateWithRetry({
          build: () =>
            buildPostUpdateAndCreateMarketTx(
              program,
              anchorWallet,
              assetName,
              activeFeed.feedIdHex,
              activeFeed.assetClass,
              getHermesBase(),
              activeFeed.oracleSource,
            ),
          submit: (txs) => submitWithFallback(program.provider.connection, anchorWallet, txs),
          onRefetch: () =>
            setPhase({ kind: "submitting", label: "Refreshing the price update — approve promptly…" }),
        });
      }

      // Create-success refetch — drop the coalesced optionsMarket scan so the
      // parent's refetch reads chain-fresh (no manual reload).
      invalidateAccountScans(program, ["optionsMarket"]);
      onCreated();
      setPhase({
        kind: "success",
        sig,
        assetName,
        feedIdHex: activeFeed.feedIdHex,
        oracleSource: activeFeed.oracleSource,
      });
    } catch (e) {
      if (e instanceof SbUserRejectedError) {
        setPhase({ kind: "failed", message: "Rejected in wallet." });
      } else {
        // NOTE: no venue-aware branch here. `canSubmit` requires `venue === null`,
        // so a closed-venue create can no longer be SUBMITTED — the opening time
        // is stated on the form and the button is disabled. Adding a fallback
        // here would be unreachable code pretending to be a safety net.
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
            <SuccessMoment
              sig={phase.sig}
              assetName={phase.assetName}
              feedIdHex={phase.feedIdHex}
              oracleSource={phase.oracleSource}
              onClose={onClose}
            />
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
                  {!!identityQuery && (
                    <ResolveRow
                      resolve={resolve}
                      requestSlot={
                        resolve.kind === "no-feed" ? (
                          <ListingRequestSlot
                            state={listing}
                            connected={connected}
                            canSign={!!signMessage}
                            onRequest={requestListing}
                            onConnect={() => setVisible(true)}
                          />
                        ) : null
                      }
                    />
                  )}

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
                  {!identityQuery && selectedClass !== null && query.trim() && results.length === 0 && catalog.kind !== "loading" && (
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

              {/* Venue closed — a FACT and a time, not "retry". This blocks
                  Create, because a create with no live price cannot succeed. */}
              {venue && (
                <p
                  data-testid="venue-closed"
                  className="font-mono-plex text-[11px] leading-[1.6] text-l-muted"
                >
                  {venue.reason}{" "}
                  {venue.label ? (
                    <span className="text-l-text">Listing {venue.label}.</span>
                  ) : (
                    <span className="text-l-text">Listing resumes at the next session.</span>
                  )}
                </p>
              )}

              {/* Liveness advisory — only when the venue itself is open, so the
                  two never contradict each other on the same screen. */}
              {!venue && activeFeed?.stale && (
                <p className="font-mono-plex text-[11px] leading-[1.6] text-l-muted">
                  Market-hours asset — pricing resumes at next open.
                </p>
              )}

              {/* FX / ETF: honest about how far these paths are proven. Nothing
                  is blocked — the chain accepts them and the gates are real —
                  but no FX or ETF market has ever been written and settled
                  end to end here, and a user betting an evening on one deserves
                  to know that before they start rather than after. */}
              {UNPROVEN_CLASSES.has(selectedClass ?? -1) && !classNotEnabled && (
                <p
                  data-testid="unproven-class"
                  className="font-mono-plex text-[11px] leading-[1.6] text-l-muted"
                >
                  {selectedClass === ASSET_CLASS_FX ? "FX" : "ETF"} listing works, but no{" "}
                  {selectedClass === ASSET_CLASS_FX ? "FX" : "ETF"} market has been taken through
                  write and settlement yet. You'd be the first — expect rough edges.
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

// -----------------------------------------------------------------------------
// ResolveRow — identity FIRST, then a separate verdict on listability.
//
// The two lines are deliberately independent. "We don't know what this is" and
// "we know exactly what this is and it can't be listed" are different answers
// and deserve different words; the old single-line design could only say the
// second one, so a verified, well-known token read as a flat refusal.
// -----------------------------------------------------------------------------
const ResolveRow: FC<{ resolve: Resolve; requestSlot?: React.ReactNode }> = ({ resolve, requestSlot }) => {
  if (resolve.kind === "resolving") {
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-muted" data-testid="resolve-state" data-state="resolving">
        Looking this token up…
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
  if (resolve.kind === "unknown") {
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-muted" data-testid="resolve-state" data-state="unknown">
        No token found with that address or name.
      </p>
    );
  }
  if (resolve.kind === "unavailable") {
    // NEVER "not found". We could not check — saying the token does not exist
    // would be a claim we have not earned.
    return (
      <p className="mt-2 font-mono-plex text-[12px] text-l-muted" data-testid="resolve-state" data-state="unavailable">
        {resolve.reason === "timeout"
          ? "Lookup timed out — try again."
          : "Couldn't reach the token lookup right now — try again."}
      </p>
    );
  }

  // "idle" reaches here only if the caller renders the row before a query
  // exists; nothing to say yet.
  if (resolve.kind === "idle") return null;

  const id = resolve.identity;
  const listable = resolve.kind === "listable";
  return (
    <div
      className="mt-2 rounded-[6px] border border-l-hair bg-l-surface px-3 py-2"
      data-testid="resolve-state"
      data-state={listable ? "listable" : "no-feed"}
    >
      {/* ---- Identity ---- */}
      <div className="flex items-center gap-2.5">
        {id.iconDataUri ? (
          // Always a data: URI (enforced client- and server-side). A remote URL
          // would be blocked by our img-src and render as a broken image.
          <img
            src={id.iconDataUri}
            alt=""
            width={22}
            height={22}
            className="h-[22px] w-[22px] flex-none rounded-full"
            data-testid="resolve-icon"
          />
        ) : (
          <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border border-l-hair font-mono-plex text-[9px] text-l-faint">
            {(id.symbol || "?").slice(0, 2)}
          </span>
        )}
        <span className="font-mono-plex text-[13px] font-medium text-l-text" data-testid="resolve-symbol">
          {id.symbol || "—"}
        </span>
        {id.name && id.name !== id.symbol && (
          <span className="truncate font-mono-plex text-[11.5px] text-l-muted">{id.name}</span>
        )}
        {id.verified && (
          <span
            className="ml-auto flex-none rounded-[4px] border border-l-hair px-[6px] py-[1px] font-mono-plex text-[9px] uppercase tracking-[0.12em] text-l-up-text"
            data-testid="resolve-verified"
          >
            ✓ Verified
          </span>
        )}
      </div>

      <div className="mt-1 font-mono-plex text-[10px] tabular-nums text-l-faint">
        {id.mint.slice(0, 4)}…{id.mint.slice(-4)}
        {id.origin === "chain" && " · on-chain metadata, unlisted"}
      </div>

      {/* ---- Verdict: a SEPARATE question from identity ---- */}
      <div className="mt-2 border-t border-l-hair pt-2" data-testid="feed-verdict" data-listable={listable}>
        {listable ? (
          <span className="font-mono-plex text-[11px] text-l-up-text">
            Price feed live — this can be listed.
          </span>
        ) : (
          <div>
            <span className="font-mono-plex text-[11px] text-l-muted">
              No settlement feed yet — this can't be listed.
            </span>
            {requestSlot}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * REQUEST LISTING — the only action available on a token we cannot list.
 *
 * A declined signature returns to the idle button with NOTHING red: the user
 * exercised a choice, which is not a failure. Only a server refusal or an
 * unreachable sink renders as one.
 */
const ListingRequestSlot: FC<{
  state:
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "signing" }
    | { kind: "sending" }
    | { kind: "done"; already: boolean }
    | { kind: "failed"; message: string };
  connected: boolean;
  canSign: boolean;
  onRequest: () => void;
  onConnect: () => void;
}> = ({ state, connected, canSign, onRequest, onConnect }) => {
  if (state.kind === "checking") {
    return <div className="mt-2 font-mono-plex text-[10.5px] text-l-faint">Checking…</div>;
  }
  if (state.kind === "done") {
    return (
      <div
        className="mt-2 font-mono-plex text-[10.5px] text-l-up-text"
        data-testid="listing-recorded"
        data-already={state.already}
      >
        ✓ {state.already ? "Already requested" : "Request recorded"} — we track demand for new listings.
      </div>
    );
  }
  const busy = state.kind === "signing" || state.kind === "sending";
  return (
    <div className="mt-2">
      <button
        type="button"
        data-testid="request-listing"
        disabled={busy || (connected && !canSign)}
        onClick={connected ? onRequest : onConnect}
        className="rounded-[5px] border border-l-hair px-[10px] py-[4px] font-mono-plex text-[10px] uppercase tracking-[0.12em] text-l-text transition-colors hover:bg-l-bg disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Confirm in wallet…" : connected ? "Request listing" : "Connect wallet to request"}
      </button>
      {connected && !canSign && (
        <span className="ml-2 font-mono-plex text-[10px] text-l-muted">
          This wallet can't sign messages.
        </span>
      )}
      {state.kind === "failed" && (
        <span className="ml-2 font-mono-plex text-[10px] text-l-down" data-testid="listing-failed">
          {state.message}
        </span>
      )}
    </div>
  );
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

// -----------------------------------------------------------------------------
// SuccessMoment — two honest variants, decided by how the market is priced.
//
// A market is registered the instant create lands, but it is not WRITABLE until
// its VolOracle PDA exists. Which of those two states you are in depends on the
// oracle source, and until now the modal said the same thing either way:
// "Not tradeable until the first option is written" — true, and silent about the
// wait that actually blocks you.
//
//   Switchboard-sourced → the curated feeds all have oracles already, so the
//     market is writable NOW. Say so.
//   Pyth-sourced (every non-curated asset) → the oracle is seeded reactively by
//     the crank. Measured 114 s end-to-end on 2026-08-11. So: say ~2 minutes,
//     then POLL and flip the copy the moment it lands — the user should watch it
//     go green, not be told to come back and reload.
// -----------------------------------------------------------------------------
const SuccessMoment: FC<{
  sig: string;
  assetName: string;
  feedIdHex: string;
  oracleSource: number;
  onClose: () => void;
}> = ({ sig, assetName, feedIdHex, oracleSource, onClose }) => {
  const { program } = useProgram();
  // SB-curated markets are born writable — their oracle predates the market.
  const [oracleReady, setOracleReady] = useState(oracleSource === 1);

  useEffect(() => {
    if (oracleReady || !program || !/^[0-9a-f]{64}$/.test(feedIdHex)) return;
    let cancelled = false;
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedIdHex, "hex")],
      program.programId,
    );
    const check = async () => {
      try {
        const info = await program.provider.connection.getAccountInfo(pda, "confirmed");
        if (!cancelled && info && info.owner.equals(program.programId)) setOracleReady(true);
      } catch {
        /* transient — the next tick retries */
      }
    };
    check();
    const id = window.setInterval(check, VOL_ORACLE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [oracleReady, program, feedIdHex]);

  return (
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

      <div data-testid="write-readiness" data-ready={oracleReady}>
        {oracleReady ? (
          <p className="font-mono-plex text-[12px] leading-[1.6] text-l-up-text">
            Registered on-chain and ready to write. It becomes tradeable once the first option is written.
          </p>
        ) : (
          <p className="font-mono-plex text-[12px] leading-[1.6] text-l-muted">
            Registered on-chain. Pricing is warming up — this takes {VOL_ORACLE_EXPECTED_WAIT}. You can
            leave this open; it updates itself.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Link
          to={`/write?asset=${encodeURIComponent(assetName)}`}
          onClick={onClose}
          data-testid="write-first-option"
          aria-disabled={!oracleReady}
          className={`inline-flex items-center justify-center rounded-[6px] px-[16px] py-[8px] font-sans text-[13px] font-medium no-underline transition-opacity ${
            oracleReady
              ? "bg-l-up text-l-on-up hover:opacity-90"
              : "border border-l-hair text-l-faint pointer-events-none opacity-50"
          }`}
        >
          {oracleReady ? "Write first option" : "Waiting for pricing…"}
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
};

export default NewMarketTerminalModal;
