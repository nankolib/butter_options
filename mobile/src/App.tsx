import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StatusBar,
  StyleSheet,
  View
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as NavigationBar from "expo-navigation-bar";
import * as SystemUI from "expo-system-ui";
import {
  Fraunces_400Regular_Italic
} from "@expo-google-fonts/fraunces";
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium
} from "@expo-google-fonts/ibm-plex-mono";
import {
  Inter_400Regular,
  Inter_500Medium
} from "@expo-google-fonts/inter";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileWalletProvider, useMobileWallet } from "@wallet-ui/react-native-web3js";
import type { PublicKey, Transaction } from "@solana/web3.js";
import { createOptaProgram } from "./solana/program";
import {
  atomicWriteCapability,
  buildAtomicWriteTx,
  buildPrimaryPurchaseTx,
  buildResalePurchaseTx
} from "./solana/transactions";
import { EXPECTED_CLUSTER, OPTA_CHAIN, RPC_ENDPOINT } from "./constants";
import { collateralRequired, estimatePremium } from "./pricing";
import type { Offering, WalletPosition, WalletWriterPosition, WriteDraft } from "./types";
import { ThemeProvider, useOptaFonts, useTheme } from "./hooks";
import {
  AppHeader,
  InfoSheet,
  TabBar,
  TickerStrip,
  Toast,
  TxSheet,
  type TerminalOffer
} from "./ui";
import { TradeScreen } from "./screens/TradeScreen";
import { WriteScreen } from "./screens/WriteScreen";
import { PortfolioScreen, type PortfolioRow } from "./screens/PortfolioScreen";
import { ScreenStatePanel } from "./screens/shared";
import { useConnectionState } from "./state/useConnectionState";
import { useEpochTenors } from "./state/useEpochTenors";
import { useMarketState } from "./state/useMarketState";
import { useToastQueue } from "./state/useToastQueue";
import { useTransactionFlow } from "./state/useTransactionFlow";
import type { AppTab, EpochTenor, TradeSelection, WriteFormState } from "./state/models";

const identity = {
  name: "Opta Seeker",
  uri: "https://opta.fyi",
  icon: "favicon.svg"
};

const OPTA_FONT_SOURCES = {
  interRegular: Inter_400Regular,
  interMedium: Inter_500Medium,
  ibmPlexMonoRegular: IBMPlexMono_400Regular,
  ibmPlexMonoMedium: IBMPlexMono_500Medium,
  frauncesItalic: Fraunces_400Regular_Italic
} as const;

const TAB_ITEMS = [
  { key: "trade", label: "Trade" },
  { key: "write", label: "Write" },
  { key: "portfolio", label: "Portfolio" }
] as const;

const INITIAL_TRADE: TradeSelection = {
  asset: "",
  expiry: 0,
  side: "call",
  quantity: 1,
  offeringId: null
};

const INITIAL_WRITE: WriteFormState = {
  asset: "",
  side: "call",
  exerciseStyle: "european",
  vaultType: "epoch",
  strike: "",
  contracts: 1,
  tenor: "weekly",
  customExpiry: ""
};

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <MobileWalletProvider chain={OPTA_CHAIN} endpoint={RPC_ENDPOINT} identity={identity}>
          <OptaSeekerApp />
        </MobileWalletProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function OptaSeekerApp() {
  const wallet = useMobileWallet();
  const { theme, mode, hydrated: themeHydrated } = useTheme();
  const { loaded: fontsLoaded, error: fontError } = useOptaFonts(OPTA_FONT_SOURCES);
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<AppTab>("trade");
  const [infoOpen, setInfoOpen] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [trade, setTrade] = useState<TradeSelection>(INITIAL_TRADE);
  const [write, setWrite] = useState<WriteFormState>(INITIAL_WRITE);
  const toasts = useToastQueue();
  const connection = useConnectionState(wallet);
  const owner = connection.account?.address ?? null;
  const ownerRef = useRef<PublicKey | null>(owner);
  ownerRef.current = owner;
  const market = useMarketState(wallet.connection, owner);
  const epoch = useEpochTenors(wallet.connection);
  const topInset = Math.max(theme.space.m, insets.top);
  const bottomInset = Math.max(theme.layout.gestureInset, insets.bottom);

  useEffect(() => {
    if (!fontError) return;
    console.error("Required Opta fonts failed to load.", fontError);
    toasts.show({
      tone: "error",
      title: "Typography fallback active",
      message: "Restart the app to retry the bundled fonts."
    });
  }, [fontError, toasts.show]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    try {
      NavigationBar.setStyle(mode);
    } catch {
      // The native resource theme remains the safe fallback.
    }
    void Promise.all([
      SystemUI.setBackgroundColorAsync(theme.colors.bg),
      NavigationBar.setButtonStyleAsync(mode === "dark" ? "light" : "dark")
    ]).catch(() => {
      // System bars fall back to the checked-in day/night Android resources.
    });
  }, [mode, theme.colors.bg]);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const signTransaction = useCallback(async (transaction: Transaction) => {
    return wallet.signTransaction(transaction);
  }, [wallet]);

  const transaction = useTransactionFlow({
    connection: wallet.connection,
    signTransaction,
    onConfirmed: market.refresh,
    showToast: toasts.show
  });

  const marketAssets = useMemo(() => {
    const names = new Set<string>();
    for (const record of market.snapshot?.markets ?? []) {
      const name = record.account.assetName;
      if (typeof name === "string" && name) names.add(name);
    }
    for (const name of market.snapshot?.assets ?? []) {
      if (name) names.add(name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [market.snapshot]);

  useEffect(() => {
    if (marketAssets.length === 0 || marketAssets.includes(trade.asset)) return;
    setTrade((current) => ({
      ...current,
      asset: marketAssets[0],
      expiry: 0,
      offeringId: null
    }));
  }, [marketAssets, trade.asset]);

  useEffect(() => {
    if (marketAssets.length === 0 || marketAssets.includes(write.asset)) return;
    setWrite((current) => ({ ...current, asset: trade.asset || marketAssets[0] }));
  }, [marketAssets, trade.asset, write.asset]);

  const tradeExpiries = useMemo(
    () => market.snapshot?.expiriesByAsset[trade.asset] ?? [],
    [market.snapshot, trade.asset]
  );

  useEffect(() => {
    if (tradeExpiries.length === 0) {
      if (trade.expiry !== 0) setTrade((current) => ({ ...current, expiry: 0, offeringId: null }));
      return;
    }
    if (!tradeExpiries.includes(trade.expiry)) {
      setTrade((current) => ({ ...current, expiry: tradeExpiries[0], offeringId: null }));
    }
  }, [trade.expiry, tradeExpiries]);

  const visibleOfferings = useMemo(() => (
    market.snapshot?.offerings.filter((offering) =>
      offering.asset === trade.asset
      && offering.expiry === trade.expiry
      && offering.side === trade.side
    ) ?? []
  ), [market.snapshot, trade.asset, trade.expiry, trade.side]);

  useEffect(() => {
    const selectedStillVisible = visibleOfferings.some((offering) => offering.id === trade.offeringId);
    const nextId = selectedStillVisible ? trade.offeringId : visibleOfferings[0]?.id ?? null;
    if (nextId !== trade.offeringId) {
      setTrade((current) => ({ ...current, offeringId: nextId }));
    }
  }, [trade.offeringId, visibleOfferings]);

  const selectedOffering = useMemo(
    () => visibleOfferings.find((offering) => offering.id === trade.offeringId) ?? null,
    [trade.offeringId, visibleOfferings]
  );
  const maxTradeQuantity = Math.max(1, selectedOffering?.quantityAvailable ?? 1);

  useEffect(() => {
    if (trade.quantity <= maxTradeQuantity) return;
    setTrade((current) => ({ ...current, quantity: maxTradeQuantity }));
  }, [maxTradeQuantity, trade.quantity]);

  useEffect(() => {
    if (epoch.candidates.length === 0) return;
    if (!epoch.candidates.some((candidate) => candidate.tenor === write.tenor)) {
      setWrite((current) => ({ ...current, tenor: epoch.candidates[0].tenor }));
    }
  }, [epoch.candidates, write.tenor]);

  // American writing stays hidden until the mobile client can present a fresh
  // protocol quote and use the canonical series/WriterAsk rail end-to-end.
  const americanWriteSupported = false;

  useEffect(() => {
    if (write.exerciseStyle === "american" && !americanWriteSupported) {
      setWrite((current) => ({ ...current, exerciseStyle: "european" }));
    }
  }, [americanWriteSupported, write.exerciseStyle]);

  const selectedWriteMarket = useMemo(
    () => market.snapshot?.markets.find((record) => record.account.assetName === write.asset) ?? null,
    [market.snapshot, write.asset]
  );
  const selectedTenor = epoch.candidates.find((candidate) => candidate.tenor === write.tenor) ?? null;
  const parsedCustomExpiry = parseCustomExpiry(write.customExpiry);
  const selectedWriteExpiry = write.vaultType === "epoch" ? selectedTenor?.expiry ?? null : parsedCustomExpiry;
  const writeStrike = Number.parseFloat(write.strike);
  const writeSpot = market.snapshot?.spotByAsset[write.asset] ?? null;
  const writePriceLive = market.pricePhaseFor(write.asset) === "live";
  const writePremium = write.exerciseStyle === "european" && writePriceLive
    ? estimatePremium({
        asset: write.asset,
        side: write.side,
        spot: writeSpot,
        strike: writeStrike,
        expiry: selectedWriteExpiry ?? 0
      })
    : null;
  const writeCollateral = Number.isFinite(writeStrike)
    ? collateralRequired(writeStrike, write.contracts)
    : 0;
  const writeStrikeError = write.strike.length > 0 && (!Number.isFinite(writeStrike) || writeStrike <= 0)
    ? "Enter a valid strike"
    : null;

  const customExpiryError = write.vaultType === "custom" && write.customExpiry.length > 0
    ? parsedCustomExpiry == null
      ? "Use YYYY-MM-DD HH:mm in UTC"
      : parsedCustomExpiry <= Math.floor(Date.now() / 1_000) + 300
        ? "Choose a time at least five minutes ahead"
        : null
    : null;
  const expiryReady = write.vaultType === "epoch"
    ? !!selectedTenor
    : parsedCustomExpiry != null && !customExpiryError;
  const provisionalWriteDraft: WriteDraft | null = selectedWriteMarket && selectedWriteExpiry && expiryReady && writeStrike > 0
    ? {
        market: selectedWriteMarket,
        side: write.side,
        exerciseStyle: write.exerciseStyle,
        strike: writeStrike,
        expiry: selectedWriteExpiry,
        contracts: write.contracts,
        premiumPerContract: writePremium ?? 0,
        collateral: writeCollateral,
        vaultType: write.vaultType
      }
    : null;
  const writeCapability = provisionalWriteDraft
    ? atomicWriteCapability(provisionalWriteDraft)
    : { supported: false as const, reason: "Complete the write form." };
  const writeReady = !!provisionalWriteDraft
    && writeCapability.supported
    && market.phase === "loaded"
    && (write.vaultType === "custom" || epoch.phase === "loaded")
    && writePriceLive
    && (write.exerciseStyle === "american" || (writePremium != null && writePremium > 0))
    && writeCollateral > 0;

  const connectWallet = useCallback(async () => {
    const account = await connection.connect();
    if (!account) {
      toasts.show({ tone: "error", title: "Connection declined", message: "No wallet action was taken." });
    }
    return account;
  }, [connection, toasts]);

  const handleWalletPress = useCallback(async () => {
    if (connection.phase === "connected") {
      try {
        await connection.disconnect();
      } catch {
        toasts.show({ tone: "error", title: "Couldn't disconnect", message: "Try again from your wallet." });
      }
      return;
    }
    await connectWallet();
  }, [connectWallet, connection, toasts]);

  const openBuyReview = useCallback(() => {
    const buyer = ownerRef.current;
    if (!buyer || !selectedOffering) return;
    const quantity = Math.min(trade.quantity, selectedOffering.quantityAvailable);
    const total = selectedOffering.premium * quantity;
    transaction.openReview({
      kind: "buy",
      contractCount: quantity,
      title: `Buy ${quantity} \u00d7 ${contractLabel(selectedOffering)}`,
      submitLabel: `Buy ${quantity} ${quantity === 1 ? "contract" : "contracts"}`,
      confirmedMessage: `${quantity} ${quantity === 1 ? "contract" : "contracts"} submitted.`,
      rows: [
        { label: "CONTRACT", value: contractLabel(selectedOffering) },
        { label: "PREMIUM / CONTRACT", value: `${fixed(selectedOffering.premium, 4)} USDC` },
        { label: "TOTAL", value: `${fixed(total, 4)} USDC` },
        { label: "EXPIRY", value: expiryLabel(selectedOffering.expiry) }
      ],
      build: async () => {
        const active = ownerRef.current;
        if (!active || !active.equals(buyer)) throw new Error("Wallet changed. Review the transaction again.");
        const program = createOptaProgram(wallet.connection);
        return selectedOffering.kind === "vault"
          ? buildPrimaryPurchaseTx({
              program,
              connection: wallet.connection,
              buyer,
              offering: selectedOffering,
              quantity
            })
          : buildResalePurchaseTx({
              program,
              connection: wallet.connection,
              buyer,
              offering: selectedOffering,
              quantity
            });
      }
    });
  }, [selectedOffering, trade.quantity, transaction, wallet.connection]);

  const openWriteReview = useCallback(() => {
    const writer = ownerRef.current;
    if (!writer || !provisionalWriteDraft || !writeReady) return;
    const draft = provisionalWriteDraft;
    transaction.openReview({
      kind: "write",
      contractCount: draft.contracts,
      title: `Write ${draft.contracts} \u00d7 ${contractLabelFromDraft(draft)}`,
      submitLabel: `Write ${draft.contracts} ${draft.contracts === 1 ? "contract" : "contracts"}`,
      confirmedMessage: `Position minted. ${fixed(draft.collateral, 2)} USDC collateral locked.`,
      rows: [
        { label: "CONTRACT", value: contractLabelFromDraft(draft) },
        { label: "COLLATERAL", value: `${fixed(draft.collateral, 2)} USDC` },
        draft.exerciseStyle === "american"
          ? { label: "PREMIUM", value: "Calculated at approval" }
          : { label: "EST. PREMIUM", value: `${fixed(draft.premiumPerContract * draft.contracts, 4)} USDC` },
        { label: "EXPIRY", value: expiryLabel(draft.expiry) }
      ],
      build: async () => {
        const active = ownerRef.current;
        if (!active || !active.equals(writer)) throw new Error("Wallet changed. Review the transaction again.");
        return buildAtomicWriteTx({
          program: createOptaProgram(wallet.connection),
          connection: wallet.connection,
          writer,
          draft
        });
      }
    });
  }, [provisionalWriteDraft, transaction, wallet.connection, writeReady]);

  const tradeOffers = useMemo<TerminalOffer[]>(() => visibleOfferings.map((offering) => ({
    id: offering.id,
    strike: fixed(offering.strike, 2),
    premium: fixed(offering.premium, 4),
    size: String(offering.quantityAvailable),
    premiumTone: offering.side === "call" ? "up" : "down"
  })), [visibleOfferings]);

  const holdingRows = useMemo<PortfolioRow[]>(() => market.positions.map((position) => {
    const base = holdingRow(position);
    if (position.state === "metaUnavailable") {
      return {
        ...base,
        state: "metaUnavailable" as const,
        onRetryMetadata: () => {
          void market.retryPosition(position).catch(() => {
            toasts.show({ tone: "error", title: "Metadata still unavailable", message: "No wallet action was taken." });
          });
        }
      };
    }
    return { ...base, state: position.state } as PortfolioRow;
  }), [market, toasts]);

  const writtenRows = useMemo<PortfolioRow[]>(() => market.writtenPositions.map((position) => {
    const base = writtenRow(position);
    if (position.state === "metaUnavailable") {
      return {
        ...base,
        state: "metaUnavailable" as const,
        onRetryMetadata: () => { void market.refresh(); }
      };
    }
    return { ...base, state: position.state } as PortfolioRow;
  }), [market]);

  const tickerQuotes = useMemo(() => {
    const ordered = [trade.asset, ...marketAssets.filter((asset) => asset !== trade.asset)];
    return ordered.slice(0, 4).filter(Boolean).map((asset) => ({
      symbol: asset,
      price: formatSpot(market.snapshot?.spotByAsset[asset]),
      changePct: market.priceChangeFor(asset),
      state: market.pricePhaseFor(asset)
    }));
  }, [market, marketAssets, trade.asset]);

  const copySignature = useCallback(async (signature: string) => {
    try {
      await Clipboard.setStringAsync(signature);
      toasts.show({ tone: "success", title: "Signature copied" });
    } catch {
      toasts.show({ tone: "error", title: "Couldn't copy signature" });
    }
  }, [toasts]);

  const openExplorer = useCallback(async (signature: string) => {
    try {
      await Linking.openURL(`https://solscan.io/tx/${encodeURIComponent(signature)}?cluster=devnet`);
    } catch {
      toasts.show({ tone: "error", title: "Couldn't open Explorer", message: "The signature remains available to copy." });
    }
  }, [toasts]);

  const txSignature = transaction.state.signature;
  const toastSignature = toasts.toast?.signature ?? null;
  const closeTransactionSheet = () => {
    if (transaction.state.phase === "review" || transaction.state.phase === "simulating") transaction.cancel();
    else transaction.close();
  };

  if (!themeHydrated || (!fontsLoaded && !fontError)) {
    return <View style={[styles.root, { backgroundColor: theme.colors.bg }]} />;
  }

  if (!transaction.hydrated) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
        <StatusBar
          backgroundColor={theme.colors.bg}
          barStyle={mode === "dark" ? "light-content" : "dark-content"}
        />
        <ScreenStatePanel
          tone={transaction.hydrationError ? "error" : "default"}
          title={transaction.hydrationError ? "Couldn't restore transaction status." : "Restoring transaction status\u2026"}
          message={transaction.hydrationError ?? "Checking for a previously submitted signature."}
          actionLabel={transaction.hydrationError ? "Retry" : undefined}
          onAction={transaction.hydrationError ? () => { void transaction.retryHydration(); } : undefined}
        />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={[styles.root, { backgroundColor: theme.colors.bg }]}
    >
      <StatusBar
        backgroundColor={theme.colors.bg}
        barStyle={mode === "dark" ? "light-content" : "dark-content"}
      />
      <AppHeader
        clusterLabel={EXPECTED_CLUSTER.toUpperCase()}
        connectedAddress={owner?.toBase58() ?? null}
        connectionState={connection.phase}
        onInfoPress={() => setInfoOpen(true)}
        onWalletPress={() => { void handleWalletPress(); }}
        topInset={topInset}
      />
      <TickerStrip quotes={tickerQuotes} loading={market.phase === "loading"} />

      <View style={styles.screen}>
        {tab === "trade" && (
          <TradeScreen
            assets={marketAssets.map((asset) => ({ value: asset, label: asset }))}
            selectedAsset={trade.asset}
            onSelectAsset={(asset) => setTrade((current) => ({ ...current, asset, expiry: 0, offeringId: null }))}
            expiries={tradeExpiries.map((expiry) => ({ value: String(expiry), label: shortExpiry(expiry) }))}
            selectedExpiry={trade.expiry ? String(trade.expiry) : ""}
            onSelectExpiry={(expiry) => setTrade((current) => ({ ...current, expiry: Number(expiry), offeringId: null }))}
            side={trade.side}
            onSelectSide={(side) => setTrade((current) => ({ ...current, side, offeringId: null }))}
            offers={tradeOffers}
            selectedOfferId={trade.offeringId}
            onSelectOffer={(offeringId) => {
              const next = visibleOfferings.find((offering) => offering.id === offeringId);
              setTrade((current) => ({
                ...current,
                offeringId,
                quantity: Math.min(current.quantity, Math.max(1, next?.quantityAvailable ?? 1))
              }));
            }}
            quantity={trade.quantity}
            maxQuantity={maxTradeQuantity}
            onQuantityChange={(quantity) => setTrade((current) => ({ ...current, quantity }))}
            dataPhase={market.phase}
            connectionPhase={connection.phase}
            onConnect={() => { void connectWallet(); }}
            onRetry={() => { void market.refresh(); }}
            onWriteOne={() => {
              const tradeSpot = market.snapshot?.spotByAsset[trade.asset];
              setWrite((current) => ({
                ...current,
                asset: trade.asset || current.asset,
                strike: current.strike || (tradeSpot ? fixed(tradeSpot, 2) : "")
              }));
              setTab("write");
            }}
            onReview={transaction.hasUnresolved ? transaction.reopenPending : openBuyReview}
            transactionPending={transaction.hasUnresolved}
            refreshing={market.refreshing}
          />
        )}

        {tab === "write" && (
          <WriteScreen
            assets={marketAssets.map((asset) => ({ value: asset, label: asset }))}
            selectedAsset={write.asset}
            onSelectAsset={(asset) => setWrite((current) => ({ ...current, asset }))}
            side={write.side}
            onSelectSide={(side) => setWrite((current) => ({ ...current, side }))}
            exerciseStyle={write.exerciseStyle}
            americanSupported={americanWriteSupported}
            onSelectExerciseStyle={(exerciseStyle) => setWrite((current) => ({ ...current, exerciseStyle }))}
            vaultType={write.vaultType}
            onSelectVaultType={(vaultType) => setWrite((current) => ({ ...current, vaultType }))}
            strike={write.strike}
            strikeError={writeStrikeError}
            onStrikeChange={(strike) => setWrite((current) => ({ ...current, strike }))}
            contracts={write.contracts}
            onContractsChange={(contracts) => setWrite((current) => ({ ...current, contracts }))}
            tenors={epoch.candidates.map((candidate) => ({
              value: candidate.tenor,
              label: `${tenorName(candidate.tenor)} \u00b7 ${shortExpiry(candidate.expiry)}`,
              expiry: candidate.expiry
            }))}
            selectedTenor={write.tenor}
            onSelectTenor={(tenor: EpochTenor) => setWrite((current) => ({ ...current, tenor }))}
            customExpiry={write.customExpiry}
            customExpiryError={customExpiryError}
            onCustomExpiryChange={(customExpiry) => setWrite((current) => ({ ...current, customExpiry }))}
            tenorPhase={epoch.phase}
            onRetryTenors={() => { void epoch.reload(); }}
            premiumPerContract={writePremium}
            protocolQuoteFresh={false}
            collateral={writeCollateral}
            expiry={selectedWriteExpiry}
            ready={writeReady}
            dataPhase={market.phase}
            connectionPhase={connection.phase}
            onConnect={() => { void connectWallet(); }}
            onRetryData={() => { void market.refresh(); }}
            onReview={transaction.hasUnresolved ? transaction.reopenPending : openWriteReview}
            transactionPending={transaction.hasUnresolved}
            refreshing={market.refreshing}
          />
        )}

        {tab === "portfolio" && (
          <PortfolioScreen
            holdings={holdingRows}
            written={writtenRows}
            dataPhase={market.portfolioPhase}
            connectionPhase={connection.phase}
            onConnect={() => { void connectWallet(); }}
            onRetry={() => { void market.refresh(); }}
            refreshing={market.refreshing}
          />
        )}
      </View>

      {!keyboardVisible && (
        <TabBar
          activeKey={tab}
          bottomInset={bottomInset}
          items={TAB_ITEMS}
          onChange={(key) => setTab(key as AppTab)}
        />
      )}

      <Toast
        key={toasts.toast?.id ?? 0}
        visible={!!toasts.toast}
        tone={toasts.toast?.tone ?? "info"}
        title={toasts.toast?.title ?? ""}
        message={toasts.toast?.message}
        signature={toastSignature}
        onDismiss={toasts.dismiss}
        onCopySignature={toastSignature ? () => { void copySignature(toastSignature); } : undefined}
        onOpenExplorer={toastSignature ? () => { void openExplorer(toastSignature); } : undefined}
        bottomInset={bottomInset}
      />

      <InfoSheet
        visible={infoOpen}
        onClose={() => setInfoOpen(false)}
        bottomInset={bottomInset}
        versionLabel={"Seeker v0.1.0 \u00b7 devnet"}
        onThemeError={() => {
          toasts.show({ tone: "error", title: "Couldn't save theme", message: "The current theme remains active." });
        }}
      />

      <TxSheet
        visible={transaction.visible && transaction.hydrated}
        kind={transaction.state.intent?.kind ?? "buy"}
        phase={transaction.state.phase}
        contractCount={transaction.state.intent?.contractCount ?? 1}
        title={transaction.state.intent?.title}
        summary={transaction.state.intent?.rows ?? []}
        signature={txSignature}
        error={transaction.state.error}
        bottomInset={bottomInset}
        onApprove={transaction.state.phase === "review" ? () => { void transaction.submit(); } : undefined}
        onClose={closeTransactionSheet}
        onRetry={transaction.retryAvailable ? transaction.retry : undefined}
        onCheckStatus={transaction.state.phase === "unknown" ? () => { void transaction.checkStatus(); } : undefined}
        onCopySignature={txSignature ? () => { void copySignature(txSignature); } : undefined}
        onOpenExplorer={txSignature ? () => { void openExplorer(txSignature); } : undefined}
      />
    </KeyboardAvoidingView>
  );
}

function contractLabel(offering: Offering): string {
  return `${offering.asset} ${fixed(offering.strike, 2)} ${offering.side === "call" ? "C" : "P"}`;
}

function contractLabelFromDraft(draft: WriteDraft): string {
  return `${String(draft.market.account.assetName)} ${fixed(draft.strike, 2)} ${draft.side === "call" ? "C" : "P"}`;
}

function fixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "\u2014";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatSpot(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "\u2014";
  return fixed(value, value >= 1_000 ? 0 : 2);
}

function shortExpiry(expiry: number): string {
  return new Date(expiry * 1_000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC"
  });
}

function expiryLabel(expiry: number): string {
  const time = new Date(expiry * 1_000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  });
  return `${shortExpiry(expiry)} \u00b7 ${time} UTC`;
}

function tenorName(tenor: EpochTenor): string {
  return tenor.slice(0, 1).toUpperCase() + tenor.slice(1);
}

function parseCustomExpiry(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute) {
    return null;
  }
  return Math.floor(date.getTime() / 1_000);
}

function holdingRow(position: WalletPosition): Omit<PortfolioRow, "state" | "onRetryMetadata"> {
  const totalMark = position.currentMark == null ? null : position.currentMark * position.balance;
  return {
    id: position.id,
    title: position.state === "metaUnavailable"
      ? `${position.mint.toBase58().slice(0, 6)}\u2026${position.mint.toBase58().slice(-4)}`
      : `${position.asset} ${fixed(position.strike, 2)} ${position.side === "call" ? "C" : "P"}`,
    subtitle: position.state === "metaUnavailable"
      ? position.metadataError || "Couldn't load metadata"
      : `${position.exerciseStyle === "american" ? "American" : "European"} \u00b7 ${shortExpiry(position.expiry)}`,
    quantity: `${position.balance} \u00d7 long`,
    value: totalMark == null ? "\u2014" : fixed(totalMark, 4),
    valueCaption: totalMark == null ? "mark unavailable" : "est. mark"
  };
}

function writtenRow(position: WalletWriterPosition): Omit<PortfolioRow, "state" | "onRetryMetadata"> {
  return {
    id: position.id,
    title: position.state === "metaUnavailable"
      ? `${position.position.toBase58().slice(0, 6)}\u2026${position.position.toBase58().slice(-4)}`
      : `${position.asset} ${fixed(position.strike, 2)} ${position.side === "call" ? "C" : "P"}`,
    subtitle: position.state === "metaUnavailable"
      ? position.metadataError || "Couldn't load metadata"
      : `Collateral ${fixed(position.collateralDeposited, 2)} USDC`,
    quantity: `${position.optionsMinted} \u00d7 short`,
    value: `recv ${fixed(position.premiumClaimed, 4)}`,
    valueCaption: `${position.optionsSold} sold`
  };
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { flex: 1, minHeight: 0 }
});
