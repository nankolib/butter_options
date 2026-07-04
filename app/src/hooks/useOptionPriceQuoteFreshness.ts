// =============================================================================
// useOptionPriceQuoteFreshness.ts — reactive quote + shared freshness verdict.
// =============================================================================
//
// Thin wrapper over useOptionPriceQuote that adds the H-05 freshness verdict
// (utils/optionPriceQuote.quoteFreshness). The Write gate (WriterForm via its
// sections) and the Trade BuyModal gate both consume this so "fresh enough to
// trade on" has ONE definition. OrderTicket keeps its button-triggered RFQ
// state but derives freshness from the same pure quoteFreshness() helper, so
// every American surface shares the same rule.
// =============================================================================

import type { PublicKey } from "@solana/web3.js";
import { useOptionPriceQuote, type OptionPriceQuoteState } from "./useOptionPriceQuote";
import { quoteFreshness, type QuoteFreshness } from "../utils/optionPriceQuote";
import type { OptionPriceQuoteParams } from "../utils/optionPriceQuote";

type MarketLike = {
  publicKey: PublicKey;
  account: { pythFeedId: number[] | Uint8Array };
} | null;

export type OptionPriceQuoteFreshnessState = OptionPriceQuoteState & QuoteFreshness;

export function useOptionPriceQuoteFreshness(
  enabled: boolean,
  market: MarketLike,
  params: OptionPriceQuoteParams | null,
  debounceMs = 350,
): OptionPriceQuoteFreshnessState {
  const state = useOptionPriceQuote(enabled, market, params, debounceMs);
  const fresh = quoteFreshness(state.loading, state.error, state.quote);
  return { ...state, ...fresh };
}
