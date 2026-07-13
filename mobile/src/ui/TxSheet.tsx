import { useMemo } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";
import { TerminalButton } from "./TerminalButton";

export type TxKind = "buy" | "write";
export type TxPhase =
  | "idle"
  | "review"
  | "building"
  | "simulating"
  | "awaitingWallet"
  | "sending"
  | "confirming"
  | "confirmed"
  | "failed"
  | "unknown"
  | "checking";

export type TxSummaryRow = {
  label: string;
  value: string;
  tone?: "default" | "up" | "down" | "muted";
};

export type TxSheetProps = {
  visible: boolean;
  kind: TxKind;
  phase: TxPhase;
  contractCount: number;
  title?: string;
  summary: readonly TxSummaryRow[];
  signature?: string | null;
  error?: string | null;
  bottomInset?: number;
  onApprove?: () => void;
  onClose?: () => void;
  onRetry?: () => void;
  onCheckStatus?: () => void;
  onCopySignature?: () => void;
  onOpenExplorer?: () => void;
};

const phaseLabel: Record<TxPhase, string> = {
  idle: "REVIEW",
  review: "REVIEW",
  building: "REVIEW",
  simulating: "SIMULATING",
  awaitingWallet: "APPROVE IN WALLET",
  sending: "APPROVE IN WALLET",
  confirming: "CONFIRMING",
  confirmed: "CONFIRMED",
  failed: "FAILED",
  unknown: "STATUS UNKNOWN",
  checking: "STATUS UNKNOWN"
};

function isLocked(phase: TxPhase) {
  return phase === "awaitingWallet"
    || phase === "sending"
    || phase === "confirming"
    || phase === "checking";
}

export function TxSheet({
  visible,
  kind,
  phase,
  contractCount,
  title,
  summary,
  signature,
  error,
  bottomInset = 0,
  onApprove,
  onClose,
  onRetry,
  onCheckStatus,
  onCopySignature,
  onOpenExplorer
}: TxSheetProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const locked = isLocked(phase);
  const review = phase === "idle" || phase === "review";
  const approvingLabel = `${kind === "buy" ? "Buy" : "Write"} ${contractCount} ${contractCount === 1 ? "contract" : "contracts"}`;
  const busyLabel = phase === "building"
    ? "Building…"
    : phase === "simulating"
      ? "Simulating…"
      : phase === "awaitingWallet"
        ? "Approve in wallet"
        : phase === "sending"
          ? "Sending…"
          : phase === "confirming"
            ? "Confirming…"
            : "Checking…";
  const showBusy = phase === "building"
    || phase === "simulating"
    || phase === "awaitingWallet"
    || phase === "sending"
    || phase === "confirming"
    || phase === "checking";
  const terminal = phase === "confirmed" || phase === "failed";
  const safeBottom = Math.max(bottomInset, theme.space.l);

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!locked) onClose?.();
      }}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.backdrop}>
        <Pressable
          accessibilityLabel="Close transaction sheet"
          disabled={locked || !onClose}
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View accessibilityViewIsModal style={[styles.sheet, { paddingBottom: safeBottom }]}>
          <View style={styles.handle} />
          <View style={styles.headingRow}>
            <View style={styles.stepDot} />
            <Text style={styles.step}>{phaseLabel[phase]}</Text>
          </View>
          <Text numberOfLines={2} style={styles.title}>{title ?? approvingLabel}</Text>

          <ScrollView bounces={false} contentContainerStyle={styles.summary}>
            {summary.map((row, index) => {
              const tone = row.tone === "up"
                ? styles.up
                : row.tone === "down"
                  ? styles.down
                  : row.tone === "muted"
                    ? styles.muted
                    : styles.default;
              return (
                <View key={`${row.label}-${index}`} style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{row.label}</Text>
                  <Text selectable style={[styles.summaryValue, tone]}>{row.value}</Text>
                </View>
              );
            })}

            {signature && (
              <View style={styles.signatureBlock}>
                <Text style={styles.summaryLabel}>SIGNATURE</Text>
                <Text numberOfLines={1} selectable style={styles.signature}>{signature}</Text>
                {(onCopySignature || onOpenExplorer) && (
                  <View style={styles.signatureActions}>
                    {onCopySignature && <TerminalButton compact label="Copy" onPress={onCopySignature} tone="ghost" />}
                    {onOpenExplorer && <TerminalButton compact label="Explorer" onPress={onOpenExplorer} tone="ghost" />}
                  </View>
                )}
              </View>
            )}

            {phase === "failed" && (
              <View style={styles.messageBlock}>
                <Text accessibilityRole="alert" selectable style={styles.error}>
                  {error || "Transaction failed."}
                </Text>
                {kind === "write" && <Text style={styles.message}>Nothing was deposited.</Text>}
              </View>
            )}
            {phase === "unknown" && (
              <Text style={styles.message}>
                {kind === "write"
                  ? "Timed out before confirmation. The transaction may have landed."
                  : "Timed out before confirmation. The order may have landed."}
              </Text>
            )}
            {phase === "checking" && (
              <Text style={styles.message}>Checking the submitted signature. This does not send a transaction.</Text>
            )}
            {(phase === "unknown" || phase === "checking") && (
              <Text style={styles.message}>
                {kind === "write"
                  ? "Checking never re-deposits."
                  : "Checking never re-sends the order."}
              </Text>
            )}
          </ScrollView>

          <View style={styles.actions}>
            {!terminal && phase !== "unknown" && phase !== "checking" && (
              <TerminalButton
                compact
                disabled={locked}
                label="Cancel"
                onPress={!locked ? onClose : undefined}
                tone="ghost"
                style={styles.action}
              />
            )}
            {review && (
              <TerminalButton
                label={approvingLabel}
                mono
                onPress={onApprove}
                tone="primary"
                style={styles.primaryAction}
              />
            )}
            {showBusy && phase !== "checking" && (
              <TerminalButton
                busy
                busyLabel={busyLabel}
                label={busyLabel}
                tone="primary"
                style={styles.primaryAction}
              />
            )}
            {phase === "unknown" && (
              <TerminalButton
                label="Check status"
                onPress={onCheckStatus}
                tone="primary"
                style={styles.primaryAction}
              />
            )}
            {phase === "checking" && (
              <TerminalButton
                busy
                busyLabel="Checking…"
                label="Checking…"
                tone="primary"
                style={styles.primaryAction}
              />
            )}
            {phase === "failed" && onRetry && (
              <TerminalButton label="Retry" onPress={onRetry} tone="primary" style={styles.primaryAction} />
            )}
            {(phase === "unknown" || phase === "checking" || terminal) && onClose && (
              <TerminalButton
                disabled={phase === "checking"}
                label="Close"
                onPress={phase === "checking" ? undefined : onClose}
                tone="secondary"
                style={styles.action}
              />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: theme.colors.overlay },
    sheet: {
      maxHeight: "82%",
      paddingHorizontal: theme.layout.horizontalPadding,
      paddingTop: theme.space.s,
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.hairline,
      borderWidth: StyleSheet.hairlineWidth,
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
    headingRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s },
    stepDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: theme.colors.dot },
    step: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.eyebrow
    },
    title: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.emphasis,
      fontVariant: theme.type.numericVariant,
      marginTop: theme.space.s
    },
    summary: { paddingVertical: theme.space.m, gap: theme.space.s },
    summaryRow: {
      minHeight: 28,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.space.l
    },
    summaryLabel: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.label
    },
    summaryValue: {
      flexShrink: 1,
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant,
      textAlign: "right"
    },
    default: { color: theme.colors.text },
    up: { color: theme.colors.upTextSmall },
    down: { color: theme.colors.down },
    muted: { color: theme.colors.text3 },
    signatureBlock: {
      gap: theme.space.s,
      padding: theme.space.m,
      borderColor: theme.colors.hairline,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: theme.radius.control,
      backgroundColor: theme.colors.bg
    },
    signature: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.label,
      fontVariant: theme.type.numericVariant
    },
    signatureActions: { flexDirection: "row", gap: theme.space.s },
    messageBlock: { gap: theme.space.xs },
    message: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.body
    },
    error: {
      color: theme.colors.down,
      fontFamily: theme.type.face.uiRegular,
      fontSize: theme.type.sizes.body
    },
    actions: { flexDirection: "row", gap: theme.space.s },
    action: { flex: 1 },
    primaryAction: { flex: 2 }
  });
}
