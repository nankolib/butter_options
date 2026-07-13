import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";
import { TerminalButton } from "./TerminalButton";

export type ToastTone = "success" | "info" | "error";

export type ToastProps = {
  visible: boolean;
  tone: ToastTone;
  title: string;
  message?: string;
  signature?: string | null;
  onDismiss: () => void;
  onCopySignature?: () => void;
  onOpenExplorer?: () => void;
  bottomInset?: number;
};

export function Toast({
  visible,
  tone,
  title,
  message,
  signature,
  onDismiss,
  onCopySignature,
  onOpenExplorer,
  bottomInset = 0
}: ToastProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (!visible) {
      Animated.timing(progress, {
        toValue: 0,
        duration: theme.motion.base,
        useNativeDriver: true
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
      return;
    }
    setMounted(true);
    Animated.timing(progress, {
      toValue: 1,
      duration: theme.motion.base,
      useNativeDriver: true
    }).start();
    const timer = setTimeout(onDismiss, theme.motion.toast);
    return () => clearTimeout(timer);
  }, [message, onDismiss, progress, signature, theme.motion.base, theme.motion.toast, title, tone, visible]);

  if (!mounted) return null;
  const dotTone = tone === "success" ? styles.success : tone === "error" ? styles.error : styles.info;
  const safeBottom = Math.max(bottomInset, theme.layout.gestureInset);
  return (
    <Animated.View
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === "error" ? "alert" : "text"}
      style={[
        styles.root,
        { bottom: theme.layout.tabBarHeight + safeBottom + theme.space.m },
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }]
        }
      ]}
    >
      <View style={[styles.dot, dotTone]} />
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        {message && <Text style={styles.message}>{message}</Text>}
        {signature && <Text numberOfLines={1} selectable style={styles.signature}>{signature}</Text>}
        {signature && (onCopySignature || onOpenExplorer) && (
          <View style={styles.actions}>
            {onCopySignature && <TerminalButton compact label="Copy" onPress={onCopySignature} tone="ghost" />}
            {onOpenExplorer && <TerminalButton compact label="Explorer" onPress={onOpenExplorer} tone="ghost" />}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      position: "absolute",
      left: theme.layout.horizontalPadding,
      right: theme.layout.horizontalPadding,
      zIndex: 20,
      minHeight: theme.hit.min,
      flexDirection: "row",
      gap: theme.space.s,
      padding: theme.space.m,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.hairline,
      borderRadius: theme.radius.panel,
      backgroundColor: theme.colors.surface2
    },
    dot: { width: 4, height: 4, borderRadius: 2, marginTop: theme.space.s },
    success: { backgroundColor: theme.colors.up },
    info: { backgroundColor: theme.colors.text2 },
    error: { backgroundColor: theme.colors.down },
    copy: { flex: 1, minWidth: 0, gap: theme.space.xs },
    title: {
      color: theme.colors.text,
      fontFamily: theme.type.face.uiMedium,
      fontSize: theme.type.sizes.body
    },
    message: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.label
    },
    signature: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.label,
      fontVariant: theme.type.numericVariant
    },
    actions: { flexDirection: "row", gap: theme.space.s, marginTop: theme.space.xs }
  });
}
