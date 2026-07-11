import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createOptaProgram, safeFetchAll } from "./program";
import {
  HERMES_BASE,
  PHASE2_CUTOFF_TIMESTAMP
} from "../constants";
import { hexFromBytes, usdcToNumber } from "../format";
import type {
  AccountRecord,
  ExerciseStyle,
  MarketSnapshot,
  Offering,
  OptionSide,
  WalletPosition
} from "../types";

function bnToNumber(value: any): number {
  if (typeof value === "number") return value;
  if (value?.toNumber) return value.toNumber();
  return Number(value ?? 0);
}

function isCall(optionType: any): boolean {
  return !!optionType && (("call" in optionType) || ("Call" in optionType) || optionType === 0);
}

function exerciseStyleName(value: any): ExerciseStyle {
  return value && (("american" in value) || ("American" in value) || value === 1)
    ? "american"
    : "european";
}

function isPostPhase2Vault(vault: AccountRecord): boolean {
  const createdAt = bnToNumber(vault.account.createdAt);
  return createdAt >= PHASE2_CUTOFF_TIMESTAMP;
}

async function fetchSpot(feedIdHex: string): Promise<number | null> {
  const hex = feedIdHex.replace(/^0x/, "").toLowerCase();
  const url = `${HERMES_BASE}/v2/updates/price/latest?ids[]=0x${hex}&encoding=base64`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const json = await resp.json();
  const price = json?.parsed?.[0]?.price;
  if (!price || typeof price.price !== "string" || typeof price.expo !== "number") return null;
  const value = Number(price.price) * Math.pow(10, price.expo);
  return Number.isFinite(value) ? value : null;
}

export async function loadMarketSnapshot(connection: Connection): Promise<MarketSnapshot> {
  const program = createOptaProgram(connection);
  const [markets, rawVaults, rawVaultMints, listings] = await Promise.all([
    safeFetchAll(program, "optionsMarket"),
    safeFetchAll(program, "sharedVault"),
    safeFetchAll(program, "vaultMint"),
    safeFetchAll(program, "vaultResaleListing")
  ]);

  const vaults = rawVaults.filter(isPostPhase2Vault);
  const validVaultKeys = new Set(vaults.map((v) => v.publicKey.toBase58()));
  const vaultMints = rawVaultMints.filter((m) =>
    validVaultKeys.has((m.account.vault as PublicKey).toBase58())
  );
  const marketByKey = new Map(markets.map((m) => [m.publicKey.toBase58(), m]));
  const vaultByKey = new Map(vaults.map((v) => [v.publicKey.toBase58(), v]));
  const listingsByMint = new Map<string, AccountRecord[]>();

  for (const listing of listings) {
    const mint = (listing.account.optionMint as PublicKey).toBase58();
    const qty = bnToNumber(listing.account.listedQuantity);
    if (qty <= 0) continue;
    const arr = listingsByMint.get(mint) ?? [];
    arr.push(listing);
    listingsByMint.set(mint, arr);
  }

  const feeds = new Map<string, string>();
  for (const market of markets) {
    const asset = market.account.assetName as string;
    if (!asset || feeds.has(asset)) continue;
    feeds.set(asset, hexFromBytes(market.account.pythFeedId as number[]));
  }

  const spotByAsset: Record<string, number> = {};
  await Promise.all(
    Array.from(feeds.entries()).map(async ([asset, feed]) => {
      const spot = await fetchSpot(feed).catch(() => null);
      if (spot != null) spotByAsset[asset] = spot;
    })
  );

  const offerings: Offering[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const vaultMint of vaultMints) {
    const vault = vaultByKey.get((vaultMint.account.vault as PublicKey).toBase58());
    if (!vault || vault.account.isSettled) continue;
    const market = marketByKey.get((vault.account.market as PublicKey).toBase58());
    if (!market) continue;

    const asset = market.account.assetName as string;
    const side: OptionSide = isCall(vault.account.optionType) ? "call" : "put";
    const strike = usdcToNumber(vault.account.strikePrice);
    const expiry = bnToNumber(vault.account.expiry);
    if (expiry <= now) continue;
    const exerciseStyle = exerciseStyleName(vault.account.exerciseStyle);
    const optionMint = vaultMint.account.optionMint as PublicKey;
    const minted = bnToNumber(vaultMint.account.quantityMinted);
    const sold = bnToNumber(vaultMint.account.quantitySold);
    const unsold = minted - sold;

    if (unsold > 0) {
      offerings.push({
        id: `vault:${vaultMint.publicKey.toBase58()}`,
        kind: "vault",
        side,
        asset,
        strike,
        expiry,
        premium: usdcToNumber(vaultMint.account.premiumPerContract),
        quantityAvailable: unsold,
        exerciseStyle,
        market,
        vault,
        vaultMint
      });
    }

    for (const listing of listingsByMint.get(optionMint.toBase58()) ?? []) {
      const seller = listing.account.seller as PublicKey;
      offerings.push({
        id: `resale:${listing.publicKey.toBase58()}`,
        kind: "resale",
        side,
        asset,
        strike,
        expiry,
        premium: usdcToNumber(listing.account.pricePerContract),
        quantityAvailable: bnToNumber(listing.account.listedQuantity),
        exerciseStyle,
        market,
        vault,
        vaultMint,
        listing,
        seller
      });
    }
  }

  offerings.sort((a, b) => a.premium - b.premium);

  const assets = Array.from(new Set(offerings.map((o) => o.asset))).sort();
  const expiriesByAsset: Record<string, number[]> = {};
  for (const asset of assets) {
    expiriesByAsset[asset] = Array.from(
      new Set(offerings.filter((o) => o.asset === asset).map((o) => o.expiry))
    ).sort((a, b) => a - b);
  }

  return {
    markets,
    vaults,
    vaultMints,
    listings,
    spotByAsset,
    offerings,
    assets,
    expiriesByAsset,
    fetchedAt: Date.now()
  };
}

export async function loadWalletPositions(
  connection: Connection,
  owner: PublicKey,
  snapshot: MarketSnapshot
): Promise<WalletPosition[]> {
  const tokenAccounts = await connection.getTokenAccountsByOwner(owner, {
    programId: TOKEN_2022_PROGRAM_ID
  });
  const balances = new Map<string, number>();
  for (const item of tokenAccounts.value) {
    const mint = new PublicKey(item.account.data.slice(0, 32)).toBase58();
    const amount = Number(item.account.data.readBigUInt64LE(64));
    if (amount > 0) balances.set(mint, amount);
  }

  const byMint = new Map<string, Offering>();
  for (const offering of snapshot.offerings) {
    const mint = (offering.vaultMint.account.optionMint as PublicKey).toBase58();
    if (!byMint.has(mint)) byMint.set(mint, offering);
  }

  const positions: WalletPosition[] = [];
  for (const [mint, balance] of balances.entries()) {
    const offering = byMint.get(mint);
    if (!offering) continue;
    positions.push({
      id: mint,
      asset: offering.asset,
      side: offering.side,
      strike: offering.strike,
      expiry: offering.expiry,
      balance,
      premiumPaid: offering.premium * balance,
      currentMark: null
    });
  }
  return positions;
}
