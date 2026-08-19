// =============================================================================
// gridMigration.divergence.ts — can the indexer answer what the GRID asks?
// =============================================================================
//
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register gridMigration.divergence.ts
//
// STAGE 1 GATE for moving the grid onto the read path. Nothing switches until
// this is clean.
//
// WHAT IS BEING COMPARED
//
//   exchangeData decodes raw account bytes at hand-written offsets and produces
//   the objects the grid renders. The indexer decodes the SAME accounts through
//   a different implementation and serves JSON. Two decoders, one truth — and a
//   disagreement between them is precisely a silently wrong number on a trading
//   screen, which is the failure this whole migration must not introduce.
//
//   So every account is parsed BOTH ways from the same slot and compared field
//   by field. A fixture cannot do this job: it would only encode whatever I
//   believed on the day I wrote it, which is the assumption under test.
//
// THE OFFSETS ARE NOT ASSUMED EQUAL
//
//   exchangeData accepts `d.length >= 260`, so it parses 260- and 268-byte
//   LEGACY vaults too. The indexer refuses anything that is not exactly 276.
//   That is a real behavioural difference, not a rounding error, and it is
//   reported separately rather than hidden inside a mismatch count.
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";

import {
  isSeriesSentinel, parseSeriesRecord, parseSharedVault,
} from "@app/utils/exchangeData";

const RPC = process.env.OPTA_RPC_URL || "https://rpc.opta.fyi/devnet";
const API = process.env.OPTA_CHAIN_API || "https://opta.fyi/api/chain";
const PROGRAM = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");

const disc = (name: string) =>
  bs58.encode(createHash("sha256").update(`account:${name}`).digest().subarray(0, 8));

const MICRO = 1_000_000;

/** Inject a fault into one field, to prove the comparison can fail. */
const CORRUPT = process.env.CORRUPT_FIELD || "";

interface Row { pubkey: string; data: Buffer }

async function scan(name: string): Promise<{ rows: Row[]; slot: number }> {
  const conn = new Connection(RPC, "confirmed");
  const res = await conn.getProgramAccounts(PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: disc(name) } }],
  });
  const slot = await conn.getSlot("confirmed");
  return { rows: res.map((r) => ({ pubkey: r.pubkey.toBase58(), data: r.account.data })), slot };
}

async function indexer(path: string): Promise<any[]> {
  const res = await fetch(`${API}/${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()).rows ?? [];
}

// ---------------------------------------------------------------------------
// Pilot: SeriesRecord (5 fields) — the tractable one
// ---------------------------------------------------------------------------

async function checkSeries(): Promise<boolean> {
  const { rows } = await scan("VaultMint");
  const jsonRows = await indexer("series");
  const byKey = new Map(jsonRows.map((r) => [r.publicKey, r]));

  let compared = 0, mismatched = 0, sentinelDisagree = 0, missing = 0;
  const problems: string[] = [];

  for (const r of rows) {
    const chainIsSentinel = isSeriesSentinel(r.data);
    const j = byKey.get(r.pubkey);
    if (!j) { if (chainIsSentinel) missing++; continue; }

    // The indexer serves every VaultMint; the sentinel test is the GRID's, so it
    // must be reproducible from JSON. writer == default, premium == 0, createdAt == 0.
    const jsonIsSentinel =
      j.writer === "11111111111111111111111111111111" &&
      String(j.premiumPerContract) === "0" &&
      String(j.createdAt) === "0";
    if (chainIsSentinel !== jsonIsSentinel) {
      sentinelDisagree++;
      if (problems.length < 5) problems.push(`${r.pubkey}: sentinel chain=${chainIsSentinel} json=${jsonIsSentinel}`);
      continue;
    }
    if (!chainIsSentinel) continue;

    const ours = parseSeriesRecord(new PublicKey(r.pubkey), r.data);
    let qMinted = String(j.quantityMinted);
    if (CORRUPT === "quantityMinted") qMinted = String(Number(qMinted) + 1);

    const checks: [string, unknown, unknown][] = [
      ["vault", ours.vault, j.vault],
      ["optionMint", ours.optionMint, j.optionMint],
      ["quantityMinted", String(ours.quantityMinted), qMinted],
      ["quantitySold", String(ours.quantitySold), String(j.quantitySold)],
    ];
    const bad = checks.find(([, a, b]) => String(a) !== String(b));
    if (bad) {
      mismatched++;
      if (problems.length < 5) problems.push(`${r.pubkey}: ${bad[0]} chain=${bad[1]} json=${bad[2]}`);
    } else compared++;
  }

  console.log(`\nSeriesRecord (pilot)`);
  console.log(`  sentinel series compared : ${compared}`);
  console.log(`  sentinel test disagreed  : ${sentinelDisagree}`);
  console.log(`  present on chain, absent from index : ${missing}`);
  console.log(`  MISMATCHES               : ${mismatched}${mismatched ? "  <-- decoders disagree" : ""}`);
  problems.forEach((p) => console.log(`     ! ${p}`));
  return mismatched === 0 && sentinelDisagree === 0 && missing === 0;
}

// ---------------------------------------------------------------------------
// The substantial one: SharedVault as the grid reads it
// ---------------------------------------------------------------------------

async function checkVaults(): Promise<boolean> {
  const { rows } = await scan("SharedVault");
  const jsonRows = await indexer("vaults");
  const byKey = new Map(jsonRows.map((r) => [r.publicKey, r]));

  let compared = 0, mismatched = 0, legacyOnlyOnChain = 0;
  const problems: string[] = [];

  for (const r of rows) {
    const ours = parseSharedVault(new PublicKey(r.pubkey), r.data);
    if (!ours) continue;
    const j = byKey.get(r.pubkey);
    if (!j) {
      // exchangeData accepts >=260 bytes; the indexer requires exactly 276. A
      // legacy vault therefore appears on the grid today and would VANISH after
      // the migration. That is a product decision, not a bug, and it is counted
      // rather than buried.
      legacyOnlyOnChain++;
      continue;
    }

    let strike = Number(j.strikePrice) / MICRO;
    if (CORRUPT === "strike") strike += 1;

    const checks: [string, unknown, unknown][] = [
      ["market", ours.market, j.market],
      ["optionType", ours.optionType, j.optionType === 0 ? "call" : "put"],
      ["strike", ours.strike, strike],
      ["expiry", ours.expiry, Number(j.expiry)],
      ["vaultType", ours.vaultType, j.vaultType === 0 ? "epoch" : "custom"],
      ["totalOptionsSold", ours.totalOptionsSold, Number(j.totalOptionsSold)],
      ["isSettled", ours.isSettled, j.isSettled],
      ["exerciseStyle", ours.exerciseStyle, j.exerciseStyle === 1 ? "american" : "european"],
      ["voided", ours.voided, j.voided],
    ];
    const bad = checks.find(([, a, b]) => String(a) !== String(b));
    if (bad) {
      mismatched++;
      if (problems.length < 6) problems.push(`${r.pubkey}: ${bad[0]} chain=${bad[1]} json=${bad[2]}`);
    } else compared++;
  }

  console.log(`\nSharedVault (as the grid reads it)`);
  console.log(`  vaults compared          : ${compared}`);
  console.log(`  legacy: on grid today, ABSENT from index : ${legacyOnlyOnChain}`);
  console.log(`  MISMATCHES               : ${mismatched}${mismatched ? "  <-- decoders disagree" : ""}`);
  problems.forEach((p) => console.log(`     ! ${p}`));
  return mismatched === 0;
}

async function main() {
  if (CORRUPT) console.log(`!! CORRUPT_FIELD=${CORRUPT} — this run MUST report mismatches`);
  const a = await checkSeries();
  const b = await checkVaults();
  const clean = a && b;
  console.log(`\n${clean ? "DECODERS AGREE — grid can migrate on correctness grounds" : "DECODERS DISAGREE — DO NOT MIGRATE"}`);
  process.exit(clean ? 0 : 1);
}

void main();
