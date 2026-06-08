// =============================================================================
// useOptionPriceQuote.ts — React wrapper for the on-chain get_option_price view.
// =============================================================================
//
// Thin, lazy, debounced hook around utils/optionPriceQuote.fetchOptionPriceQuote
// (the single shared fetch built in Phase 3). Used by the Write LiveQuoteCard
// and the Trade BuyModal so neither re-implements the effect/debounce/error
// plumbing — the util stays the one source of the actual .view() call.
//
// Lazy + single-strike by design: pass `enabled = false` (or a null market /
// params) to skip the fetch entirely. Consumers gate `enabled` on "is this an
// American cell AND is the surface open", so the chain never fires a quote per
// cell on render (no eager whole-chain). Debounced so typing a strike doesn't
// spam .view().
//
// `.view()` needs a wallet-backed provider (it reads wallet.publicKey for the
// fee payer) but does NOT prompt the wallet (empty signers) — see
// utils/optionPriceQuote.ts. Disconnected → useProgram's read-only provider →
// the fetch throws → surfaced as an "unknown" failure; gate `enabled` on
// connection where a disconnected miss would be confusing.
// =============================================================================

import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { useProgram } from "./useProgram";
import {
  fetchOptionPriceQuote,
  OptionPriceQuoteFailure,
  type OptionPriceQuote,
  type OptionPriceQuoteParams,
} from "../utils/optionPriceQuote";

type MarketLike = {
  publicKey: PublicKey;
  account: { pythFeedId: number[] | Uint8Array };
} | null;

export type OptionPriceQuoteState = {
  quote: OptionPriceQuote | null;
  error: OptionPriceQuoteFailure | null;
  loading: boolean;
};

const IDLE: OptionPriceQuoteState = { quote: null, error: null, loading: false };

export function useOptionPriceQuote(
  enabled: boolean,
  market: MarketLike,
  params: OptionPriceQuoteParams | null,
  debounceMs = 350,
): OptionPriceQuoteState {
  const { program } = useProgram();
  const [state, setState] = useState<OptionPriceQuoteState>(IDLE);

  // Stable string key over all inputs that affect the quote. Re-fetch only
  // when one of these actually changes (object identity churn is ignored).
  const key =
    enabled && market && params
      ? [
          market.publicKey.toBase58(),
          params.strike,
          params.expiryTs,
          params.side,
          params.exerciseStyle,
          params.carryRateBps,
        ].join("|")
      : "";

  useEffect(() => {
    if (!key || !program || !market || !params) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const id = setTimeout(async () => {
      try {
        const quote = await fetchOptionPriceQuote(program, market, params);
        if (!cancelled) setState({ quote, error: null, loading: false });
      } catch (e) {
        if (!cancelled) {
          setState({
            quote: null,
            error:
              e instanceof OptionPriceQuoteFailure
                ? e
                : new OptionPriceQuoteFailure("unknown", null),
            loading: false,
          });
        }
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // params/market are captured fresh whenever `key` changes (key encodes all
    // their quote-affecting fields); identity-only changes are intentionally
    // ignored to avoid refetch storms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, program]);

  return state;
}
