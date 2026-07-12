import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { TerminalButton } from "../ui/TerminalButton";
import { SkeletonRows } from "../ui/Skeleton";
import type { AppTheme } from "../theme";

export function SectionLabel({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function ScreenStatePanel({
  title,
  message,
  actionLabel,
  onAction,
  tone = "default",
  busy = false,
  busyLabel = "Refreshing\u2026",
  style
}: {
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: "default" | "error";
  busy?: boolean;
  busyLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={[styles.state, style]}>
      <View style={styles.stateTitleRow}>
        {tone === "error" && <View style={styles.errorDot} />}
        <Text accessibilityRole={tone === "error" ? "alert" : undefined} style={styles.stateTitle}>{title}</Text>
      </View>
      {message && <Text style={styles.stateMessage}>{message}</Text>}
      {actionLabel && (onAction || busy) && (
        <TerminalButton
          compact
          label={actionLabel}
          onPress={onAction}
          busy={busy}
          busyLabel={busyLabel}
          style={styles.stateAction}
        />
      )}
    </View>
  );
}

export function LoadingRows({ count = 7, kind = "offer" }: { count?: number; kind?: "offer" | "position" }) {
  return <SkeletonRows count={count} kind={kind} />;
}

export function ScreenFooter({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return <View style={styles.footer}>{children}</View>;
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    sectionLabel: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.label,
      textTransform: "uppercase"
    },
    state: {
      flex: 1,
      minHeight: 180,
      paddingHorizontal: theme.layout.horizontalPadding,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.space.s
    },
    stateTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s },
    errorDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: theme.colors.down },
    stateTitle: {
      color: theme.colors.text,
      fontFamily: theme.type.face.uiMedium,
      fontSize: theme.type.sizes.body,
      textAlign: "center"
    },
    stateMessage: {
      maxWidth: 300,
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.label,
      lineHeight: 18,
      textAlign: "center"
    },
    stateAction: { minWidth: 96, marginTop: theme.space.xs },
    footer: {
      flexShrink: 0,
      paddingHorizontal: theme.layout.horizontalPadding,
      paddingTop: theme.space.s,
      paddingBottom: theme.space.s,
      gap: theme.space.s,
      borderTopColor: theme.colors.hairline,
      borderTopWidth: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.bg
    }
  });
}
