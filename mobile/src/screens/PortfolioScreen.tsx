import { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { PositionRow, type PositionState } from "../ui/PositionRow";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";
import type { ConnectionPhase, DataPhase } from "../state/models";
import { LoadingRows, ScreenStatePanel, SectionLabel } from "./shared";

type PortfolioRowBase = {
  id: string;
  title: string;
  subtitle: string;
  quantity: string;
  value: string;
  valueCaption?: string;
};

export type PortfolioRow = PortfolioRowBase & (
  | { state: "metaUnavailable"; onRetryMetadata: () => void }
  | { state: Exclude<PositionState, "metaUnavailable">; onRetryMetadata?: never }
);

export type PortfolioScreenProps = {
  holdings: readonly PortfolioRow[];
  written?: readonly PortfolioRow[];
  dataPhase: DataPhase;
  connectionPhase: ConnectionPhase;
  onConnect: () => void;
  onRetry: () => void;
  refreshing: boolean;
};

function LedgerRow({ row }: { row: PortfolioRow }) {
  if (row.state === "metaUnavailable") {
    return (
      <PositionRow
        id={row.id}
        title={row.title}
        subtitle={row.subtitle}
        quantity={row.quantity}
        value={row.value}
        valueCaption={row.valueCaption}
        state="metaUnavailable"
        onRetryMetadata={row.onRetryMetadata}
      />
    );
  }
  return (
    <PositionRow
      id={row.id}
      title={row.title}
      subtitle={row.subtitle}
      quantity={row.quantity}
      value={row.value}
      valueCaption={row.valueCaption}
      state={row.state}
    />
  );
}

export function PortfolioScreen({
  holdings,
  written,
  dataPhase,
  connectionPhase,
  onConnect,
  onRetry,
  refreshing
}: PortfolioScreenProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const connected = connectionPhase === "connected";

  if (!connected) {
    return (
      <View style={styles.root}>
        <ScreenStatePanel
          title="Connect to view positions."
          message="Holdings are read from your wallet."
          actionLabel={connectionPhase === "connecting" ? "Connecting\u2026" : "Connect"}
          onAction={onConnect}
          busy={connectionPhase === "connecting"}
          busyLabel="Connecting\u2026"
        />
      </View>
    );
  }

  if (dataPhase === "loading") {
    return <View style={styles.root}><LoadingRows count={5} kind="position" /></View>;
  }

  const empty = holdings.length === 0 && (!written || written.length === 0);
  if (dataPhase === "error" && empty) {
    return (
      <View style={styles.root}>
        <ScreenStatePanel
          tone="error"
          title="Couldn't load positions."
          message="No wallet action was taken."
          actionLabel="Retry"
          onAction={onRetry}
          busy={refreshing}
        />
      </View>
    );
  }

  if (empty) {
    return (
      <View style={styles.root}>
        <ScreenStatePanel
          title="No Opta positions found."
          message="Confirmed purchases and written contracts will appear here."
          actionLabel="Refresh"
          onAction={onRetry}
          busy={refreshing}
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} style={styles.root}>
      {dataPhase === "error" && (
        <View style={styles.degraded}>
          <ScreenStatePanel
            tone="error"
            title="Refresh failed."
            message="Showing the last position snapshot."
            actionLabel="Retry"
            onAction={onRetry}
            busy={refreshing}
            style={styles.degradedPanel}
          />
        </View>
      )}
      <View style={styles.label}><SectionLabel>HOLDINGS</SectionLabel></View>
      {holdings.length > 0
        ? holdings.map((row) => <LedgerRow key={row.id} row={row} />)
        : <ScreenStatePanel title="No wallet holdings." style={styles.compactEmpty} />}

      {written && (
        <>
          <View style={styles.label}><SectionLabel>WRITTEN</SectionLabel></View>
          {written.length > 0
            ? written.map((row) => <LedgerRow key={row.id} row={row} />)
            : <ScreenStatePanel title="No written positions." style={styles.compactEmpty} />}
        </>
      )}
    </ScrollView>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.colors.bg },
    scrollContent: { paddingBottom: theme.space.xl },
    label: {
      paddingHorizontal: theme.layout.horizontalPadding,
      paddingTop: theme.space.l,
      paddingBottom: theme.space.s,
      borderBottomColor: theme.colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth
    },
    degraded: {
      borderBottomColor: theme.colors.hairline,
      borderBottomWidth: StyleSheet.hairlineWidth
    },
    degradedPanel: { minHeight: 112 },
    compactEmpty: { minHeight: 96 }
  });
}
