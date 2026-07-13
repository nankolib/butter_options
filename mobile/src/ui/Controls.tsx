import { useMemo } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle
} from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type ChipItem = { value: string; label: string; disabled?: boolean };
export type ExpiryChipItem = ChipItem & { tenor?: string };

type ChipRowProps = {
  items: readonly ChipItem[];
  selected: string;
  onSelect: (value: string) => void;
  accessibilityLabel: string;
};

function ChipRow({ items, selected, onSelect, accessibilityLabel }: ChipRowProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <ScrollView
      accessibilityLabel={accessibilityLabel}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
    >
      {items.map((item) => {
        const active = item.value === selected;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled: !!item.disabled }}
            disabled={item.disabled}
            onPress={() => onSelect(item.value)}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              item.disabled && styles.disabledControl,
              pressed && !item.disabled && styles.pressed
            ]}
          >
            <Text style={[styles.chipText, active && styles.activeChipText, item.disabled && styles.disabledText]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function AssetChips(props: Omit<ChipRowProps, "accessibilityLabel">) {
  return <ChipRow {...props} accessibilityLabel="Assets" />;
}

export function ExpiryChips({
  items,
  selected,
  onSelect
}: {
  items: readonly ExpiryChipItem[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return <ChipRow items={items} selected={selected} onSelect={onSelect} accessibilityLabel="Expiries" />;
}

export type SegmentItem = {
  value: string;
  label: string;
  disabled?: boolean;
  tone?: "default" | "up" | "down";
};

export function SegControl({
  items,
  selected,
  onChange,
  accessibilityLabel
}: {
  items: readonly SegmentItem[];
  selected: string;
  onChange: (value: string) => void;
  accessibilityLabel: string;
}) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View accessibilityLabel={accessibilityLabel} accessibilityRole="radiogroup" style={styles.segment}>
      {items.map((item) => {
        const active = item.value === selected;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: active, disabled: !!item.disabled }}
            disabled={item.disabled}
            onPress={() => onChange(item.value)}
            style={({ pressed }) => [
              styles.segmentItem,
              active && styles.segmentActive,
              item.disabled && styles.disabledControl,
              pressed && !item.disabled && styles.pressed
            ]}
          >
            <Text style={[
              styles.segmentText,
              active && styles.activeSegmentText,
              active && item.tone === "up" && styles.upText,
              active && item.tone === "down" && styles.downText,
              item.disabled && styles.disabledText
            ]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function QtyStepper({
  value,
  onChange,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
  disabled = false,
  label = "Contracts"
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  label?: string;
}) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const canDecrease = !disabled && value > min;
  const canIncrease = !disabled && value < max;
  return (
    <View accessibilityLabel={label} style={styles.stepper}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${label}`}
        accessibilityState={{ disabled: !canDecrease }}
        disabled={!canDecrease}
        onPress={() => onChange(Math.max(min, value - 1))}
        style={({ pressed }) => [styles.stepButton, !canDecrease && styles.disabledControl, pressed && styles.pressed]}
      >
        <Text style={[styles.stepSymbol, !canDecrease && styles.disabledText]}>−</Text>
      </Pressable>
      <View accessibilityRole="text" style={styles.stepValue}>
        <Text style={styles.stepValueText}>{value}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increase ${label}`}
        accessibilityState={{ disabled: !canIncrease }}
        disabled={!canIncrease}
        onPress={() => onChange(Math.min(max, value + 1))}
        style={({ pressed }) => [styles.stepButton, !canIncrease && styles.disabledControl, pressed && styles.pressed]}
      >
        <Text style={[styles.stepSymbol, !canIncrease && styles.disabledText]}>+</Text>
      </Pressable>
    </View>
  );
}

export type MonoInputProps = Omit<TextInputProps, "onChangeText" | "value" | "style"> & {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  suffix?: string;
  error?: string | null;
  containerStyle?: StyleProp<ViewStyle>;
};

export function MonoInput({
  label,
  value,
  onChangeText,
  suffix,
  error,
  containerStyle,
  editable = true,
  ...inputProps
}: MonoInputProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={containerStyle}>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={[styles.inputShell, !!error && styles.inputError, !editable && styles.disabledControl]}>
        <TextInput
          {...inputProps}
          accessibilityLabel={inputProps.accessibilityLabel ?? label}
          editable={editable}
          value={value}
          onChangeText={onChangeText}
          placeholderTextColor={theme.colors.text3}
          selectionColor={theme.colors.upTextSmall}
          style={[styles.input, !editable && styles.disabledText]}
        />
        {suffix && <Text style={styles.suffix}>{suffix}</Text>}
      </View>
      {error && <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text>}
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    chipRow: { gap: theme.space.s, paddingHorizontal: theme.layout.horizontalPadding },
    chip: {
      height: theme.layout.controlHeight,
      minWidth: theme.hit.min,
      paddingHorizontal: theme.space.m,
      justifyContent: "center",
      alignItems: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.hairline,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.bg
    },
    chipActive: { borderColor: theme.colors.text, backgroundColor: theme.colors.surface },
    chipText: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.label,
      fontVariant: theme.type.numericVariant
    },
    activeChipText: { color: theme.colors.text, fontFamily: theme.type.face.monoMedium },
    activeSegmentText: { color: theme.colors.text, fontFamily: theme.type.face.uiMedium },
    upText: { color: theme.colors.upTextSmall },
    downText: { color: theme.colors.down },
    segment: {
      minHeight: theme.layout.controlHeight,
      flexDirection: "row",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.hairline,
      borderRadius: theme.radius.control,
      overflow: "hidden",
      backgroundColor: theme.colors.bg
    },
    segmentItem: {
      flex: 1,
      minHeight: theme.hit.min,
      alignItems: "center",
      justifyContent: "center",
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: theme.colors.hairline
    },
    segmentActive: { backgroundColor: theme.colors.surface2 },
    segmentText: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.body
    },
    disabledControl: { backgroundColor: theme.colors.surface, borderColor: theme.colors.hairline },
    disabledText: { color: theme.colors.text3 },
    pressed: { opacity: 0.84 },
    stepper: {
      height: theme.layout.controlHeight,
      flexDirection: "row",
      alignItems: "stretch",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.hairline,
      borderRadius: theme.radius.control,
      overflow: "hidden"
    },
    stepButton: {
      minWidth: theme.hit.min,
      minHeight: theme.hit.min,
      backgroundColor: theme.colors.surface,
      alignItems: "center",
      justifyContent: "center"
    },
    stepSymbol: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.emphasis
    },
    stepValue: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.hairline,
      backgroundColor: theme.colors.bg
    },
    stepValueText: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant
    },
    inputLabel: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.label,
      marginBottom: theme.space.xs,
      textTransform: "uppercase"
    },
    inputShell: {
      minHeight: theme.layout.controlHeight,
      flexDirection: "row",
      alignItems: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.hairline,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.bg
    },
    inputError: { borderColor: theme.colors.down },
    input: {
      flex: 1,
      minHeight: theme.hit.min,
      paddingHorizontal: theme.space.s,
      paddingVertical: 0,
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant,
      textAlign: "right"
    },
    suffix: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.label,
      paddingRight: theme.space.s
    },
    errorText: {
      color: theme.colors.down,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.label,
      marginTop: theme.space.xs
    }
  });
}
