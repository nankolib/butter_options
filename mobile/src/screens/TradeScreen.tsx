import { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { AssetChips, ExpiryChips, SegControl } from "../ui/Controls";
import { OfferList, type TerminalOffer } from "../ui/OfferList";
import { QtyStepper } from "../ui/Controls";
import { TerminalButton } from "../ui/TerminalButton";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";
import type { ConnectionPhase, DataPhase } from "../state/models";
import { LoadingRows, ScreenFooter, ScreenStatePanel } from "./shared";

export type TradeAssetItem = { value: string; label: string };
export type TradeExpiryItem = { value: string; label: string };

export type TradeScreenProps = {
  assets: readonly TradeAssetItem[];
  selectedAsset: string;
  onSelectAsset: (asset: string) => void;
  expiries: readonly TradeExpiryItem[];
  selectedExpiry: string;
  onSelectExpiry: (expiry: string) => void;
  side: "call" | "put";
  onSelectSide: (side: "call" | "put") => void;
  offers: readonly TerminalOffer[];
  selectedOfferId: string | null;
  onSelectOffer: (id: string) => void;
  quantity: number;
  maxQuantity: number;
  onQuantityChange: (quantity: number) => void;
  dataPhase: DataPhase;
  connectionPhase: ConnectionPhase;
  onConnect: () => void;
  onRetry: () => void;
  onWriteOne: () => void;
  onReview: () => void;
  transactionPending: boolean;
  refreshing: boolean;
};

export function TradeScreen({
  assets,
  selectedAsset,
  onSelectAsset,
  expiries,
  selectedExpiry,
  onSelectExpiry,
  side,
  onSelectSide,
  offers,
  selectedOfferId,
  onSelectOffer,
  quantity,
  maxQuantity,
  onQuantityChange,
  dataPhase,
  connectionPhase,
  onConnect,
  onRetry,
  onWriteOne,
  onReview,
  transactionPending,
  refreshing
}: TradeScreenProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const selectedExpiryLabel = expiries.find((item) => item.value === selectedExpiry)?.label ?? "this expiry";
  const emptyTitle = selectedExpiry
    ? `No offers for ${selectedAsset || "this market"} \u00b7 ${selectedExpiryLabel}.`
    : `No offers for ${selectedAsset || "this market"}.`;
  const hasOffers = offers.length > 0;
  const connected = connectionPhase === "connected";
  const connecting = connectionPhase === "connecting";
  const primaryLabel = connecting
    ? "Connecting\u2026"
    : connected
      ? `Buy ${quantity} ${quantity === 1 ? "contract" : "contracts"}`
      : "Connect";

  if (transactionPending) {
    return (
      <View style={styles.root}>
        <ScreenStatePanel
          title="Transaction status pending."
          message="Resolve the submitted signature before starting another Buy or Write."
          actionLabel="Check pending transaction"
          onAction={onReview}
        />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.controlGap}>
          <AssetChips items={assets} selected={selectedAsset} onSelect={onSelectAsset} />
          <ExpiryChips items={expiries} selected={selectedExpiry} onSelect={onSelectExpiry} />
          <View style={styles.padded}>
            <SegControl
              accessibilityLabel="Option side"
              items={[
                { value: "call", label: "Call", tone: "up" },
                { value: "put", label: "Put", tone: "down" }
              ]}
              selected={side}
              onChange={(value) => onSelectSide(value as "call" | "put")}
            />
          </View>
        </View>

        {dataPhase === "loading" ? (
          <LoadingRows />
        ) : dataPhase === "error" ? (
          <ScreenStatePanel
            tone="error"
            title="Couldn't load offers."
            message="Your positions are unaffected."
            actionLabel="Retry"
            onAction={onRetry}
            busy={refreshing}
          />
        ) : dataPhase === "empty" ? (
          <ScreenStatePanel
            title="No markets are available."
            message="Try again after markets are registered."
            actionLabel="Retry"
            onAction={onRetry}
            busy={refreshing}
          />
        ) : !hasOffers ? (
          <ScreenStatePanel
            title={emptyTitle}
            actionLabel="Write one"
            onAction={onWriteOne}
          />
        ) : (
          <OfferList
            offers={offers}
            selectedId={selectedOfferId}
            onSelect={(offer) => onSelectOffer(offer.id)}
          />
        )}
      </ScrollView>

      {hasOffers && dataPhase !== "error" && (
        <ScreenFooter>
          <QtyStepper
            value={quantity}
            min={1}
            max={Math.max(1, maxQuantity)}
            onChange={onQuantityChange}
          />
          <TerminalButton
            tone="primary"
            mono
            label={primaryLabel}
            busy={connecting}
            busyLabel={"Connecting\u2026"}
            disabled={connected && !selectedOfferId}
            onPress={connected ? onReview : onConnect}
          />
        </ScreenFooter>
      )}
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.colors.bg },
    scrollContent: { flexGrow: 1, paddingTop: theme.space.s },
    controlGap: { gap: theme.space.s, paddingBottom: theme.space.s },
    padded: { paddingHorizontal: theme.layout.horizontalPadding }
  });
}
