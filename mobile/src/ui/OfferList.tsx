import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type OfferTone = "up" | "down" | "neutral";

export type TerminalOffer = {
  id: string;
  strike: string;
  premium: string;
  size: string;
  premiumTone?: OfferTone;
  disabled?: boolean;
};

export type OfferRowProps = {
  offer: TerminalOffer;
  selected?: boolean;
  onPress?: () => void;
};

export function OfferRow({ offer, selected = false, onPress }: OfferRowProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const disabled = !!offer.disabled || !onPress;
  const premiumTone = offer.premiumTone === "down"
    ? styles.down
    : offer.premiumTone === "neutral"
      ? styles.neutral
      : styles.up;
  const content: ReactNode = (
    <>
      <Text numberOfLines={1} style={[styles.cell, styles.strike, offer.disabled && styles.disabledText]}>{offer.strike}</Text>
      <Text numberOfLines={1} style={[styles.cell, styles.premium, premiumTone, offer.disabled && styles.disabledText]}>{offer.premium}</Text>
      <Text numberOfLines={1} style={[styles.cell, styles.size, offer.disabled && styles.disabledText]}>{offer.size}</Text>
    </>
  );

  if (!onPress) {
    return <View style={[styles.row, selected && styles.selected, offer.disabled && styles.disabled]}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`Strike ${offer.strike}, premium ${offer.premium}, size ${offer.size}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        selected && styles.selected,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed
      ]}
    >
      {content}
    </Pressable>
  );
}

export function OfferList({
  offers,
  selectedId,
  onSelect
}: {
  offers: readonly TerminalOffer[];
  selectedId?: string | null;
  onSelect?: (offer: TerminalOffer) => void;
}) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View accessibilityRole="radiogroup" style={styles.list}>
      <View style={styles.header}>
        <Text style={[styles.headerText, styles.strike]}>STRIKE</Text>
        <Text style={[styles.headerText, styles.premium]}>PREMIUM</Text>
        <Text style={[styles.headerText, styles.size]}>SIZE</Text>
      </View>
      {offers.map((offer) => (
        <OfferRow
          key={offer.id}
          offer={offer}
          selected={offer.id === selectedId}
          onPress={onSelect && !offer.disabled ? () => onSelect(offer) : undefined}
        />
      ))}
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    list: { borderTopColor: theme.colors.hairline, borderTopWidth: StyleSheet.hairlineWidth },
    header: {
      minHeight: 24,
      flexDirection: "row",
      alignItems: "center",
      borderBottomColor: theme.colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: theme.layout.horizontalPadding
    },
    headerText: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.eyebrow
    },
    row: {
      height: theme.layout.offerRowHeight,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: theme.layout.horizontalPadding,
      borderBottomColor: theme.colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.bg
    },
    selected: { backgroundColor: theme.colors.surface },
    disabled: { backgroundColor: theme.colors.surface },
    pressed: { backgroundColor: theme.colors.surface2 },
    cell: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant
    },
    strike: { flex: 1, textAlign: "left" },
    premium: { flex: 1, textAlign: "right" },
    size: { width: 48, textAlign: "right" },
    up: { color: theme.colors.upTextSmall },
    down: { color: theme.colors.down },
    neutral: { color: theme.colors.text },
    disabledText: { color: theme.colors.text3 }
  });
}
