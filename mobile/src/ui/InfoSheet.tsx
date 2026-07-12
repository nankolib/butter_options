import { useMemo } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme, ThemeMode } from "../theme";
import { SegControl } from "./Controls";

export type InfoSheetProps = {
  visible: boolean;
  onClose: () => void;
  bottomInset?: number;
  versionLabel?: string;
  legalCopy?: string;
  onThemeError?: (error: unknown) => void;
};

const infoCards = [
  ["Devnet", "All markets settle in devnet USDC. Nothing here has real value."],
  ["Collateral", "Writers lock full collateral at mint. No liquidation, no margin calls."],
  ["Settlement", "European options settle after expiry once a valid settlement price is recorded."],
  ["Exercise", "American options may be exercised before expiry; this mobile build is read-only for position actions."]
] as const;

export function InfoSheet({
  visible,
  onClose,
  bottomInset = 0,
  versionLabel,
  legalCopy,
  onThemeError
}: InfoSheetProps) {
  const { theme, mode, setMode } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const safeBottom = Math.max(bottomInset, theme.space.l);
  const changeMode = (value: string) => {
    void setMode(value as ThemeMode).catch((error) => onThemeError?.(error));
  };
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close information" onPress={onClose} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={[styles.sheet, { paddingBottom: safeBottom }]}>
          <View style={styles.handle} />
          <View style={styles.titleRow}>
            <Text accessibilityRole="header" style={styles.title}>Info</Text>
            {versionLabel && <Text style={styles.version}>{versionLabel}</Text>}
          </View>
          <SegControl
            accessibilityLabel="Color theme"
            items={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" }
            ]}
            selected={mode}
            onChange={changeMode}
          />
          <Text style={styles.helper}>Follows device until changed. Persists.</Text>

          <ScrollView bounces={false} contentContainerStyle={styles.cards}>
            {infoCards.map(([title, body]) => (
              <View key={title} style={styles.card}>
                <Text style={styles.cardTitle}>{title}</Text>
                <Text style={styles.cardBody}>{body}</Text>
              </View>
            ))}
            {legalCopy && <Text style={styles.legal}>{legalCopy}</Text>}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: theme.colors.overlay },
    sheet: {
      maxHeight: "76%",
      paddingHorizontal: theme.layout.horizontalPadding,
      paddingTop: theme.space.s,
      backgroundColor: theme.colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.hairline,
      borderTopLeftRadius: theme.radius.sheetTop,
      borderTopRightRadius: theme.radius.sheetTop
    },
    handle: {
      width: 32,
      height: 2,
      alignSelf: "center",
      backgroundColor: theme.colors.text3,
      marginBottom: theme.space.l
    },
    titleRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: theme.space.m
    },
    title: {
      color: theme.colors.text,
      fontFamily: theme.type.face.uiMedium,
      fontSize: theme.type.sizes.emphasis
    },
    version: {
      color: theme.colors.text3,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.eyebrow,
      fontVariant: theme.type.numericVariant
    },
    helper: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.label,
      marginTop: theme.space.s
    },
    cards: { gap: theme.space.s, paddingTop: theme.space.m },
    card: {
      gap: theme.space.xs,
      padding: theme.space.m,
      borderColor: theme.colors.hairline,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: theme.radius.panel,
      backgroundColor: theme.colors.surface2
    },
    cardTitle: {
      color: theme.colors.text,
      fontFamily: theme.type.face.uiMedium,
      fontSize: theme.type.sizes.body
    },
    cardBody: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.body,
      lineHeight: theme.type.lineHeights.body
    },
    legal: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.label,
      lineHeight: theme.type.lineHeights.label
    }
  });
}
