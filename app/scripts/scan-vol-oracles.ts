// =============================================================================
// scan-vol-oracles.ts — read-only census of VolOracle PDAs for opta markets
// =============================================================================
//
// PURPOSE
//   Enumerates every current-schema OptionsMarket account on the connected
//   cluster, derives the expected VolOracle PDA per market's pyth_feed_id,
//   and reports which oracles are seeded vs missing. Surfaces the coverage
//   gap exposed by the MSTR 3007 incident (2026-05-28): the vol-oracle
//   crank's polling cadence leaves a race window where users can write on a
//   permissionlessly-created market before its oracle has been initialized.
//
// WHEN TO USE
//   - Triaging any 3007 / AccountOwnedByWrongProgram on mint_from_vault.
//   - Confirming devnet/mainnet vol-oracle coverage after a deploy.
//   - Periodic operational audit (recommended weekly until W2 — crank
//     reactive seeding via onLogs(MarketCreated) — ships).
//
// MECHANIC
//   Anchor's typed .all() blows up on stale-schema discriminator-collision
//   orphans (feedback_anchor_all_orphan_trap memory). This script bypasses
//   .all() with raw getProgramAccounts + memcmp filter on the 8-byte
//   OptionsMarket discriminator, then parses each result by byte offsets,
//   skipping malformed accounts. Same pattern as
//   migrate-shared-vaults-carry-rate.ts and other Stage A/C migration
//   scripts. Surfaces a parsed/skipped count so orphan churn is visible.
//
// CONFIGURATION
//   OPTA_RPC_URL env var overrides the default (public devnet). For
//   production debugging swap to a paid RPC (Helius) — public devnet
//   may rate-limit getProgramAccounts on large programs.
//
// CONSTRAINTS
//   Read-only. No transactions. Safe to run against mainnet with the
//   program-id swap. Returns exit code 0 always — the report is the
//   output. To gate CI on coverage, wrap the script in a parser that
//   asserts unseeded == 0.
//
// HISTORY
//   2026-05-28 — created during MSTR Custom Vault 3007 follow-up after the
//   MSTR oracle self-seeded between the initial diag (oracle missing) and
//   the broader coverage audit (oracle seeded by crank polling cycle).
//   Confirmed 15/15 markets covered at that moment; race window remains
//   the durable concern that W1 (frontend gate) and W2 (crank reactive
//   seeding) address. Companion to app/scripts/diag-mstr-3007.ts.
// =============================================================================

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import idl from "../src/idl/opta.json";

const RPC = process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
const ASSET_CLASS_LABELS = ["Crypto", "Commodity", "Equity", "FX", "ETF"];

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const wallet = new Wallet(Keypair.generate()); // read-only
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program = new Program(idl as any, provider);
  const programId = program.programId;

  console.log(`Program ID: ${programId.toBase58()}`);
  console.log(`RPC:        ${RPC}`);
  console.log();

  // Manual decode path (Anchor .all() blows up on stale-schema orphans per
  // anchor_all_orphan_trap memory). Compute the OptionsMarket discriminator,
  // filter on it via getProgramAccounts memcmp, then parse each result by
  // byte offsets — robustly skipping malformed accounts.
  const DISC = createHash("sha256")
    .update("account:OptionsMarket")
    .digest()
    .subarray(0, 8);
  const raw = await conn.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(DISC) } }],
  });
  console.log(`Fetched ${raw.length} accounts with OptionsMarket discriminator (incl. orphans)`);

  const markets: Array<{
    publicKey: PublicKey;
    account: { assetName: string; pythFeedId: number[]; assetClass: number };
    dataSize: number;
  }> = [];
  const skipped: Array<{ pubkey: string; reason: string }> = [];

  for (const { pubkey, account } of raw) {
    const data = account.data;
    if (data.length < 50 || data.length > 200) {
      skipped.push({ pubkey: pubkey.toBase58(), reason: `size ${data.length} out of range` });
      continue;
    }
    try {
      const nameLen = data.readUInt32LE(8);
      if (nameLen < 1 || nameLen > 32) {
        skipped.push({ pubkey: pubkey.toBase58(), reason: `name_len=${nameLen} suspicious` });
        continue;
      }
      const nameEnd = 12 + nameLen;
      if (nameEnd + 32 + 1 + 1 > data.length) {
        skipped.push({ pubkey: pubkey.toBase58(), reason: `truncated past name` });
        continue;
      }
      const name = data.subarray(12, nameEnd).toString("utf-8");
      if (!/^[A-Z0-9-]{1,16}$/i.test(name)) {
        skipped.push({ pubkey: pubkey.toBase58(), reason: `name="${name}" not ticker-like` });
        continue;
      }
      const feedId = data.subarray(nameEnd, nameEnd + 32);
      const assetClass = data.readUInt8(nameEnd + 32);
      if (assetClass > 4) {
        skipped.push({ pubkey: pubkey.toBase58(), reason: `asset_class=${assetClass} > 4` });
        continue;
      }
      markets.push({
        publicKey: pubkey,
        account: { assetName: name, pythFeedId: Array.from(feedId), assetClass },
        dataSize: data.length,
      });
    } catch (e: any) {
      skipped.push({ pubkey: pubkey.toBase58(), reason: e?.message ?? "parse error" });
    }
  }
  console.log(`Parsed ${markets.length} current-schema OptionsMarket accounts; ${skipped.length} skipped (stale-schema orphans)`);
  if (skipped.length > 0 && skipped.length <= 20) {
    for (const s of skipped) console.log(`    skip ${s.pubkey.slice(0,8)}… : ${s.reason}`);
  }
  console.log();

  markets.sort((a, b) =>
    (a.account.assetName as string).localeCompare(b.account.assetName as string),
  );

  const seeded: Array<{ name: string; cls: string; volPda: string; feedHex: string }> = [];
  const unseeded: Array<{ name: string; cls: string; volPda: string; feedHex: string; assetClass: number }> = [];
  const zeroFeed: string[] = [];

  for (const m of markets) {
    const feedIdBytes = Buffer.from(m.account.pythFeedId as number[]);
    const feedHex = feedIdBytes.toString("hex");
    const name = m.account.assetName as string;
    const ac = m.account.assetClass as number;
    const cls = ASSET_CLASS_LABELS[ac] ?? `?(${ac})`;
    if (feedHex === "00".repeat(32)) {
      zeroFeed.push(name);
      continue;
    }
    const [volPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vol_oracle"), feedIdBytes],
      programId,
    );
    const acct = await conn.getAccountInfo(volPda);
    const exists = !!acct && acct.owner.equals(programId);
    const row = { name, cls, volPda: volPda.toBase58(), feedHex, assetClass: ac };
    if (exists) seeded.push(row);
    else unseeded.push(row);
  }

  const fmt = (r: { name: string; cls: string; volPda: string; feedHex: string }) =>
    `  ${r.name.padEnd(10)}  ${r.cls.padEnd(9)}  ${r.volPda}  feed=0x${r.feedHex.slice(0, 10)}…${r.feedHex.slice(-6)}`;

  console.log(`######## SEEDED (${seeded.length}) ########`);
  seeded.forEach((s) => console.log(fmt(s)));
  console.log();
  console.log(`######## UN-SEEDED (${unseeded.length}) — need initialize_vol_oracle ########`);
  if (unseeded.length === 0) console.log("  (none)");
  else unseeded.forEach((s) => console.log(fmt(s)));
  console.log();
  if (zeroFeed.length > 0) {
    console.log(`######## ZERO-FEED markets (${zeroFeed.length}) — cannot seed; require migrate_pyth_feed first ########`);
    zeroFeed.forEach((n) => console.log(`  ${n}`));
    console.log();
  }
  console.log(
    `Summary: ${seeded.length} seeded, ${unseeded.length} unseeded${zeroFeed.length > 0 ? `, ${zeroFeed.length} zero-feed` : ""}, ${markets.length} total`,
  );
  console.log();
  if (unseeded.length > 0) {
    console.log("Action: list of (asset, feed_id) tuples to pass to seed-vol-oracles.ts:");
    for (const u of unseeded) {
      console.log(`  ${u.name}  0x${u.feedHex}`);
    }
  }
})();
