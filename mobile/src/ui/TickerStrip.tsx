import { useEffect, useMemo, useRef } from "react";
import { Animated, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type PriceState = "live" | "stale";

export type TickerQuote = {
  symbol: string;
  price: string;
  changePct?: number | null;
  state?: PriceState;
};

export type TickerStripProps = {
  quotes: readonly TickerQuote[];
  loading?: boolean;
};

function QuoteCell({ quote }: { quote: TickerQuote }) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const flash = useRef(new Animated.Value(0)).current;
  const previousPrice = useRef(quote.price);

  useEffect(() => {
    if (previousPrice.current !== quote.price && quote.changePct != null) {
      flash.setValue(1);
      Animated.timing(flash, {
        toValue: 0,
        duration: theme.motion.flash,
        useNativeDriver: true
      }).start();
      previousPrice.current = quote.price;
    } else {
      previousPrice.current = quote.price;
    }
  }, [flash, quote.changePct, quote.price, theme.motion.flash]);

  const changeTone = quote.changePct == null
    ? styles.muted
    : quote.changePct >= 0
      ? styles.up
      : styles.down;
  const flashTone = quote.changePct != null && quote.changePct < 0 ? styles.flashDown : styles.flashUp;

  return (
    <View style={styles.quote}>
      <Animated.View pointerEvents="none" style={[styles.flash, flashTone, { opacity: flash }]} />
      <Text style={styles.symbol}>{quote.symbol}</Text>
      <Text style={styles.price}>{quote.price}</Text>
      {quote.changePct != null && (
        <Text style={[styles.change, changeTone]}>
          {quote.changePct >= 0 ? "+" : ""}{quote.changePct.toFixed(1)}%
        </Text>
      )}
      {quote.state === "stale" && <Text style={styles.stale}>STALE</Text>}
    </View>
  );
}

export function TickerStrip({ quotes, loading = false }: TickerStripProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View accessibilityRole="summary" style={styles.root}>
      {loading ? (
        <View accessibilityLabel="Loading prices" style={styles.loadingTrack}>
          <View style={styles.loadingBarWide} />
          <View style={styles.loadingBar} />
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          {quotes.map((quote) => <QuoteCell key={quote.symbol} quote={quote} />)}
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      height: theme.layout.tickerHeight,
      backgroundColor: theme.colors.bg,
      borderBottomColor: theme.colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth,
      justifyContent: "center"
    },
    row: {
      minWidth: "100%",
      alignItems: "center",
      paddingHorizontal: theme.layout.horizontalPadding,
      gap: theme.space.xl
    },
    quote: {
      position: "relative",
      flexDirection: "row",
      alignItems: "baseline",
      gap: theme.space.xs,
      overflow: "hidden"
    },
    flash: { ...StyleSheet.absoluteFillObject },
    flashUp: { backgroundColor: theme.colors.up },
    flashDown: { backgroundColor: theme.colors.down },
    symbol: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.eyebrow
    },
    price: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant
    },
    change: {
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.eyebrow,
      fontVariant: theme.type.numericVariant
    },
    up: { color: theme.colors.upTextSmall },
    down: { color: theme.colors.down },
    muted: { color: theme.colors.text3 },
    stale: {
      color: theme.colors.text2,
      borderColor: theme.colors.text3,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: theme.radius.control,
      paddingHorizontal: theme.space.xs,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.eyebrow
    },
    loadingTrack: {
      flexDirection: "row",
      paddingHorizontal: theme.layout.horizontalPadding,
      gap: theme.space.l
    },
    loadingBarWide: {
      width: 108,
      height: theme.space.s,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.surface2
    },
    loadingBar: {
      width: 72,
      height: theme.space.s,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.surface2
    }
  });
}
