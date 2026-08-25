import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { AssetChips, ExpiryChips, MonoInput, QtyStepper, SegControl } from "../ui/Controls";
import { StatBlock } from "../ui/StatBlock";
import { Skeleton } from "../ui/Skeleton";
import { TerminalButton } from "../ui/TerminalButton";
import { useTheme } from "../hooks/useTheme";
import type { AppTheme } from "../theme";
import type { ConnectionPhase, DataPhase, EpochTenor } from "../state/models";
import { LoadingRows, ScreenFooter, ScreenStatePanel } from "./shared";
import { errorPanelMessage } from "../state/errorMessage";

export type WriteAssetItem = { value: string; label: string };
export type WriteTenorItem = { value: EpochTenor; label: string; expiry: number };

export type WriteScreenProps = {
  assets: readonly WriteAssetItem[];
  selectedAsset: string;
  onSelectAsset: (asset: string) => void;
  side: "call" | "put";
  onSelectSide: (side: "call" | "put") => void;
  exerciseStyle: "european" | "american";
  americanSupported: boolean;
  onSelectExerciseStyle: (style: "european" | "american") => void;
  vaultType: "epoch" | "custom";
  onSelectVaultType: (vaultType: "epoch" | "custom") => void;
  strike: string;
  strikeError?: string | null;
  onStrikeChange: (strike: string) => void;
  contracts: number;
  onContractsChange: (contracts: number) => void;
  tenors: readonly WriteTenorItem[];
  selectedTenor: EpochTenor;
  onSelectTenor: (tenor: EpochTenor) => void;
  customExpiry: string;
  customExpiryError?: string | null;
  onCustomExpiryChange: (expiry: string) => void;
  tenorPhase: DataPhase;
  onRetryTenors: () => void;
  premiumPerContract: number | null;
  protocolQuoteFresh: boolean;
  collateral: number;
  expiry: number | null;
  ready: boolean;
  dataPhase: DataPhase;
  dataError?: string | null;
  connectionPhase: ConnectionPhase;
  onConnect: () => void;
  onRetryData: () => void;
  onReview: () => void;
  transactionPending: boolean;
  refreshing: boolean;
};

function decimal(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "\u2014";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function expiryCaption(expiry: number | null): string {
  if (!expiry) return "Expiry unavailable";
  return new Date(expiry * 1_000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).replace(",", " \u00b7") + " UTC";
}

export function WriteScreen({
  assets,
  selectedAsset,
  onSelectAsset,
  side,
  onSelectSide,
  exerciseStyle,
  americanSupported,
  onSelectExerciseStyle,
  vaultType,
  onSelectVaultType,
  strike,
  strikeError,
  onStrikeChange,
  contracts,
  onContractsChange,
  tenors,
  selectedTenor,
  onSelectTenor,
  customExpiry,
  customExpiryError,
  onCustomExpiryChange,
  tenorPhase,
  onRetryTenors,
  premiumPerContract,
  protocolQuoteFresh,
  collateral,
  expiry,
  ready,
  dataPhase,
  dataError,
  connectionPhase,
  onConnect,
  onRetryData,
  onReview,
  transactionPending,
  refreshing
}: WriteScreenProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const connected = connectionPhase === "connected";
  const connecting = connectionPhase === "connecting";
  const premiumTotal = premiumPerContract == null ? null : premiumPerContract * contracts;
  const premiumLabel = exerciseStyle === "american"
    ? protocolQuoteFresh && premiumPerContract != null ? "PROTOCOL QUOTE" : "PREMIUM AT APPROVAL"
    : "EST. PREMIUM";
  const primaryLabel = connecting
    ? "Connecting\u2026"
    : connected
      ? `Write ${contracts} ${contracts === 1 ? "contract" : "contracts"}`
      : "Connect";

  if (transactionPending) {
    return (
      <View style={styles.root}>
        <ScreenStatePanel
          title="Transaction status pending."
          message="Resolve the submitted signature before starting another Buy or Write."
          actionLabel="Check pending transaction"
          onAction={onReview}
        />
      </View>
    );
  }

  if (dataPhase === "loading") {
    return <View style={styles.root}><LoadingRows count={6} /></View>;
  }
  if (dataPhase === "error") {
    return (
      <View style={styles.root}>
        <ScreenStatePanel
          tone="error"
          title="Couldn't load markets."
          message={errorPanelMessage(dataError, "Your positions are unaffected.")}
          actionLabel="Retry"
          onAction={onRetryData}
          busy={refreshing}
        />
      </View>
    );
  }
  if (dataPhase === "empty" || assets.length === 0) {
    return (
      <View style={styles.root}>
        <ScreenStatePanel
          title="No markets are available."
          message="Try again after markets are registered."
          actionLabel="Retry"
          onAction={onRetryData}
          busy={refreshing}
        />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.sectionGap}>
          <AssetChips items={assets} selected={selectedAsset} onSelect={onSelectAsset} />
          <View style={styles.padded}>
            <SegControl
              accessibilityLabel="Option side"
              items={[
                { value: "call", label: "Call", tone: "up" },
                { value: "put", label: "Put", tone: "down" }
              ]}
              selected={side}
              onChange={(value) => onSelectSide(value as "call" | "put")}
            />
          </View>
          {americanSupported && (
            <View style={styles.padded}>
              <SegControl
                accessibilityLabel="Exercise style"
                items={[{ value: "european", label: "European" }, { value: "american", label: "American" }]}
                selected={exerciseStyle}
                onChange={(value) => onSelectExerciseStyle(value as "european" | "american")}
              />
            </View>
          )}
          <View style={[styles.padded, styles.formGap]}>
            <MonoInput
              label="Strike"
              value={strike}
              onChangeText={onStrikeChange}
              error={strikeError}
              keyboardType="decimal-pad"
              inputMode="decimal"
              returnKeyType="done"
              selectTextOnFocus
              suffix="USDC"
            />
            <View style={styles.contractsBlock}>
              <Text style={styles.fieldLabel}>CONTRACTS</Text>
              <QtyStepper value={contracts} onChange={onContractsChange} />
            </View>
          </View>

          <View style={styles.padded}>
            <SegControl
              accessibilityLabel="Vault type"
              items={[{ value: "epoch", label: "Epoch" }, { value: "custom", label: "Custom" }]}
              selected={vaultType}
              onChange={(value) => onSelectVaultType(value as "epoch" | "custom")}
            />
          </View>

          {vaultType === "custom" ? (
            <View style={styles.padded}>
              <MonoInput
                label="Custom expiry (UTC)"
                value={customExpiry}
                onChangeText={onCustomExpiryChange}
                error={customExpiryError}
                placeholder="2026-08-28 08:00"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
              />
            </View>
          ) : tenorPhase === "loading" ? (
            <View style={styles.padded}><Skeleton height={theme.layout.controlHeight} /></View>
          ) : tenorPhase === "error" ? (
            <ScreenStatePanel
              tone="error"
              title="Couldn't load valid expiries."
              message="The live schedule is required before writing."
              actionLabel="Retry"
              onAction={onRetryTenors}
            />
          ) : tenorPhase === "empty" ? (
            <ScreenStatePanel
              title="No valid expiries are available."
              message="The live schedule currently has no eligible tenor."
              actionLabel="Retry"
              onAction={onRetryTenors}
            />
          ) : (
            <ExpiryChips
              items={tenors.map((tenor) => ({ value: tenor.value, label: tenor.label, tenor: tenor.value }))}
              selected={selectedTenor}
              onSelect={(value) => onSelectTenor(value as EpochTenor)}
            />
          )}

          <View style={[styles.padded, styles.quotePanel]}>
            <StatBlock
              align="right"
              centerpiece
              label={premiumLabel}
              value={premiumTotal == null ? "\u2014" : decimal(premiumTotal)}
              caption={premiumTotal == null
                ? "Calculated during wallet approval"
                : `USDC total \u00b7 ${contracts} ${contracts === 1 ? "contract" : "contracts"} \u00b7 ${expiryCaption(expiry)}`}
            />
            <View style={styles.hairline} />
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>COLLATERAL</Text>
              <Text style={styles.summaryValue}>{decimal(collateral, 2)} USDC</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      <ScreenFooter>
        <Text style={styles.approvalCopy}>
          Deposits {decimal(collateral, 2)} USDC collateral {"\u00b7"} one approval
        </Text>
        <TerminalButton
          tone="primary"
          mono
          label={primaryLabel}
          busy={connecting}
          busyLabel={"Connecting\u2026"}
          disabled={connected && !ready}
          onPress={connected ? onReview : onConnect}
        />
      </ScreenFooter>
    </View>
  );
}

function makeStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.colors.bg },
    scrollContent: { paddingTop: theme.space.s, paddingBottom: theme.space.m },
    sectionGap: { gap: theme.space.s },
    padded: { paddingHorizontal: theme.layout.horizontalPadding },
    formGap: { gap: theme.space.s },
    contractsBlock: { gap: theme.space.xs },
    fieldLabel: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.label
    },
    quotePanel: {
      marginTop: theme.space.xs,
      paddingTop: theme.space.m,
      gap: theme.space.m,
      borderTopColor: theme.colors.hairline,
      borderTopWidth: StyleSheet.hairlineWidth
    },
    hairline: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.hairline },
    summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    summaryLabel: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.label
    },
    summaryValue: {
      color: theme.colors.text,
      fontFamily: theme.type.face.monoMedium,
      fontSize: theme.type.sizes.num,
      fontVariant: theme.type.numericVariant
    },
    approvalCopy: {
      color: theme.colors.text2,
      fontFamily: theme.type.face.monoRegular,
      fontSize: theme.type.sizes.label,
      textAlign: "center",
      fontVariant: theme.type.numericVariant
    }
  });
}
