// =============================================================================
// tests/bankrun/sb-init-vol-oracle-source.test.ts  (Stage 3 1c-i-A)
//
// Guard proofs for the generalized initialize_vol_oracle(feed_id, oracle_source):
// the birth path that lets a VolOracle be born Switchboard-sourced (the keystone
// read in push_vol_sample routes on VolOracle.oracle_source). litesvm cannot
// fabricate a valid signed_slothash, so the SB happy-path (a real quote) is the
// devnet smoke; here we prove only the routing/validation surface.
//
//   (P)  oracle_source = 0 (Pyth): present price_update + matching feed → born
//        Pyth; oracle_source byte reads 0. Unchanged behavior, new explicit arg.
//   (SB) oracle_source = 1 (Switchboard): NO price_update (None) → born SB; the
//        oracle_source byte reads 1. The Pyth proof is skipped (deferred to the
//        first push_vol_sample SB arm). feed_id holds an arbitrary 32-byte
//        feedHash (double-duty field).
//   (X)  oracle_source = 2 (invalid): reverts InvalidOracleSource (6066).
//   (M)  oracle_source = 0 but NO price_update → PriceUpdateMissing (6064): the
//        Pyth arm requires the (now-optional) account to be present.
// =============================================================================

import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import { setupEnv, getClockUnix, pda, injectPythFixture, pythBody } from "./helpers";
import { synthFeedIdHex } from "../_pyth_fixtures";

// A fresh feed distinct from the one setupEnv already initialized, so each init
// targets a brand-new vol_oracle PDA (plain `init` — would collide otherwise).
function freshFeed(label: string): { hex: string; bytes: number[] } {
  const hex = synthFeedIdHex(label);
  return { hex, bytes: Array.from(Buffer.from(hex, "hex")) };
}
const volOraclePda = (bytes: number[]) => pda([Buffer.from("vol_oracle"), Buffer.from(bytes)]);

describe("bankrun: Stage 3 1c-i-A — initialize_vol_oracle oracle_source", function () {
  this.timeout(180_000);

  it("(P) oracle_source=0 (Pyth) + present price_update → born Pyth", async () => {
    const e = await setupEnv("SBINIT0", "sbinit0", 100);
    const feed = freshFeed("sbinit0-pyth");
    const oracle = volOraclePda(feed.bytes);
    const now = await getClockUnix(e.h.context);

    const { Keypair } = await import("@solana/web3.js");
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(feed.hex, 100, now)); // feed_id matches → proof passes

    await e.opta.methods.initializeVolOracle(feed.bytes, 0).accountsStrict({
      initializer: e.admin.publicKey, priceUpdate: fix, volOracle: oracle,
      systemProgram: SystemProgram.programId,
    }).rpc();

    const o: any = await e.opta.account.volOracle.fetch(oracle);
    assert.equal(o.oracleSource, 0, "born Pyth (oracle_source = 0)");
    assert.deepEqual(Array.from(o.feedId), feed.bytes, "feed_id stored");
    assert.equal(o.sampleCount, 0, "fresh oracle, sample_count 0");
    console.log(`    (P) Pyth init OK: oracle_source=${o.oracleSource}`);
  });

  it("(SB) oracle_source=1 (Switchboard) + NO price_update → born Switchboard", async () => {
    const e = await setupEnv("SBINIT1", "sbinit1", 100);
    const feed = freshFeed("sbinit1-sb");
    const oracle = volOraclePda(feed.bytes);

    // No price_update (None) — the SB feed-existence proof is deferred to the
    // first push_vol_sample. feed_id holds the (arbitrary, here) 32-byte feedHash.
    await e.opta.methods.initializeVolOracle(feed.bytes, 1).accountsStrict({
      initializer: e.admin.publicKey, priceUpdate: null, volOracle: oracle,
      systemProgram: SystemProgram.programId,
    }).rpc();

    const o: any = await e.opta.account.volOracle.fetch(oracle);
    assert.equal(o.oracleSource, 1, "born Switchboard (oracle_source = 1)");
    assert.deepEqual(Array.from(o.feedId), feed.bytes, "feedHash stored in feed_id (double-duty)");
    assert.equal(o.lastSpotPrice.toString(), "0", "no spot yet (push deferred)");
    console.log(`    (SB) Switchboard init OK: oracle_source=${o.oracleSource}, price_update omitted`);
  });

  it("(X) oracle_source=2 (invalid) → InvalidOracleSource (6066)", async () => {
    const e = await setupEnv("SBINIT2", "sbinit2", 100);
    const feed = freshFeed("sbinit2-bad");
    const oracle = volOraclePda(feed.bytes);
    let err = "";
    try {
      await e.opta.methods.initializeVolOracle(feed.bytes, 2).accountsStrict({
        initializer: e.admin.publicKey, priceUpdate: null, volOracle: oracle,
        systemProgram: SystemProgram.programId,
      }).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (X) ${err.slice(0, 120)}`);
    assert.match(err, /InvalidOracleSource|6066/, "out-of-range oracle_source must revert");
  });

  it("(M) oracle_source=0 (Pyth) but NO price_update → PriceUpdateMissing (6064)", async () => {
    const e = await setupEnv("SBINIT3", "sbinit3", 100);
    const feed = freshFeed("sbinit3-missing");
    const oracle = volOraclePda(feed.bytes);
    let err = "";
    try {
      await e.opta.methods.initializeVolOracle(feed.bytes, 0).accountsStrict({
        initializer: e.admin.publicKey, priceUpdate: null, volOracle: oracle,
        systemProgram: SystemProgram.programId,
      }).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (M) ${err.slice(0, 120)}`);
    assert.match(err, /PriceUpdateMissing|6064/, "Pyth init must require the price_update account");
  });
});
