import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";

export type TabItem = { key: string; label: string; disabled?: boolean };

export type TabBarProps = {
  items: readonly TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  bottomInset?: number;
};

export function TabBar({ items, activeKey, onChange, bottomInset = 0 }: TabBarProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const safeBottom = Math.max(bottomInset, theme.layout.gestureInset);
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.root, { height: theme.layout.tabBarHeight + safeBottom, paddingBottom: safeBottom }]}
    >
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: !!item.disabled }}
            disabled={item.disabled}
            onPress={() => onChange(item.key)}
            style={({ pressed }) => [styles.tab, pressed && !item.disabled && styles.pressed]}
          >
            <View style={[styles.dot, !active && styles.dotHidden]} />
            <Text style={[styles.label, active && styles.activeLabel, item.disabled && styles.disabledLabel]}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      flexDirection: "row",
      backgroundColor: theme.colors.bg,
      borderTopColor: theme.colors.hairline,
      borderTopWidth: StyleSheet.hairlineWidth
    },
    tab: {
      flex: 1,
      minHeight: theme.hit.min,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.space.xs
    },
    dot: {
      width: 3,
      height: 3,
      borderRadius: 2,
      backgroundColor: theme.colors.dot
    },
    dotHidden: { opacity: 0 },
    label: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.label
    },
    activeLabel: { color: theme.colors.text, fontFamily: theme.type.face.uiMedium },
    disabledLabel: { color: theme.colors.text3 },
    pressed: { backgroundColor: theme.colors.surface }
  });
}
