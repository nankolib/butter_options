import { useMemo } from "react";
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type SkeletonProps = {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

export function Skeleton({ width = "100%", height, radius, style }: SkeletonProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View
      accessibilityLabel="Loading"
      style={[
        styles.block,
        { width, height: height ?? theme.space.m, borderRadius: radius ?? theme.radius.control },
        style
      ]}
    />
  );
}

export function SkeletonRows({
  count,
  rowHeight,
  kind = "offer"
}: {
  count: number;
  rowHeight?: number;
  kind?: "offer" | "position";
}) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const height = rowHeight ?? (kind === "position" ? theme.layout.positionRowHeight : theme.layout.offerRowHeight);
  return (
    <View accessibilityLabel="Loading rows">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={[styles.row, { height }]}>
          <Skeleton width="28%" height={theme.space.s} />
          <Skeleton width="24%" height={theme.space.s} style={styles.rightBlock} />
          <Skeleton width="12%" height={theme.space.s} />
        </View>
      ))}
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    block: { backgroundColor: theme.colors.surface2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.space.s,
      paddingHorizontal: theme.layout.horizontalPadding,
      borderBottomColor: theme.colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth
    },
    rightBlock: { marginLeft: "auto" }
  });
}
