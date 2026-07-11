import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { MobileWalletProvider, useMobileWallet } from "@wallet-ui/react-native-web3js";
import { PublicKey } from "@solana/web3.js";
import { createOptaProgram } from "./solana/program";
import { loadMarketSnapshot, loadWalletPositions } from "./solana/marketData";
import {
  buildPrimaryPurchaseTx,
  buildResalePurchaseTx,
  buildWriteDepositTx,
  buildWriteMintTx
} from "./solana/transactions";
import { EXPECTED_CLUSTER, OPTA_CHAIN, RPC_ENDPOINT } from "./constants";
import { colors, shadow } from "./theme";
import { countdown, money, shortAddress, shortDate } from "./format";
import { collateralRequired, estimatePremium, nextFridayUtc8 } from "./pricing";
import type { ExerciseStyle, MarketSnapshot, Offering, OptionSide, PendingTx, WalletPosition, WriteDraft } from "./types";

type Tab = "trade" | "write" | "portfolio" | "safety";
type Direction = "up" | "down";

const identity = {
  name: "Opta Seeker",
  uri: "https://opta.fi",
  icon: "favicon.png"
};

export default function App() {
  return (
    <MobileWalletProvider chain={OPTA_CHAIN} endpoint={RPC_ENDPOINT} identity={identity}>
      <OptaSeekerApp />
    </MobileWalletProvider>
  );
}

function OptaSeekerApp() {
  const wallet = useMobileWallet();
  const [tab, setTab] = useState<Tab>("trade");
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [positions, setPositions] = useState<WalletPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asset, setAsset] = useState<string>("");
  const [expiry, setExpiry] = useState<number>(0);
  const [direction, setDirection] = useState<Direction>("up");
  const [quantity, setQuantity] = useState("1");
  const [selectedOffering, setSelectedOffering] = useState<Offering | null>(null);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const [sending, setSending] = useState(false);

  const connectedAddress = wallet.account?.address?.toBase58() ?? null;

  const load = useCallback(async () => {
    setError(null);
    const next = await loadMarketSnapshot(wallet.connection);
    setSnapshot(next);
    if (!asset && next.assets.length > 0) {
      setAsset(next.assets[0]);
    }
    if (wallet.account?.address) {
      const owner = new PublicKey(wallet.account.address);
      setPositions(await loadWalletPositions(wallet.connection, owner, next));
    } else {
      setPositions([]);
    }
  }, [wallet.connection, wallet.account?.address, asset]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const expiries = useMemo(
    () => (snapshot && asset ? snapshot.expiriesByAsset[asset] ?? [] : []),
    [snapshot, asset]
  );

  useEffect(() => {
    if (expiries.length > 0 && !expiries.includes(expiry)) {
      setExpiry(expiries[0]);
    }
  }, [expiries, expiry]);

  const side = direction === "up" ? "call" : "put";
  const visibleOfferings = useMemo(() => {
    if (!snapshot || !asset || !expiry) return [];
    return snapshot.offerings.filter(
      (o) => o.asset === asset && o.expiry === expiry && o.side === side
    );
  }, [snapshot, asset, expiry, side]);

  useEffect(() => {
    setSelectedOffering((current) => {
      if (current && visibleOfferings.some((o) => o.id === current.id)) return current;
      return visibleOfferings[0] ?? null;
    });
  }, [visibleOfferings]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const beginReview = async () => {
    if (!selectedOffering || !snapshot) return;
    if (!wallet.account?.address) {
      await wallet.connect();
      return;
    }
    const qty = Math.max(1, Number.parseInt(quantity, 10) || 1);
    if (qty > selectedOffering.quantityAvailable) {
      Alert.alert("Quantity too high", `Only ${selectedOffering.quantityAvailable} contracts are available from this source.`);
      return;
    }
    const buyer = new PublicKey(wallet.account.address);
    const program = createOptaProgram(wallet.connection);
    try {
      const pending =
        selectedOffering.kind === "vault"
          ? await buildPrimaryPurchaseTx({
              program,
              connection: wallet.connection,
              buyer,
              offering: selectedOffering,
              quantity: qty
            })
          : await buildResalePurchaseTx({
              program,
              connection: wallet.connection,
              buyer,
              offering: selectedOffering,
              quantity: qty
            });
      setPendingTx(pending);
    } catch (err: any) {
      Alert.alert("Could not build transaction", err?.message ?? String(err));
    }
  };

  const beginWriteFlow = async (draft: WriteDraft) => {
    if (!wallet.account?.address) {
      await wallet.connect();
      return;
    }
    const writer = new PublicKey(wallet.account.address);
    const program = createOptaProgram(wallet.connection);
    try {
      const depositTx = await buildWriteDepositTx({
        program,
        connection: wallet.connection,
        writer,
        draft
      });
      depositTx.ctaLabel = "Sign deposit";
      depositTx.afterSignature = async () => {
        const mintTx = await buildWriteMintTx({
          program,
          connection: wallet.connection,
          writer,
          draft
        });
        mintTx.ctaLabel = "Sign mint";
        mintTx.afterSignature = async (signature) => {
          await onRefresh();
          Alert.alert("Write complete", `Option mint created.\n${signature}`);
        };
        setPendingTx(mintTx);
      };
      setPendingTx(depositTx);
    } catch (err: any) {
      Alert.alert("Could not build write transaction", err?.message ?? String(err));
    }
  };

  const signPending = async () => {
    if (!pendingTx) return;
    if (pendingTx.simulationError) {
      Alert.alert("Simulation failed", pendingTx.simulationError);
      return;
    }
    setSending(true);
    try {
      const current = pendingTx;
      const latest = await wallet.connection.getLatestBlockhashAndContext("confirmed");
      current.transaction.recentBlockhash = latest.value.blockhash;
      const simulation = await wallet.connection.simulateTransaction(current.transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true
      } as any);
      if (simulation.value.err) {
        Alert.alert("Simulation failed", JSON.stringify(simulation.value.err));
        return;
      }
      const signature = await wallet.signAndSendTransaction(current.transaction, latest.context.slot);
      setPendingTx(null);
      if (current.afterSignature) {
        await current.afterSignature(String(signature));
      } else {
        await onRefresh();
        Alert.alert(current.successMessage ?? "Transaction sent", String(signature));
      }
    } catch (err: any) {
      Alert.alert("Wallet rejected or transaction failed", err?.message ?? String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.paper} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ink} />
        }
      >
        <Header
          connectedAddress={connectedAddress}
          onConnect={() => wallet.connect()}
          onDisconnect={() => wallet.disconnect()}
        />

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.ink} />
            <Text style={styles.monoMuted}>Loading Opta devnet</Text>
          </View>
        ) : error ? (
          <Card>
            <Text style={styles.cardTitle}>Could not load markets</Text>
            <Text style={styles.body}>{error}</Text>
            <PrimaryButton label="Retry" onPress={onRefresh} />
          </Card>
        ) : (
          <>
            <Stats snapshot={snapshot} asset={asset} positions={positions} />
            <TabBar tab={tab} setTab={setTab} />
            {tab === "trade" && snapshot && (
              <TradeScreen
                snapshot={snapshot}
                asset={asset}
                setAsset={setAsset}
                expiry={expiry}
                setExpiry={setExpiry}
                expiries={expiries}
                direction={direction}
                setDirection={setDirection}
                quantity={quantity}
                setQuantity={setQuantity}
                offerings={visibleOfferings}
                selectedOffering={selectedOffering}
                setSelectedOffering={setSelectedOffering}
                beginReview={beginReview}
              />
            )}
            {tab === "write" && snapshot && (
              <WriteScreen
                snapshot={snapshot}
                asset={asset}
                connected={!!connectedAddress}
                onConnect={() => wallet.connect()}
                beginWriteFlow={beginWriteFlow}
              />
            )}
            {tab === "portfolio" && (
              <PortfolioScreen positions={positions} connected={!!connectedAddress} onConnect={() => wallet.connect()} />
            )}
            {tab === "safety" && <SafetyScreen />}
          </>
        )}
      </ScrollView>

      {pendingTx && (
        <ReviewSheet
          pendingTx={pendingTx}
          sending={sending}
          onCancel={() => setPendingTx(null)}
          onSign={signPending}
        />
      )}
    </SafeAreaView>
  );
}

function Header({
  connectedAddress,
  onConnect,
  onDisconnect
}: {
  connectedAddress: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.eyebrow}>Solana Seeker native</Text>
        <Text style={styles.title}>opta.</Text>
        <Text style={styles.subtitle}>Tokenized options in a mobile trading shell.</Text>
      </View>
      <Pressable
        style={styles.walletChip}
        onPress={connectedAddress ? onDisconnect : onConnect}
      >
        <Text style={styles.walletText}>
          {connectedAddress ? shortAddress(connectedAddress) : "Connect"}
        </Text>
      </Pressable>
    </View>
  );
}

function Stats({
  snapshot,
  asset,
  positions
}: {
  snapshot: MarketSnapshot | null;
  asset: string;
  positions: WalletPosition[];
}) {
  const spot = asset ? snapshot?.spotByAsset[asset] : null;
  return (
    <View style={styles.statsGrid}>
      <Stat label="Cluster" value={EXPECTED_CLUSTER} sub="MWA wallet" />
      <Stat label="Spot" value={money(spot)} sub={asset || "No asset"} />
      <Stat label="Open offers" value={String(snapshot?.offerings.length ?? 0)} sub="Vault plus resale" />
      <Stat label="Positions" value={String(positions.length)} sub="Token-2022 wallet" />
    </View>
  );
}

function TradeScreen(props: {
  snapshot: MarketSnapshot;
  asset: string;
  setAsset: (asset: string) => void;
  expiry: number;
  setExpiry: (expiry: number) => void;
  expiries: number[];
  direction: Direction;
  setDirection: (direction: Direction) => void;
  quantity: string;
  setQuantity: (quantity: string) => void;
  offerings: Offering[];
  selectedOffering: Offering | null;
  setSelectedOffering: (offering: Offering) => void;
  beginReview: () => void;
}) {
  const {
    snapshot,
    asset,
    setAsset,
    expiry,
    setExpiry,
    expiries,
    direction,
    setDirection,
    quantity,
    setQuantity,
    offerings,
    selectedOffering,
    setSelectedOffering,
    beginReview
  } = props;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Trade</Text>
      <Text style={styles.body}>Pick a direction, select live inventory, review simulation, then hand signing to the Seeker wallet.</Text>

      <HorizontalChips
        values={snapshot.assets}
        selected={asset}
        onSelect={setAsset}
      />
      <HorizontalChips
        values={expiries.map((e) => String(e))}
        selected={String(expiry)}
        onSelect={(v) => setExpiry(Number(v))}
        labelFor={(v) => `${shortDate(Number(v))} ${countdown(Number(v))}`}
      />

      <View style={styles.segment}>
        <Toggle label="Up / Call" active={direction === "up"} onPress={() => setDirection("up")} tone="teal" />
        <Toggle label="Down / Put" active={direction === "down"} onPress={() => setDirection("down")} tone="crimson" />
      </View>

      <View style={styles.quantityRow}>
        <Text style={styles.label}>Contracts</Text>
        <TextInput
          value={quantity}
          onChangeText={setQuantity}
          keyboardType="number-pad"
          style={styles.input}
          placeholder="1"
          placeholderTextColor={colors.inkMuted}
        />
      </View>

      {offerings.length === 0 ? (
        <Card>
          <Text style={styles.cardTitle}>No mobile-fillable offer</Text>
          <Text style={styles.body}>Try a different expiry or direction. The app only shows active vault and resale inventory.</Text>
        </Card>
      ) : (
        <View style={styles.offerList}>
          {offerings.slice(0, 8).map((offering) => (
            <OfferingCard
              key={offering.id}
              offering={offering}
              selected={selectedOffering?.id === offering.id}
              onPress={() => setSelectedOffering(offering)}
            />
          ))}
        </View>
      )}

      <PrimaryButton
        label={selectedOffering ? "Review transaction" : "Select offer"}
        onPress={beginReview}
        disabled={!selectedOffering}
      />
    </View>
  );
}

function WriteScreen({
  snapshot,
  asset,
  connected,
  onConnect,
  beginWriteFlow
}: {
  snapshot: MarketSnapshot;
  asset: string;
  connected: boolean;
  onConnect: () => void;
  beginWriteFlow: (draft: WriteDraft) => void;
}) {
  const marketOptions = useMemo(() => {
    const map = new Map<string, { ticker: string; market: MarketSnapshot["markets"][number] }>();
    for (const market of snapshot.markets) {
      const ticker = market.account.assetName as string;
      if (ticker && !map.has(ticker)) map.set(ticker, { ticker, market });
    }
    return Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [snapshot.markets]);
  const [selectedAsset, setSelectedAsset] = useState(asset);
  const [side, setSide] = useState<OptionSide>("call");
  const [exerciseStyle, setExerciseStyle] = useState<ExerciseStyle>("european");
  const [strike, setStrike] = useState("");
  const [contracts, setContracts] = useState("1");
  const [expiryMode, setExpiryMode] = useState<"friday" | "7d" | "30d">("friday");
  const [premiumOverride, setPremiumOverride] = useState("");

  useEffect(() => {
    if (marketOptions.length === 0) return;
    if (!selectedAsset || !marketOptions.some((item) => item.ticker === selectedAsset)) {
      setSelectedAsset(asset && marketOptions.some((item) => item.ticker === asset)
        ? asset
        : marketOptions[0].ticker);
    }
  }, [asset, marketOptions, selectedAsset]);

  const selected = marketOptions.find((item) => item.ticker === selectedAsset) ?? marketOptions[0];
  const spot = selected ? snapshot.spotByAsset[selected.ticker] : null;
  const strikeNum = Number.parseFloat(strike) || 0;
  const contractsNum = Math.max(1, Number.parseInt(contracts, 10) || 1);
  const expiry = useMemo(() => {
    if (expiryMode === "friday") return nextFridayUtc8();
    const days = expiryMode === "7d" ? 7 : 30;
    return Math.floor(Date.now() / 1000) + days * 86400;
  }, [expiryMode]);
  const suggestedPremium = estimatePremium({
    asset: selected?.ticker ?? "",
    side,
    spot,
    strike: strikeNum,
    expiry
  });
  const overridePremium = Number.parseFloat(premiumOverride) || 0;
  const premiumPerContract = overridePremium > 0 ? overridePremium : suggestedPremium;
  const collateral = collateralRequired(strikeNum, contractsNum);
  const premiumReady = exerciseStyle === "american" || premiumPerContract > 0;
  const ready = !!selected && strikeNum > 0 && contractsNum > 0 && collateral > 0 && premiumReady;

  const submit = () => {
    if (!connected) {
      onConnect();
      return;
    }
    if (!selected || !ready) {
      Alert.alert("Write form incomplete", "Choose a market, strike, contract count, and premium.");
      return;
    }
    beginWriteFlow({
      market: selected.market,
      side,
      exerciseStyle,
      strike: strikeNum,
      expiry,
      contracts: contractsNum,
      premiumPerContract: Math.max(0.000001, premiumPerContract),
      collateral,
      vaultType: "epoch"
    });
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Write</Text>
      <Text style={styles.body}>Create a vault, deposit USDC collateral, then mint Token-2022 option contracts with Seeker wallet approval.</Text>
      {marketOptions.length > 0 ? (
        <>
          <HorizontalChips
            values={marketOptions.map((item) => item.ticker)}
            selected={selected?.ticker ?? ""}
            onSelect={setSelectedAsset}
          />
          <View style={styles.segment}>
            <Toggle label="Call" active={side === "call"} onPress={() => setSide("call")} tone="teal" />
            <Toggle label="Put" active={side === "put"} onPress={() => setSide("put")} tone="crimson" />
          </View>
          <View style={styles.segment}>
            <Toggle label="European" active={exerciseStyle === "european"} onPress={() => setExerciseStyle("european")} tone="teal" />
            <Toggle label="American" active={exerciseStyle === "american"} onPress={() => setExerciseStyle("american")} tone="crimson" />
          </View>
          <View style={styles.formGrid}>
            <View style={styles.formCell}>
              <Text style={styles.label}>Strike USDC</Text>
              <TextInput
                value={strike}
                onChangeText={setStrike}
                keyboardType="decimal-pad"
                style={styles.input}
                placeholder={spot ? spot.toFixed(2) : "0.00"}
                placeholderTextColor={colors.inkMuted}
              />
            </View>
            <View style={styles.formCell}>
              <Text style={styles.label}>Contracts</Text>
              <TextInput
                value={contracts}
                onChangeText={setContracts}
                keyboardType="number-pad"
                style={styles.input}
                placeholder="1"
                placeholderTextColor={colors.inkMuted}
              />
            </View>
          </View>
          <HorizontalChips
            values={["friday", "7d", "30d"]}
            selected={expiryMode}
            onSelect={(value) => setExpiryMode(value as "friday" | "7d" | "30d")}
            labelFor={(value) => value === "friday" ? `Friday ${shortDate(nextFridayUtc8())}` : value.toUpperCase()}
          />
          <View style={styles.quantityRow}>
            <Text style={styles.label}>Premium override</Text>
            <TextInput
              value={premiumOverride}
              onChangeText={setPremiumOverride}
              keyboardType="decimal-pad"
              style={styles.input}
              placeholder={suggestedPremium > 0 ? suggestedPremium.toFixed(2) : "Auto"}
              placeholderTextColor={colors.inkMuted}
            />
          </View>
          <Card>
            <Text style={styles.cardTitle}>
              {selected?.ticker} {side.toUpperCase()} ${strikeNum || "-"}
            </Text>
            <Text style={styles.body}>Spot: {money(spot)}</Text>
            <Text style={styles.body}>Expiry: {shortDate(expiry)} ({countdown(expiry)})</Text>
            <Text style={styles.body}>Collateral: {money(collateral)}</Text>
            <Text style={styles.body}>
              Premium: {exerciseStyle === "american"
                ? "priced on-chain during mint"
                : money(premiumPerContract)}
            </Text>
          </Card>
          <PrimaryButton
            label={connected ? "Review write" : "Connect wallet"}
            onPress={submit}
            disabled={connected && !ready}
          />
        </>
      ) : (
        <Card>
          <Text style={styles.cardTitle}>No markets registered</Text>
          <Text style={styles.body}>Create a market from the desktop app first, then return here to write mobile vaults.</Text>
        </Card>
      )}
    </View>
  );
}

function PortfolioScreen({
  positions,
  connected,
  onConnect
}: {
  positions: WalletPosition[];
  connected: boolean;
  onConnect: () => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Portfolio</Text>
      {!connected ? (
        <Card>
          <Text style={styles.cardTitle}>Connect Seeker wallet</Text>
          <Text style={styles.body}>Your option token balances are read from Token-2022 accounts after connection.</Text>
          <PrimaryButton label="Connect wallet" onPress={onConnect} />
        </Card>
      ) : positions.length === 0 ? (
        <Card>
          <Text style={styles.cardTitle}>No Opta option tokens found</Text>
          <Text style={styles.body}>Bought contracts will appear here after confirmation.</Text>
        </Card>
      ) : (
        positions.map((position) => (
          <Card key={position.id}>
            <Text style={styles.cardTitle}>
              {position.asset} {position.side.toUpperCase()} ${position.strike}
            </Text>
            <Text style={styles.body}>Balance: {position.balance}</Text>
            <Text style={styles.body}>Expiry: {shortDate(position.expiry)} ({countdown(position.expiry)})</Text>
            <Text style={styles.body}>Cost basis: {money(position.premiumPaid)}</Text>
          </Card>
        ))
      )}
    </View>
  );
}

function SafetyScreen() {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Safety</Text>
      {[
        ["Cluster lock", "This app is configured for Opta devnet and the Seeker MWA chain solana:devnet."],
        ["Simulation first", "The sign button is blocked when preflight simulation returns an error."],
        ["No private keys", "Wallet approval happens inside the MWA wallet. The app never asks for a seed phrase or keypair."],
        ["Token-2022 aware", "Buy transactions include option-token ATA creation, hook metadata, hook state, and compute budget bump."]
      ].map(([title, body]) => (
        <Card key={title}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
        </Card>
      ))}
    </View>
  );
}

function OfferingCard({
  offering,
  selected,
  onPress
}: {
  offering: Offering;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.offerCard, selected && styles.offerCardSelected]}
    >
      <View>
        <Text style={styles.offerMeta}>
          {offering.kind.toUpperCase()} / {offering.exerciseStyle.toUpperCase()}
        </Text>
        <Text style={styles.offerTitle}>
          {offering.asset} {offering.side.toUpperCase()} ${offering.strike}
        </Text>
        <Text style={styles.body}>{shortDate(offering.expiry)} / {countdown(offering.expiry)}</Text>
      </View>
      <View style={styles.offerRight}>
        <Text style={styles.price}>{money(offering.premium)}</Text>
        <Text style={styles.offerMeta}>{offering.quantityAvailable} left</Text>
      </View>
    </Pressable>
  );
}

function ReviewSheet({
  pendingTx,
  sending,
  onCancel,
  onSign
}: {
  pendingTx: PendingTx;
  sending: boolean;
  onCancel: () => void;
  onSign: () => void;
}) {
  return (
    <View style={styles.sheetBackdrop}>
      <View style={styles.sheet}>
        <Text style={styles.sectionTitle}>Review transaction</Text>
        {pendingTx.summary.map((line) => (
          <Text key={line} style={styles.body}>{line}</Text>
        ))}
        {pendingTx.simulationError ? (
          <Text style={styles.warning}>Simulation failed: {pendingTx.simulationError}</Text>
        ) : (
          <Text style={styles.success}>Simulation passed. Wallet approval is next.</Text>
        )}
        <View style={styles.sheetActions}>
          <SecondaryButton label="Cancel" onPress={onCancel} />
          <PrimaryButton
            label={sending ? "Sending..." : pendingTx.ctaLabel ?? "Sign in wallet"}
            onPress={onSign}
            disabled={sending || !!pendingTx.simulationError}
          />
        </View>
      </View>
    </View>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const tabs: Tab[] = ["trade", "write", "portfolio", "safety"];
  return (
    <View style={styles.tabBar}>
      {tabs.map((item) => (
        <Pressable
          key={item}
          onPress={() => setTab(item)}
          style={[styles.tab, tab === item && styles.tabActive]}
        >
          <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function HorizontalChips({
  values,
  selected,
  onSelect,
  labelFor
}: {
  values: string[];
  selected: string;
  onSelect: (value: string) => void;
  labelFor?: (value: string) => string;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {values.map((value) => (
        <Pressable
          key={value}
          onPress={() => onSelect(value)}
          style={[styles.chip, selected === value && styles.chipActive]}
        >
          <Text style={[styles.chipText, selected === value && styles.chipTextActive]}>
            {labelFor ? labelFor(value) : value}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Toggle({
  label,
  active,
  onPress,
  tone
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  tone: "teal" | "crimson";
}) {
  const activeColor = tone === "teal" ? colors.teal : colors.crimson;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.toggle, active && { backgroundColor: activeColor, borderColor: activeColor }]}
    >
      <Text style={[styles.toggleText, active && styles.toggleTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statSub}>{sub}</Text>
    </View>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function PrimaryButton({
  label,
  onPress,
  disabled
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.primaryButton, disabled && styles.disabled]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.secondaryButton}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.paper
  },
  scroll: {
    padding: 18,
    paddingBottom: 56
  },
  header: {
    paddingTop: 12,
    paddingBottom: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16
  },
  eyebrow: {
    color: colors.inkMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1.4
  },
  title: {
    color: colors.ink,
    fontSize: 56,
    lineHeight: 60,
    fontWeight: "500",
    fontStyle: "italic"
  },
  subtitle: {
    color: colors.inkBody,
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 250
  },
  walletChip: {
    height: 44,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.ink,
    borderRadius: 22
  },
  walletText: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.1
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10
  },
  stat: {
    width: "48%",
    borderWidth: 1,
    borderColor: colors.rule,
    padding: 14
  },
  label: {
    color: colors.inkMuted,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.2
  },
  statValue: {
    color: colors.ink,
    marginTop: 10,
    fontSize: 23,
    fontWeight: "700"
  },
  statSub: {
    color: colors.inkMuted,
    marginTop: 4,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.9
  },
  tabBar: {
    flexDirection: "row",
    marginTop: 18,
    borderWidth: 1,
    borderColor: colors.rule,
    borderRadius: 8,
    overflow: "hidden"
  },
  tab: {
    flex: 1,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.paper
  },
  tabActive: {
    backgroundColor: colors.ink
  },
  tabText: {
    color: colors.inkMuted,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.8
  },
  tabTextActive: {
    color: colors.paper
  },
  section: {
    marginTop: 22
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 34,
    lineHeight: 38,
    fontWeight: "500"
  },
  body: {
    color: colors.inkBody,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8
  },
  monoMuted: {
    color: colors.inkMuted,
    marginTop: 12,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.1
  },
  chipRow: {
    gap: 8,
    paddingVertical: 12
  },
  chip: {
    minHeight: 42,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 21,
    borderWidth: 1,
    borderColor: colors.rule
  },
  chipActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink
  },
  chipText: {
    color: colors.inkMuted,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1
  },
  chipTextActive: {
    color: colors.paper
  },
  segment: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4
  },
  toggle: {
    flex: 1,
    minHeight: 54,
    borderWidth: 1,
    borderColor: colors.rule,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center"
  },
  toggleText: {
    color: colors.inkMuted,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 1
  },
  toggleTextActive: {
    color: colors.paper
  },
  quantityRow: {
    marginTop: 16
  },
  formGrid: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16
  },
  formCell: {
    flex: 1
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.ruleStrong,
    borderRadius: 8,
    marginTop: 8,
    paddingHorizontal: 14,
    color: colors.ink,
    fontSize: 18,
    fontWeight: "700"
  },
  offerList: {
    gap: 10,
    marginTop: 14
  },
  offerCard: {
    borderWidth: 1,
    borderColor: colors.rule,
    backgroundColor: colors.paper,
    padding: 14,
    borderRadius: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12
  },
  offerCardSelected: {
    borderColor: colors.ink,
    backgroundColor: colors.paper2
  },
  offerMeta: {
    color: colors.inkMuted,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1
  },
  offerTitle: {
    color: colors.ink,
    marginTop: 8,
    fontSize: 20,
    fontWeight: "700"
  },
  offerRight: {
    alignItems: "flex-end",
    justifyContent: "center"
  },
  price: {
    color: colors.crimson,
    fontSize: 20,
    fontWeight: "800"
  },
  card: {
    marginTop: 14,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.rule,
    backgroundColor: colors.paper,
    ...shadow.card
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "800"
  },
  primaryButton: {
    marginTop: 16,
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18
  },
  primaryButtonText: {
    color: colors.paper,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 1.2
  },
  secondaryButton: {
    minHeight: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: colors.ruleStrong,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    flex: 1
  },
  secondaryButtonText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 1.2
  },
  disabled: {
    opacity: 0.45
  },
  warning: {
    marginTop: 12,
    color: colors.crimson,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "700"
  },
  success: {
    marginTop: 12,
    color: colors.teal,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "800"
  },
  loading: {
    marginTop: 80,
    alignItems: "center"
  },
  sheetBackdrop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(10,10,8,0.45)",
    justifyContent: "flex-end"
  },
  sheet: {
    backgroundColor: colors.paper,
    padding: 20,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18
  },
  sheetActions: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center"
  }
});
