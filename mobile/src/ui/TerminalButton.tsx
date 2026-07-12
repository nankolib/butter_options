import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { useMemo } from "react";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type TerminalButtonTone = "primary" | "secondary" | "danger" | "ghost";

export type TerminalButtonProps = {
  label: string;
  onPress?: () => void;
  tone?: TerminalButtonTone;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  compact?: boolean;
  mono?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function TerminalButton({
  label,
  onPress,
  tone = "secondary",
  disabled = false,
  busy = false,
  busyLabel,
  compact = false,
  mono = false,
  style,
  accessibilityLabel
}: TerminalButtonProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const isDisabled = disabled || busy || !onPress;
  const toneStyle = tone === "primary"
    ? styles.primary
    : tone === "danger"
      ? styles.danger
      : tone === "ghost"
        ? styles.ghost
        : styles.secondary;
  const textTone = tone === "primary"
    ? styles.primaryText
    : tone === "danger"
      ? styles.dangerText
      : styles.secondaryText;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        compact ? styles.compact : styles.standard,
        toneStyle,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style
      ]}
    >
      <Text numberOfLines={1} style={[styles.label, mono && styles.monoLabel, textTone, isDisabled && styles.disabledText]}>
        {busy ? busyLabel ?? label : label}
      </Text>
    </Pressable>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    base: {
      minHeight: theme.hit.min,
      borderRadius: theme.radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.space.m
    },
    standard: { height: theme.layout.primaryButtonHeight },
    compact: { height: theme.layout.controlHeight },
    primary: { backgroundColor: theme.colors.up, borderColor: theme.colors.up },
    secondary: { backgroundColor: theme.colors.surface, borderColor: theme.colors.hairline },
    danger: { backgroundColor: theme.colors.down, borderColor: theme.colors.down },
    ghost: { backgroundColor: theme.colors.transparent, borderColor: theme.colors.hairline },
    pressed: { opacity: 0.86, transform: [{ scale: 0.99 }] },
    disabled: { backgroundColor: theme.colors.surface, borderColor: theme.colors.hairline },
    label: {
      fontFamily: theme.type.face.uiMedium,
      fontSize: theme.type.sizes.body,
      fontWeight: theme.type.weights.medium
    },
    monoLabel: {
      fontFamily: theme.type.face.monoMedium,
      fontVariant: theme.type.numericVariant
    },
    primaryText: { color: theme.colors.onUp },
    dangerText: { color: theme.colors.onDown },
    secondaryText: { color: theme.colors.text },
    disabledText: { color: theme.colors.text3 }
  });
}
