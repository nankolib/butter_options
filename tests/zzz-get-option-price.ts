// =============================================================================
// tests/zzz-get-option-price.ts -- Phase 2 Stage C Pass 3 .view() coverage
// =============================================================================
//
// Standalone .view() test for the get_option_price instruction. Owns its
// provider + program + on-chain market/oracle discovery. Does NOT import
// the rotted _pyth_fixtures.ts chain — kept fully outside the legacy
// fixture-rotted suite that is currently failing 97 tests.
//
// Three cases:
//   (a) AMER call  — sane quote OR .skip() on warmup
//   (b) AMER put   — sane quote OR .skip() on warmup
//   (c) EUR call   — must throw ViewNotSupportedForEuropean (code 6051)
//
// Devnet, read-only. .view() does simulateTransaction; no fees, no writes.
//
// Run:
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json \
//   npx ts-mocha -p ./tsconfig.json tests/zzz-get-option-price.ts --timeout 30000
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { expect } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Opta } from "../target/types/opta";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const VOL_ORACLE_SEED = Buffer.from("vol_oracle");
const WARMUP_SAMPLES = 168;

const OPTIONS_MARKET_DISCRIMINATOR = createHash("sha256")
  .update("account:OptionsMarket")
  .digest()
  .subarray(0, 8);

// Borsh-encoded OptionsMarket layout (mirrors programs/opta/src/state/market.rs):
//   8 disc + 4 + N asset_name (Borsh String) + 32 pyth_feed_id + 1 asset_class + 1 bump
function decodeOptionsMarket(
  data: Buffer,
): { assetName: string; pythFeedId: Buffer } | null {
  if (data.length < 8 + 4) return null;
  let offset = 8;
  const nameLen = data.readUInt32LE(offset);
  offset += 4;
  if (nameLen > 16 || data.length < offset + nameLen + 32) return null;
  const assetName = data.subarray(offset, offset + nameLen).toString("utf8");
  offset += nameLen;
  const pythFeedId = data.subarray(offset, offset + 32);
  return { assetName, pythFeedId };
}

// VolOracle zero_copy layout (mirrors programs/opta/src/state/vol_oracle.rs):
//   8 disc + 16 sum + 16 sum_sq + 32 feed_id + 5760 samples
//   + 8 last_sample_ts + 8 last_spot_price + 2 head + 2 sample_count
//   + 1 bump + 11 _padding = 5864 total
const VOL_ORACLE_LAST_TS_OFFSET = 8 + 16 + 16 + 32 + 5760;        // 5832
const VOL_ORACLE_LAST_SPOT_OFFSET = VOL_ORACLE_LAST_TS_OFFSET + 8; // 5840
const VOL_ORACLE_SAMPLE_COUNT_OFFSET = VOL_ORACLE_LAST_SPOT_OFFSET + 8 + 2; // 5850

function decodeVolOracleLight(data: Buffer): {
  sampleCount: number;
  lastSampleTs: number;
  lastSpotPrice: bigint;
} {
  return {
    sampleCount: data.readUInt16LE(VOL_ORACLE_SAMPLE_COUNT_OFFSET),
    lastSampleTs: Number(data.readBigInt64LE(VOL_ORACLE_LAST_TS_OFFSET)),
    lastSpotPrice: data.readBigInt64LE(VOL_ORACLE_LAST_SPOT_OFFSET),
  };
}

function deriveVolOracle(feedId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VOL_ORACLE_SEED, feedId], PROGRAM_ID);
}

describe("get_option_price view (Phase 2 Stage C Pass 3)", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<Opta>;
  let bestMarket: PublicKey;
  let bestOracle: PublicKey;
  let bestAsset: string;
  let bestSampleCount: number;
  let bestSpotMicro: bigint;

  before(async function () {
    this.timeout(60_000);

    // Standalone provider — no anchor.workspace dependency, no Anchor.toml
    // assumption. Pulls RPC + wallet from env per Anchor convention.
    const rpc = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
    const walletPath =
      process.env.ANCHOR_WALLET ||
      path.join(process.env.HOME || process.env.USERPROFILE || "~", ".config/solana/id.json");
    const conn = new Connection(rpc, "confirmed");
    const rawKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
    const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(rawKey)));
    provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    const idl = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"),
    );
    program = new Program(idl, provider) as Program<Opta>;

    console.log(`  RPC:    ${rpc}`);
    console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

    const marketAccts = await conn.getProgramAccounts(PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: anchor.utils.bytes.bs58.encode(OPTIONS_MARKET_DISCRIMINATOR),
          },
        },
      ],
    });
    console.log(`  Found ${marketAccts.length} OptionsMarket accounts on devnet.`);

    type Row = {
      asset: string;
      market: PublicKey;
      oracle: PublicKey;
      sampleCount: number;
      lastSpot: bigint;
    };
    let best: Row | null = null;

    for (const a of marketAccts) {
      const dec = decodeOptionsMarket(a.account.data);
      if (!dec) continue;
      const [oracle] = deriveVolOracle(dec.pythFeedId);
      const info = await conn.getAccountInfo(oracle);
      if (!info) continue;
      const ov = decodeVolOracleLight(info.data);
      if (!best || ov.sampleCount > best.sampleCount) {
        best = {
          asset: dec.assetName,
          market: a.pubkey,
          oracle,
          sampleCount: ov.sampleCount,
          lastSpot: ov.lastSpotPrice,
        };
      }
    }

    if (!best) throw new Error("No markets with vol oracles found on devnet.");
    bestMarket = best.market;
    bestOracle = best.oracle;
    bestAsset = best.asset;
    bestSampleCount = best.sampleCount;
    bestSpotMicro = best.lastSpot;

    console.log(`  Picked oracle (highest sample_count):`);
    console.log(`    asset:        ${bestAsset}`);
    console.log(`    market:       ${bestMarket.toBase58()}`);
    console.log(`    vol_oracle:   ${bestOracle.toBase58()}`);
    console.log(`    sample_count: ${bestSampleCount} / ${WARMUP_SAMPLES} warmup`);
    console.log(`    last_spot:    ${bestSpotMicro.toString()} (SCALE 1e12)`);
  });

  // Build a strike near current spot. spot is at SCALE 1e12; strike is u64
  // USDC 6-decimal. Convert SCALE -> USDC by dividing by 1e6, then round to
  // the nearest whole dollar so the strike is clean and ATM-ish.
  function strikeNearSpot(): BN {
    const M = BigInt(1_000_000);
    const HALF_M = BigInt(500_000);
    if (bestSpotMicro === BigInt(0)) return new BN(100_000_000); // $100 fallback
    const usdc = bestSpotMicro / M;            // SCALE 1e12 -> USDC 1e6
    const dollars = (usdc + HALF_M) / M;       // round to $1
    const strike = dollars * M;                // back to USDC 1e6
    return new BN(strike.toString());
  }

  function expiry7DaysFromNow(): BN {
    return new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  }

  async function viewQuote(optionType: any, exerciseStyle: any) {
    return program.methods
      .getOptionPrice(
        strikeNearSpot(),
        expiry7DaysFromNow(),
        optionType,
        exerciseStyle,
        0,
      )
      .accounts({ market: bestMarket, volOracle: bestOracle } as any)
      .view();
  }

  // SKIP 2026-05-24: oracle warmup unlock window opens today. First 4 of 11
  // oracles unlock 2026-05-24/05-26 per project_phase2_stage_b.md. If the
  // picked oracle still has sample_count < 168 at run time, both AMER cases
  // skip with a logged note. Re-run any time after the warmup count crosses
  // 168.

  it("(a) AMER call returns sane quote (or skips on warmup)", async function () {
    this.timeout(30_000);
    if (bestSampleCount < WARMUP_SAMPLES) {
      console.log(
        `  SKIP: oracle sample_count=${bestSampleCount} < ${WARMUP_SAMPLES} warmup threshold`,
      );
      this.skip();
    }
    const before = Math.floor(Date.now() / 1000);
    const quote: any = await viewQuote({ call: {} }, { american: {} });
    const after = Math.floor(Date.now() / 1000);

    console.log(
      `  AMER CALL  premium=${quote.premiumPerContract.toString()}  vol=${quote.volUsedScaled.toString()}  spot=${quote.spotUsedScaled.toString()}  ts=${quote.computedAtTs.toString()}`,
    );

    expect(quote.premiumPerContract.toNumber()).to.be.greaterThan(0);
    expect(quote.volUsedScaled.toNumber()).to.be.greaterThan(0);
    expect(quote.spotUsedScaled.toNumber()).to.be.greaterThan(0);
    const ts = quote.computedAtTs.toNumber();
    expect(ts).to.be.gte(before - 60);
    expect(ts).to.be.lte(after + 60);
  });

  it("(b) AMER put returns sane quote (or skips on warmup)", async function () {
    this.timeout(30_000);
    if (bestSampleCount < WARMUP_SAMPLES) {
      console.log(
        `  SKIP: oracle sample_count=${bestSampleCount} < ${WARMUP_SAMPLES} warmup threshold`,
      );
      this.skip();
    }
    const before = Math.floor(Date.now() / 1000);
    const quote: any = await viewQuote({ put: {} }, { american: {} });
    const after = Math.floor(Date.now() / 1000);

    console.log(
      `  AMER PUT   premium=${quote.premiumPerContract.toString()}  vol=${quote.volUsedScaled.toString()}  spot=${quote.spotUsedScaled.toString()}  ts=${quote.computedAtTs.toString()}`,
    );

    expect(quote.premiumPerContract.toNumber()).to.be.greaterThan(0);
    expect(quote.volUsedScaled.toNumber()).to.be.greaterThan(0);
    expect(quote.spotUsedScaled.toNumber()).to.be.greaterThan(0);
    const ts = quote.computedAtTs.toNumber();
    expect(ts).to.be.gte(before - 60);
    expect(ts).to.be.lte(after + 60);
  });

  it("(c) EUR call throws ViewNotSupportedForEuropean (6051)", async function () {
    this.timeout(30_000);
    let threw = false;
    let logs: string[] = [];
    let msg = "";
    let code: number | null = null;
    let name: string | null = null;
    try {
      await viewQuote({ call: {} }, { european: {} });
    } catch (err: any) {
      threw = true;
      msg = String(err?.message || err);
      code = err?.error?.errorCode?.number ?? err?.code ?? null;
      name = err?.error?.errorCode?.code ?? null;
      logs = err?.logs || err?.simulationResponse?.logs || [];
      console.log(`  EUR view rejected:`);
      console.log(`    name: ${name}`);
      console.log(`    code: ${code}`);
      console.log(`    msg:  ${msg.slice(0, 240)}`);
      if (logs.length) {
        console.log(`    logs (last 6):`);
        for (const l of logs.slice(-6)) console.log(`      ${l}`);
      }
    }
    expect(threw, "EUR .view() should have thrown").to.equal(true);

    // SKIP 2026-05-24: detect Pass-3-not-yet-deployed case. Deployed devnet
    // bytecode pre-Pass-3 returns InstructionFallbackNotFound (code 101 / 0x65)
    // because the get_option_price discriminator is unknown. Once Pass 3 is
    // live on devnet this branch stops triggering and the 6051 assertion below
    // runs unconditionally. Re-run this test after deploy.
    const haystack = [msg, ...(logs || [])].join("\n");
    const isNotYetDeployed =
      /InstructionFallbackNotFound|\bcustom program error: 0x65\b/.test(haystack);
    if (isNotYetDeployed) {
      console.log(
        `  SKIP: get_option_price not yet deployed on devnet (Pass 3 deploy is a separate step)`,
      );
      this.skip();
    }

    const matches =
      code === 6051 ||
      name === "ViewNotSupportedForEuropean" ||
      /ViewNotSupportedForEuropean|0x17a3\b|\b6051\b/.test(haystack);
    expect(
      matches,
      `expected 6051 / ViewNotSupportedForEuropean, got msg='${msg}' logs=${logs.length}`,
    ).to.equal(true);
  });
});
