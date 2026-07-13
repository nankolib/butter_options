import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type ConnectState = "disconnected" | "connecting" | "connected" | "rejected";

export type AppHeaderProps = {
  connectionState: ConnectState;
  connectedAddress?: string | null;
  onWalletPress?: () => void;
  onInfoPress: () => void;
  topInset?: number;
  clusterLabel?: string;
};

function walletLabel(state: ConnectState, address?: string | null) {
  if (state === "connecting") return "Connecting…";
  if (state === "rejected") return "Connection declined";
  if (state === "connected" && address) {
    return address.length > 10 ? `• ${address.slice(0, 4)}…${address.slice(-4)}` : `• ${address}`;
  }
  return "Connect";
}

export function AppHeader({
  connectionState,
  connectedAddress,
  onWalletPress,
  onInfoPress,
  topInset = 0,
  clusterLabel = "DEVNET"
}: AppHeaderProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const walletDisabled = connectionState === "connecting" || !onWalletPress;
  const label = walletLabel(connectionState, connectedAddress);

  return (
    <View style={[styles.root, { height: theme.layout.headerHeight + topInset, paddingTop: topInset }]}>
      <View style={styles.brandRow}>
        <Text accessibilityRole="header" style={styles.logo}>opta.</Text>
        <View accessibilityLabel={`${clusterLabel} cluster`} style={styles.badge}>
          <Text style={styles.badgeText}>{clusterLabel}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open information"
          hitSlop={theme.space.s}
          onPress={onInfoPress}
          style={({ pressed }) => [styles.info, pressed && styles.pressed]}
        >
          <Text style={styles.infoText}>i</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled: walletDisabled, busy: connectionState === "connecting" }}
          disabled={walletDisabled}
          onPress={onWalletPress}
          style={({ pressed }) => [
            styles.wallet,
            walletDisabled && styles.walletDisabled,
            pressed && !walletDisabled && styles.pressed
          ]}
        >
          <Text numberOfLines={1} style={[styles.walletText, walletDisabled && styles.disabledText]}>{label}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      backgroundColor: theme.colors.bg,
      borderBottomColor: theme.colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: theme.layout.horizontalPadding,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between"
    },
    brandRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s },
    logo: {
      color: theme.colors.text,
      fontFamily: theme.type.face.logoItalic,
      fontSize: theme.type.sizes.emphasis,
      fontStyle: "italic"
    },
    badge: {
      minHeight: 22,
      justifyContent: "center",
      borderRadius: theme.radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.text3,
      paddingHorizontal: theme.space.s
    },
    badgeText: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.eyebrow,
      fontVariant: theme.type.numericVariant
    },
    actions: { flexDirection: "row", alignItems: "center", gap: theme.space.s },
    info: {
      width: theme.hit.min,
      height: theme.hit.min,
      alignItems: "center",
      justifyContent: "center"
    },
    infoText: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.label
    },
    wallet: {
      maxWidth: 154,
      minWidth: 88,
      minHeight: theme.hit.min,
      paddingHorizontal: theme.space.m,
      justifyContent: "center",
      alignItems: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.hairline,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.surface
    },
    walletDisabled: { backgroundColor: theme.colors.surface },
    walletText: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.label,
      fontVariant: theme.type.numericVariant
    },
    disabledText: { color: theme.colors.text3 },
    pressed: { opacity: 0.82 }
  });
}
