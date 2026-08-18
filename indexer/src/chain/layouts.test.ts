// Offset tests for the chain read-path decoders.
//
//   run (from indexer/, in WSL):
//     node node_modules/.bin/tsx src/chain/layouts.test.ts
//   or via the repo test runner.
//
// WHY THESE MATTER MORE THAN USUAL
//
//   A wrong offset in a hand-rolled decoder does not throw. It reads eight
//   perfectly valid bytes from the wrong place and produces a number that is
//   structurally fine and semantically nonsense — a collateral figure, a
//   settlement flag, an exercised count. Downstream it renders as data.
//
//   So each field is written into a synthetic account at its documented offset
//   with a DISTINCT value, and the decode must return exactly that value. Any
//   shift, overlap or off-by-one moves at least one field onto another's bytes
//   and fails here rather than on a trading screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";

import {
  EPOCH_CONFIG_LEN, SHARED_VAULT_LEN, SHARED_VAULT_OFFSETS, VAULT_MINT_LEN,
  decodeEpochConfig, decodeOptionsMarket, decodeSharedVault, decodeVaultMint,
} from "./layouts";

/** A 32-byte key whose bytes are all `seed`, so each pubkey field is distinct. */
const key = (seed: number) => Buffer.alloc(32, seed);

function buildSharedVault(): { buf: Buffer; expect: Record<string, unknown> } {
  const b = Buffer.alloc(SHARED_VAULT_LEN);
  const o = SHARED_VAULT_OFFSETS;
  key(1).copy(b, o.market);
  b.writeUInt8(1, o.optionType);                       // put
  b.writeBigUInt64LE(567_000n, o.strikePrice);
  b.writeBigInt64LE(1_800_000_000n, o.expiry);
  b.writeUInt8(1, o.vaultType);
  b.writeBigUInt64LE(123_456_789n, o.totalCollateral);
  b.writeBigUInt64LE(1_000n, o.totalShares);
  key(2).copy(b, o.vaultUsdcAccount);
  key(3).copy(b, o.collateralMint);
  b.writeBigUInt64LE(42n, o.totalOptionsMinted);
  b.writeBigUInt64LE(7n, o.totalOptionsSold);
  b.writeBigUInt64LE(9_999n, o.netPremiumCollected);
  b.writeBigUInt64LE(5n, o.premiumPerShareCumulative);          // u128 low
  b.writeBigUInt64LE(0n, o.premiumPerShareCumulative + 8);      // u128 high
  b.writeUInt8(1, o.isSettled);
  b.writeBigUInt64LE(600_000n, o.settlementPrice);
  b.writeBigUInt64LE(111n, o.collateralRemaining);
  key(4).copy(b, o.creator);
  b.writeBigInt64LE(1_700_000_000n, o.createdAt);
  b.writeUInt8(254, o.bump);
  b.writeInt32LE(-250, o.carryRateBps);                // signed, deliberately
  b.writeUInt8(1, o.exerciseStyle);                    // american
  b.writeBigUInt64LE(3n, o.exercisedOptions);
  b.writeBigUInt64LE(888n, o.earlyExercisePayout);
  b.writeUInt16LE(50, o.spreadBps);
  b.writeUInt8(1, o.voided);
  b.writeBigUInt64LE(777n, o.writerAskCollateralSwept);
  b.writeBigUInt64LE(666n, o.writerAskEquivShares);
  return {
    buf: b,
    expect: {
      market: bs58.encode(key(1)),
      optionType: 1,
      strikePrice: "567000",
      expiry: "1800000000",
      vaultType: 1,
      totalCollateral: "123456789",
      totalShares: "1000",
      vaultUsdcAccount: bs58.encode(key(2)),
      collateralMint: bs58.encode(key(3)),
      totalOptionsMinted: "42",
      totalOptionsSold: "7",
      netPremiumCollected: "9999",
      premiumPerShareCumulative: "5",
      isSettled: true,
      settlementPrice: "600000",
      collateralRemaining: "111",
      creator: bs58.encode(key(4)),
      createdAt: "1700000000",
      bump: 254,
      carryRateBps: -250,
      exerciseStyle: 1,
      exercisedOptions: "3",
      earlyExercisePayout: "888",
      spreadBps: 50,
      voided: true,
      writerAskCollateralSwept: "777",
      writerAskEquivShares: "666",
    },
  };
}

test("RED: every SharedVault field decodes from its documented offset", () => {
  const { buf, expect } = buildSharedVault();
  const got = decodeSharedVault(buf);
  assert.ok(got, "a correctly sized vault must decode");
  for (const [k, v] of Object.entries(expect)) {
    assert.deepEqual((got as any)[k], v, `field ${k} decoded from the wrong offset`);
  }
});

test("RED: the two late fields the trade path depends on are correct", () => {
  // exercisedOptions ends at 249 (OrderTicket) and writerAskCollateralSwept ends
  // at 268 (earlyExerciseAvailability). These are the fields that made a
  // display-field schema unsafe, so they get their own assertion.
  const { buf } = buildSharedVault();
  const got = decodeSharedVault(buf)!;
  assert.equal(got.exercisedOptions, "3");
  assert.equal(got.writerAskCollateralSwept, "777");
  assert.equal(SHARED_VAULT_OFFSETS.exercisedOptions + 8, 249);
  assert.equal(SHARED_VAULT_OFFSETS.writerAskCollateralSwept + 8, 268);
});

test("legacy-sized SharedVaults are REJECTED, never partially parsed", () => {
  // 260 and 268 are previous layouts that still exist on devnet and share the
  // discriminator. Decoding them here yields valid-looking nonsense.
  for (const len of [260, 268, 275, 277]) {
    assert.equal(decodeSharedVault(Buffer.alloc(len)), null, `${len}B must be rejected`);
  }
});

test("u64 values are carried as strings, not numbers", () => {
  // A collateral figure quietly losing precision above 2^53 is wrong in a way
  // that looks right.
  const b = Buffer.alloc(SHARED_VAULT_LEN);
  b.writeBigUInt64LE(18_446_744_073_709_551_615n, SHARED_VAULT_OFFSETS.totalCollateral);
  const got = decodeSharedVault(b)!;
  assert.equal(got.totalCollateral, "18446744073709551615");
  assert.equal(typeof got.totalCollateral, "string");
});

test("VaultMint decodes each field from its own offset", () => {
  const b = Buffer.alloc(VAULT_MINT_LEN);
  key(5).copy(b, 8); key(6).copy(b, 40); key(7).copy(b, 72);
  b.writeBigUInt64LE(1_500n, 104);
  b.writeBigUInt64LE(10n, 112);
  b.writeBigUInt64LE(4n, 120);
  b.writeBigInt64LE(1_700_000_001n, 128);
  b.writeUInt8(253, 136);
  const got = decodeVaultMint(b)!;
  assert.equal(got.vault, bs58.encode(key(5)));
  assert.equal(got.writer, bs58.encode(key(6)));
  assert.equal(got.optionMint, bs58.encode(key(7)));
  assert.equal(got.premiumPerContract, "1500");
  assert.equal(got.quantityMinted, "10");
  assert.equal(got.quantitySold, "4");
  assert.equal(got.createdAt, "1700000001");
  assert.equal(got.bump, 253);
  assert.equal(decodeVaultMint(Buffer.alloc(VAULT_MINT_LEN - 1)), null);
});

test("EpochConfig decodes each field from its own offset", () => {
  const b = Buffer.alloc(EPOCH_CONFIG_LEN);
  key(8).copy(b, 8);
  b.writeUInt8(5, 40); b.writeUInt8(8, 41); b.writeUInt8(1, 42);
  b.writeUInt8(7, 43); b.writeUInt8(252, 44);
  const got = decodeEpochConfig(b)!;
  assert.equal(got.authority, bs58.encode(key(8)));
  assert.equal(got.weeklyExpiryDay, 5);
  assert.equal(got.weeklyExpiryHour, 8);
  assert.equal(got.monthlyEnabled, true);
  assert.equal(got.minEpochDurationDays, 7);
  assert.equal(got.bump, 252);
});

// ---------------------------------------------------------------------------
// OptionsMarket — variable-length, so the guards are the interesting part
// ---------------------------------------------------------------------------

function buildMarket(name: string, assetClass = 0, oracleSource = 1): Buffer {
  const n = Buffer.from(name, "utf8");
  const b = Buffer.alloc(8 + 4 + n.length + 32 + 3);
  b.writeUInt32LE(n.length, 8);
  n.copy(b, 12);
  Buffer.alloc(32, 9).copy(b, 12 + n.length);
  b.writeUInt8(assetClass, 12 + n.length + 32);
  b.writeUInt8(255, 12 + n.length + 33);
  b.writeUInt8(oracleSource, 12 + n.length + 34);
  return b;
}

test("OptionsMarket parses positionally past the variable-length name", () => {
  const got = decodeOptionsMarket(buildMarket("JTO", 0, 1))!;
  assert.equal(got.assetName, "JTO");
  assert.equal(got.assetClass, 0);
  assert.equal(got.oracleSource, 1);
  assert.equal(got.pythFeedId.length, 64, "feed id is 32 bytes as hex");
});

test("legacy OptionsMarket layouts are rejected by their out-of-range values", () => {
  // The repo's size-drift history: old layouts share the discriminator and
  // decode as garbage. assetClass > 4 and oracleSource > 1 are the tells.
  assert.equal(decodeOptionsMarket(buildMarket("JTO", 249, 1)), null, "assetClass 249 is garbage");
  assert.equal(decodeOptionsMarket(buildMarket("JTO", 0, 7)), null, "oracleSource 7 is garbage");
  assert.equal(decodeOptionsMarket(buildMarket(" bad", 0, 1)), null, "non-ticker name is garbage");
  assert.equal(decodeOptionsMarket(Buffer.alloc(12)), null, "truncated is rejected");
});

test("an absurd name length is refused before it reaches a slice", () => {
  const b = Buffer.alloc(64);
  b.writeUInt32LE(0xffffffff, 8);
  assert.equal(decodeOptionsMarket(b), null);
});
