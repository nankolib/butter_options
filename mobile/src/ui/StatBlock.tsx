import { useMemo } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type StatTone = "default" | "up" | "down" | "muted";

export type StatBlockProps = {
  label: string;
  value: string;
  caption?: string;
  tone?: StatTone;
  centerpiece?: boolean;
  align?: "left" | "right" | "center";
  style?: StyleProp<ViewStyle>;
};

export function StatBlock({
  label,
  value,
  caption,
  tone = "default",
  centerpiece = false,
  align = "left",
  style
}: StatBlockProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const toneStyle = tone === "up"
    ? styles.up
    : tone === "down"
      ? styles.down
      : tone === "muted"
        ? styles.muted
        : styles.default;
  const textAlign = align === "right" ? styles.right : align === "center" ? styles.center : styles.left;
  return (
    <View style={[styles.root, style]}>
      <Text style={[styles.label, textAlign]}>{label}</Text>
      <Text
        adjustsFontSizeToFit={centerpiece}
        numberOfLines={1}
        style={[styles.value, centerpiece && styles.centerpiece, toneStyle, textAlign]}
      >
        {value}
      </Text>
      {caption && <Text style={[styles.caption, textAlign]}>{caption}</Text>}
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { gap: theme.space.xs },
    label: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.label,
      textTransform: "uppercase"
    },
    value: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant
    },
    centerpiece: { fontSize: theme.type.sizes.centerpiece },
    caption: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.label,
      fontVariant: theme.type.numericVariant
    },
    default: { color: theme.colors.text },
    up: { color: theme.colors.upTextSmall },
    down: { color: theme.colors.down },
    muted: { color: theme.colors.text3 },
    left: { textAlign: "left" },
    right: { textAlign: "right" },
    center: { textAlign: "center" }
  });
}
