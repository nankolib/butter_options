import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { Connection, PublicKey } from "@solana/web3.js";
import {
  loadMarketSnapshot,
  loadWalletPortfolio,
  refetchPositionMetadata
} from "../solana/marketData";
import type { MarketSnapshot, WalletPosition, WalletWriterPosition } from "../types";
import type { DataPhase, PricePhase } from "./models";
import { sanitizeUserVisibleText } from "./displaySafety";

const PRICE_STALE_AFTER_MS = 90_000;
const AUTO_REFRESH_MS = 60_000;
const CLOCK_TICK_MS = 15_000;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return sanitizeUserVisibleText(error.message);
  return sanitizeUserVisibleText(String(error || "Unknown data error"));
}

export function useMarketState(connection: Connection, owner: PublicKey | null) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const snapshotRef = useRef<MarketSnapshot | null>(null);
  const [positions, setPositions] = useState<WalletPosition[]>([]);
  const [writtenPositions, setWrittenPositions] = useState<WalletWriterPosition[]>([]);
  const [phase, setPhase] = useState<DataPhase>("loading");
  const [portfolioPhase, setPortfolioPhase] = useState<DataPhase>(owner ? "loading" : "empty");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [priceChanges, setPriceChanges] = useState<Record<string, number>>({});
  const [clock, setClock] = useState(Date.now());
  const requestId = useRef(0);
  const backgroundRefreshInFlight = useRef(false);

  const fetchAll = useCallback(async (background = false) => {
    if (background && backgroundRefreshInFlight.current) return;
    if (background) {
      backgroundRefreshInFlight.current = true;
      setRefreshing(true);
    } else if (!snapshotRef.current) {
      setPhase("loading");
    }
    const currentRequest = ++requestId.current;
    setError(null);

    try {
      const nextSnapshot = await loadMarketSnapshot(connection);
      if (currentRequest !== requestId.current) return;

      const previous = snapshotRef.current;
      const nextChanges: Record<string, number> = {};
      if (previous) {
        for (const [asset, nextPrice] of Object.entries(nextSnapshot.spotByAsset)) {
          const priorPrice = previous.spotByAsset[asset];
          if (priorPrice > 0 && Number.isFinite(nextPrice)) {
            nextChanges[asset] = ((nextPrice - priorPrice) / priorPrice) * 100;
          }
        }
      }
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setPriceChanges(nextChanges);
      setClock(Date.now());
      const hasData = nextSnapshot.markets.length > 0 || nextSnapshot.offerings.length > 0;
      setPhase(hasData ? "loaded" : "empty");

      if (!owner) {
        setPositions([]);
        setWrittenPositions([]);
        setPositionError(null);
        setPortfolioPhase("empty");
        return;
      }

      if (!background) setPortfolioPhase("loading");
      try {
        const portfolio = await loadWalletPortfolio(connection, owner, nextSnapshot);
        if (currentRequest !== requestId.current) return;
        setPositions(portfolio.holdings);
        setWrittenPositions(portfolio.written);
        setPositionError(null);
        setPortfolioPhase(portfolio.holdings.length > 0 || portfolio.written.length > 0 ? "loaded" : "empty");
      } catch (portfolioError) {
        if (currentRequest !== requestId.current) return;
        setPositionError(errorText(portfolioError));
        setPortfolioPhase("error");
      }
    } catch (nextError) {
      if (currentRequest !== requestId.current) return;
      setError(errorText(nextError));
      setPhase("error");
      if (owner && !snapshotRef.current) {
        setPositionError("Position data is unavailable until markets reconnect.");
        setPortfolioPhase("error");
      }
    } finally {
      if (background) backgroundRefreshInFlight.current = false;
      if (currentRequest === requestId.current) setRefreshing(false);
    }
  }, [connection, owner]);

  useEffect(() => {
    if (!owner) {
      setPositions([]);
      setWrittenPositions([]);
      setPortfolioPhase("empty");
    } else {
      setPortfolioPhase("loading");
    }
    void fetchAll(false);
    return () => {
      requestId.current += 1;
    };
  }, [connection, fetchAll, owner]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    const refreshTimer = setInterval(() => { void fetchAll(true); }, AUTO_REFRESH_MS);
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") void fetchAll(true);
    });
    return () => {
      clearInterval(timer);
      clearInterval(refreshTimer);
      subscription.remove();
    };
  }, [fetchAll]);

  const refresh = useCallback(() => fetchAll(true), [fetchAll]);

  const pricePhaseFor = useCallback((asset: string): PricePhase => {
    if (!snapshot || !asset || snapshot.spotByAsset[asset] == null) return "stale";
    if (snapshot.spotStatusByAsset[asset] === "stale") return "stale";
    return clock - snapshot.fetchedAt > PRICE_STALE_AFTER_MS ? "stale" : "live";
  }, [clock, snapshot]);

  const priceChangeFor = useCallback((asset: string): number | null => (
    Number.isFinite(priceChanges[asset]) ? priceChanges[asset] : null
  ), [priceChanges]);

  const retryPosition = useCallback(async (position: WalletPosition) => {
    setPositionError(null);
    try {
      const refreshed = await refetchPositionMetadata(connection, position, snapshot ?? undefined);
      setPositions((current) => current.map((item) => item.id === position.id ? refreshed : item));
    } catch (nextError) {
      setPositionError(errorText(nextError));
      throw nextError;
    }
  }, [connection, snapshot]);

  return {
    snapshot,
    positions,
    writtenPositions,
    phase,
    portfolioPhase,
    refreshing,
    error,
    positionError,
    refresh,
    pricePhaseFor,
    priceChangeFor,
    retryPosition
  };
}
