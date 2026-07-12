import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type PositionState = "live" | "settledITM" | "settledOTM" | "expired" | "metaUnavailable";

type PositionRowBase = {
  id: string;
  title: string;
  subtitle: string;
  quantity: string;
  value: string;
  valueCaption?: string;
};

export type PositionRowProps =
  | (PositionRowBase & { state: "metaUnavailable"; onRetryMetadata: () => void })
  | (PositionRowBase & {
      state: Exclude<PositionState, "metaUnavailable">;
      onRetryMetadata?: never;
    });

const stateLabel: Record<PositionState, string> = {
  live: "LIVE",
  settledITM: "SETTLED · ITM",
  settledOTM: "SETTLED · OTM",
  expired: "EXPIRED",
  metaUnavailable: "METADATA"
};

export function PositionRow(props: PositionRowProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const muted = props.state === "settledOTM" || props.state === "expired";
  if (props.state === "metaUnavailable") {
    return (
      <View style={styles.root}>
        <View style={styles.main}>
          <Text numberOfLines={1} style={styles.title}>{props.title}</Text>
          <Text numberOfLines={1} style={styles.metaError}>{props.subtitle}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retry metadata for ${props.title}`}
          onPress={props.onRetryMetadata}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View accessibilityLabel={`${props.title}, ${stateLabel[props.state]}`} style={styles.root}>
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.title, muted && styles.muted]}>{props.title}</Text>
          <View style={styles.badge}>
            <Text style={[styles.badgeText, muted && styles.muted]}>{stateLabel[props.state]}</Text>
          </View>
        </View>
        <Text numberOfLines={1} style={[styles.subtitle, muted && styles.muted]}>{props.subtitle}</Text>
      </View>
      <View style={styles.values}>
        <Text numberOfLines={1} style={[styles.value, muted && styles.muted]}>{props.quantity}</Text>
        <Text numberOfLines={1} style={[styles.subtitle, muted && styles.muted]}>
          {props.value}{props.valueCaption ? ` · ${props.valueCaption}` : ""}
        </Text>
      </View>
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      minHeight: theme.layout.positionRowHeight,
      paddingHorizontal: theme.layout.horizontalPadding,
      paddingVertical: theme.space.s,
      flexDirection: "row",
      alignItems: "center",
      borderBottomColor: theme.colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.bg
    },
    main: { flex: 1, minWidth: 0, gap: theme.space.xs },
    titleRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s },
    title: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant
    },
    subtitle: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.label,
      fontVariant: theme.type.numericVariant
    },
    badge: {
      borderColor: theme.colors.text3,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: theme.radius.control,
      paddingHorizontal: theme.space.xs,
      paddingVertical: theme.space.xxs
    },
    badgeText: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.eyebrow
    },
    values: { alignItems: "flex-end", gap: theme.space.xs, marginLeft: theme.space.s },
    value: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant,
      textAlign: "right"
    },
    muted: { color: theme.colors.text3 },
    metaError: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.label
    },
    retry: {
      minWidth: theme.hit.min,
      minHeight: theme.hit.min,
      alignItems: "center",
      justifyContent: "center",
      borderColor: theme.colors.hairline,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: theme.radius.control,
      paddingHorizontal: theme.space.s
    },
    retryText: {
      color: theme.colors.text,
      fontFamily: theme.type.face.uiMedium,
      fontSize: theme.type.sizes.label
    },
    pressed: { backgroundColor: theme.colors.surface }
  });
}
