// =============================================================================
// tests/zzz-vol-oracle.ts -- Phase 2 Stage B: VolOracle initialization
// =============================================================================
//
// Step 2 coverage for the per-asset realized-vol oracle:
//   - Happy path: init with valid Pyth fixture populates feed_id + bump,
//     zero-fills the buffer + accumulators
//   - Proof-of-feed-existence: BTC fixture against SOL feed_id arg reverts
//     with MismatchedFeedId
//   - Zero-feed defense-in-depth: [0u8; 32] arg reverts with
//     InvalidPythFeedId (proof check actually catches this first; the
//     test asserts EITHER error name is in the message since both are
//     valid rejection paths)
//   - Idempotency: second init for the same feed_id reverts ("already in use")
//
// Push, warmup, stale, and read-side gates land in Steps 3-4 with their
// own test files (or extensions to this one).
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { fixturePubkey, FEED_ID_HEX, VOL_TEST_FEED_HEX } from "./_pyth_fixtures";

const SOL_FEED_ID = Array.from(Buffer.from(FEED_ID_HEX.SOL, "hex"));
const BTC_FEED_ID = Array.from(Buffer.from(FEED_ID_HEX.BTC, "hex"));
const ZERO_FEED_ID: number[] = Array.from(Buffer.alloc(32, 0));

const SOL_FIXTURE = fixturePubkey("sol-180-fresh");
const BTC_FIXTURE = fixturePubkey("btc-fresh");

// Stage B Step 3 per-test feed IDs (32-byte hex -> number[]).
const VOL_FEED = {
  T1: Array.from(Buffer.from(VOL_TEST_FEED_HEX.T1_SEED, "hex")),
  T2: Array.from(Buffer.from(VOL_TEST_FEED_HEX.T2_RATE_LIMIT, "hex")),
  T3: Array.from(Buffer.from(VOL_TEST_FEED_HEX.T3_REAL_PUSH, "hex")),
  T5: Array.from(Buffer.from(VOL_TEST_FEED_HEX.T5_MISMATCH_HOST, "hex")),
  T6: Array.from(Buffer.from(VOL_TEST_FEED_HEX.T6_STALE, "hex")),
  T7: Array.from(Buffer.from(VOL_TEST_FEED_HEX.T7_ZERO_SPOT, "hex")),
  T4: Array.from(Buffer.from(VOL_TEST_FEED_HEX.T4_LONG_RING_WRAP, "hex")),
};

const VOL_FIXTURE = {
  T1: fixturePubkey("vol-t1-fresh"),
  T2: fixturePubkey("vol-t2-fresh"),
  T3_180: fixturePubkey("vol-t3-180"),
  T3_250: fixturePubkey("vol-t3-250"),
  T5_HOST: fixturePubkey("vol-t5-host"),
  T6_STALE: fixturePubkey("vol-t6-stale"),
  T7_ZERO: fixturePubkey("vol-t7-zero"),
  T4_FUTURE: fixturePubkey("vol-t4-long-future"),
};

function deriveVolOracle(programId: PublicKey, feedId: number[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vol_oracle"), Buffer.from(feedId)],
    programId,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("zzz-vol-oracle (Stage B Step 2)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta as Program<Opta>;
  const wallet = provider.wallet as anchor.Wallet;

  it("initializes a VolOracle for SOL with valid Pyth fixture", async () => {
    const [oraclePda] = deriveVolOracle(program.programId, SOL_FEED_ID);

    await program.methods
      .initializeVolOracle(SOL_FEED_ID)
      .accountsStrict({
        initializer: wallet.publicKey,
        priceUpdate: SOL_FIXTURE,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const oracle = await program.account.volOracle.fetch(oraclePda);
    assert.deepEqual(Array.from(oracle.feedId), SOL_FEED_ID, "feed_id stored");
    assert.equal(oracle.head, 0, "head starts at 0");
    assert.equal(oracle.sampleCount, 0, "sample_count starts at 0");
    assert.equal(oracle.lastSampleTs.toString(), "0", "last_sample_ts starts at 0");
    assert.equal(oracle.lastSpotPrice.toString(), "0", "last_spot_price starts at 0");
    assert.equal(oracle.sumLogReturns.toString(), "0", "sum_log_returns starts at 0");
    assert.equal(oracle.sumLogReturnsSq.toString(), "0", "sum_log_returns_sq starts at 0");
    assert.isAtLeast(oracle.samples.length, 720, "samples array is 720 long");
    // Spot-check: first and last sample slots are zero
    assert.equal(oracle.samples[0].toString(), "0");
    assert.equal(oracle.samples[719].toString(), "0");
    assert.isAbove(oracle.bump, 0, "bump set");
  });

  it("rejects BTC fixture against SOL feed_id arg (proof mismatch)", async () => {
    // Different feed_id (BTC) -> different PDA, so this is a fresh init,
    // not a re-init collision. The proof check (feed_id match against
    // PriceUpdateV2) is what reverts.
    const [oraclePda] = deriveVolOracle(program.programId, BTC_FEED_ID);

    try {
      await program.methods
        .initializeVolOracle(BTC_FEED_ID)  // BTC arg
        .accountsStrict({
          initializer: wallet.publicKey,
          priceUpdate: SOL_FIXTURE,  // SOL fixture -- mismatch
          volOracle: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown MismatchedFeedId");
    } catch (err: any) {
      assert.include(err.toString(), "MismatchedFeedId");
    }
  });

  it("rejects zero feed_id arg", async () => {
    // Proof check (verification_level + feed_id match) actually catches
    // the zero feed_id before the explicit InvalidPythFeedId guard
    // because no real PriceUpdateV2 has feed_id [0u8; 32]. Either
    // rejection is correct -- test asserts the call reverts with one of
    // the two expected error names.
    const [oraclePda] = deriveVolOracle(program.programId, ZERO_FEED_ID);

    try {
      await program.methods
        .initializeVolOracle(ZERO_FEED_ID)
        .accountsStrict({
          initializer: wallet.publicKey,
          priceUpdate: SOL_FIXTURE,
          volOracle: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown for zero feed_id");
    } catch (err: any) {
      const msg = err.toString();
      assert.isTrue(
        msg.includes("MismatchedFeedId") || msg.includes("InvalidPythFeedId"),
        `expected MismatchedFeedId or InvalidPythFeedId, got: ${msg}`,
      );
    }
  });

  it("second init for same feed_id reverts (account already in use)", async () => {
    // Reuses the SOL oracle the first test created.
    const [oraclePda] = deriveVolOracle(program.programId, SOL_FEED_ID);

    try {
      await program.methods
        .initializeVolOracle(SOL_FEED_ID)
        .accountsStrict({
          initializer: wallet.publicKey,
          priceUpdate: SOL_FIXTURE,
          volOracle: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown for re-init");
    } catch (err: any) {
      // Anchor surfaces this as 'already in use' or 'AccountAlreadyInUse'
      // depending on version. Either string indicates correct behavior.
      const msg = err.toString().toLowerCase();
      assert.isTrue(
        msg.includes("already in use") || msg.includes("alreadyinuse"),
        `expected re-init rejection, got: ${err.toString()}`,
      );
    }
  });

  // ===========================================================================
  // Step 3: push_vol_sample
  // ===========================================================================
  // Each test below uses its OWN feed_id (and oracle PDA) for isolation;
  // see VOL_TEST_FEED_HEX in _pyth_fixtures.ts. Most tests need the
  // `test-fast-vol` cargo feature so the rate-limit constant is 1 sec
  // instead of 55 min (otherwise the multi-push tests would either take
  // hours or skip silently — see prompt notes). run-tests.sh builds with
  // that feature.

  /**
   * Helper: init + push to seed an oracle from a single fixture.
   * Returns the oracle PDA so the caller can fetch / continue pushing.
   */
  async function initAndSeed(
    feedId: number[],
    fixture: PublicKey,
  ): Promise<PublicKey> {
    const [oraclePda] = deriveVolOracle(program.programId, feedId);
    await program.methods
      .initializeVolOracle(feedId)
      .accountsStrict({
        initializer: wallet.publicKey,
        priceUpdate: fixture,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await program.methods
      .pushVolSample()
      .accountsStrict({
        signer: wallet.publicKey,
        priceUpdate: fixture,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return oraclePda;
  }

  it("seed-push: first push to fresh oracle sets last_spot+ts only", async () => {
    const [oraclePda] = deriveVolOracle(program.programId, VOL_FEED.T1);
    await program.methods
      .initializeVolOracle(VOL_FEED.T1)
      .accountsStrict({
        initializer: wallet.publicKey,
        priceUpdate: VOL_FIXTURE.T1,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .pushVolSample()
      .accountsStrict({
        signer: wallet.publicKey,
        priceUpdate: VOL_FIXTURE.T1,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const oracle = await (program.account as any).volOracle.fetch(oraclePda);
    assert.equal(oracle.sampleCount, 0, "seed push must NOT write to buffer");
    assert.equal(oracle.head, 0, "head stays at 0 on seed-only");
    assert.equal(oracle.sumLogReturns.toString(), "0", "no accumulator update");
    assert.equal(oracle.sumLogReturnsSq.toString(), "0", "no acc-sq update");
    // last_spot_price at SCALE = $180 * 1e12 = 180e12
    assert.equal(
      oracle.lastSpotPrice.toString(),
      "180000000000000",
      "last_spot_price set from Pyth fixture",
    );
    assert.notEqual(oracle.lastSampleTs.toString(), "0", "last_sample_ts set to clock");
  });

  it("second push too soon reverts VolOraclePushTooSoon", async () => {
    // Two pushes in the same it() block guarantees the second fires
    // within < 1 sec of the first, beating the (test-fast-vol) 1-sec
    // rate limit reliably even on a slow validator.
    const oraclePda = await initAndSeed(VOL_FEED.T2, VOL_FIXTURE.T2);

    try {
      await program.methods
        .pushVolSample()
        .accountsStrict({
          signer: wallet.publicKey,
          priceUpdate: VOL_FIXTURE.T2,
          volOracle: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown VolOraclePushTooSoon");
    } catch (err: any) {
      assert.include(err.toString(), "VolOraclePushTooSoon");
    }
  });

  it("push after rate-limit interval writes first real sample", async () => {
    // Seed at spot=$180, wait > 1 sec (test-fast-vol rate limit), push
    // at spot=$250. Expect sample_count=1, head=1, log_return ~= ln(250/180)*1e12.
    const oraclePda = await initAndSeed(VOL_FEED.T3, VOL_FIXTURE.T3_180);

    // 2 sec is comfortably above the 1-sec test-fast-vol rate limit; the
    // production constant (55 min) is unreachable here without bankrun
    // and is what test-fast-vol exists to bypass.
    await sleep(2000);

    await program.methods
      .pushVolSample()
      .accountsStrict({
        signer: wallet.publicKey,
        priceUpdate: VOL_FIXTURE.T3_250,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const oracle = await (program.account as any).volOracle.fetch(oraclePda);
    assert.equal(oracle.sampleCount, 1, "first real sample written");
    assert.equal(oracle.head, 1, "head advanced");
    assert.equal(
      oracle.lastSpotPrice.toString(),
      "250000000000000",
      "last_spot_price advanced to new spot",
    );

    // Expected log_return = ln(250 / 180) * 1e12.
    const expected = Math.log(250 / 180) * 1e12;
    const actual = Number(oracle.samples[0].toString());
    // solmath rounding tolerance: ±1e7 (= 1e-5 absolute at SCALE).
    assert.closeTo(
      actual,
      expected,
      1e7,
      `samples[0] should be ln(250/180)*SCALE ~= ${expected}, got ${actual}`,
    );

    // Accumulator sanity: sum == samples[0], sum_sq == samples[0]^2.
    const sample0 = BigInt(oracle.samples[0].toString());
    assert.equal(oracle.sumLogReturns.toString(), sample0.toString());
    assert.equal(
      oracle.sumLogReturnsSq.toString(),
      (sample0 * sample0).toString(),
    );
  });

  it("rejects push with wrong-feed Pyth fixture (MismatchedFeedId)", async () => {
    // Init oracle for T5 feed, then push with SOL_FIXTURE (whose
    // feed_id != T5). The handler's feed_id-match check reverts.
    const [oraclePda] = deriveVolOracle(program.programId, VOL_FEED.T5);
    await program.methods
      .initializeVolOracle(VOL_FEED.T5)
      .accountsStrict({
        initializer: wallet.publicKey,
        priceUpdate: VOL_FIXTURE.T5_HOST,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .pushVolSample()
        .accountsStrict({
          signer: wallet.publicKey,
          priceUpdate: SOL_FIXTURE,  // wrong feed
          volOracle: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown MismatchedFeedId");
    } catch (err: any) {
      assert.include(err.toString(), "MismatchedFeedId");
    }
    // Suppress unused-binding hint for BTC fixture (only consumed by
    // Step 2 tests above; kept imported for future T5 variants).
    void BTC_FIXTURE;
  });

  it("rejects push with stale Pyth update (VolOraclePriceStale)", async () => {
    // T6 fixture has publishTime = baseTime - 400 (more than 60s in the
    // past). Init accepts (it doesn't check freshness); push reverts.
    const [oraclePda] = deriveVolOracle(program.programId, VOL_FEED.T6);
    await program.methods
      .initializeVolOracle(VOL_FEED.T6)
      .accountsStrict({
        initializer: wallet.publicKey,
        priceUpdate: VOL_FIXTURE.T6_STALE,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .pushVolSample()
        .accountsStrict({
          signer: wallet.publicKey,
          priceUpdate: VOL_FIXTURE.T6_STALE,
          volOracle: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown VolOraclePriceStale");
    } catch (err: any) {
      assert.include(err.toString(), "VolOraclePriceStale");
    }
  });

  it("rejects push with zero spot price (VolOracleInvalidSpot)", async () => {
    // T7 fixture has price=0 (with emaPrice=1 so EMA-conf gate stays
    // permissive). Init accepts (no spot validation); push reverts on
    // the spot-positivity gate.
    const [oraclePda] = deriveVolOracle(program.programId, VOL_FEED.T7);
    await program.methods
      .initializeVolOracle(VOL_FEED.T7)
      .accountsStrict({
        initializer: wallet.publicKey,
        priceUpdate: VOL_FIXTURE.T7_ZERO,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    try {
      await program.methods
        .pushVolSample()
        .accountsStrict({
          signer: wallet.publicKey,
          priceUpdate: VOL_FIXTURE.T7_ZERO,
          volOracle: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown VolOracleInvalidSpot");
    } catch (err: any) {
      assert.include(err.toString(), "VolOracleInvalidSpot");
    }
  });

  // -------------------------------------------------------------------------
  // Step 4 CU measurement (gated by CU_PROFILE=1; needs cu-profile feature)
  // -------------------------------------------------------------------------
  // Run via:
  //   CU_PROFILE=1 bash .test-fixtures/run-tests.sh tests/zzz-vol-oracle.ts
  // Prints + asserts CU < 8K for realized_vol_annualized (Stage B target).
  const RUN_CU_REALIZED_VOL = process.env.CU_PROFILE === "1";
  (RUN_CU_REALIZED_VOL ? it : it.skip)(
    "CU Profile: realized_vol_annualized (Stage B target < 8K)",
    async function () {
      this.timeout(30_000);
      // Fresh feed_id so this test doesn't collide with anything else.
      const cuFeedId = Array.from(Buffer.from(VOL_TEST_FEED_HEX.T2_RATE_LIMIT, "hex"));
      const [oraclePda] = deriveVolOracle(program.programId, cuFeedId);

      // Init only -- cu_profile_realized_vol overwrites the accumulators
      // with synthetic Vector-2 values; no push required.
      // Note: this oracle may already be initialized by T2 earlier in the
      // suite. If so, init reverts with "already in use" -- swallow that.
      try {
        await program.methods
          .initializeVolOracle(cuFeedId)
          .accountsStrict({
            initializer: wallet.publicKey,
            priceUpdate: VOL_FIXTURE.T2,
            volOracle: oraclePda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (err: any) {
        if (!/already in use/i.test(err.toString())) throw err;
      }

      // cu_profile_realized_vol isn't in the IDL (Anchor 0.32 cfg-gated
      // instruction quirk; same as cu_profile_american). Cast through any.
      const sig = await (program.methods as any)
        .cuProfileRealizedVol()
        .accountsStrict({
          signer: wallet.publicKey,
          volOracle: oraclePda,
        })
        .rpc({ commitment: "confirmed" });

      const tx = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.meta || !tx.meta.logMessages) {
        throw new Error("no logs available on cu-profile tx");
      }

      // The function is bracketed by sol_log_compute_units. Each
      // bracket emits a "consumption: N units remaining" line. The
      // DELTA between the two readings is the function's CU cost.
      const consumptionLines = tx.meta.logMessages.filter((l) =>
        l.includes("consumption:") || l.includes("Program consumption:"),
      );
      // Fallback for differing log formatting: also accept the standard
      // "Program <pid> consumed N of M compute units" trailer line for a
      // full-instruction baseline if we can't find the per-call bracket.
      let perCallCu: number | undefined;
      if (consumptionLines.length >= 2) {
        const first = /(\d+) units? remaining/.exec(consumptionLines[0])?.[1];
        const second = /(\d+) units? remaining/.exec(consumptionLines[1])?.[1];
        if (first && second) {
          perCallCu = parseInt(first, 10) - parseInt(second, 10);
        }
      }
      if (perCallCu === undefined) {
        // Fallback: read the full-instruction CU as a worst-case proxy.
        const trailer = tx.meta.logMessages.find((l) =>
          l.includes(program.programId.toBase58()) && l.includes("consumed"),
        );
        const m = /consumed (\d+) of/.exec(trailer ?? "");
        assert.isOk(m, `couldn't find CU log; logs: ${tx.meta.logMessages.join("\n")}`);
        perCallCu = parseInt(m![1], 10);
      }

      console.log(`\n    [CU] realized_vol_annualized consumed ${perCallCu} CU\n`);
      assert.isBelow(perCallCu, 8000, "Stage B target < 8K CU");
    },
  );

  // -------------------------------------------------------------------------
  // Test 4 (PERMANENTLY SKIPPED): full ring-buffer wrap via 721 pushes
  // -------------------------------------------------------------------------
  // Originally planned as the on-validator companion to the pure-Rust wrap
  // test. Found during Step 3 verification (2026-05-17) to be inherently
  // flaky against solana-test-validator: Clock::unix_timestamp has
  // seconds-granularity, slots are ~400ms, and consecutive pushes spaced
  // 2000ms apart sporadically land in the same Unix second after slot
  // boundary alignment -- producing delta=0 on the rate-limit check and
  // an unavoidable VolOraclePushTooSoon revert mid-loop.
  //
  // Bumping sleep further (3s, 4s) just defers the alignment race; the
  // root issue is wall-clock-vs-slot-clock drift over hundreds of
  // iterations. The proper fix is bankrun/litesvm with explicit setClock,
  // which the codebase does not currently use (memory:
  // feedback_solana_test_validator_wsl_path.md notes prior friction).
  //
  // What we keep instead:
  //   - state/vol_oracle.rs::tests::o1_accumulator_matches_naive_post_wrap
  //     runs 1500 synthetic samples through the *same* `apply()` logic the
  //     production handler uses (verified by code-comment cross-reference),
  //     completes in < 1ms, and cross-checks both `sum_log_returns` and
  //     `sum_log_returns_sq` against a naive O(n) recompute over the
  //     known input tail. Stronger algebraic coverage than the validator
  //     mechanics this skipped test was meant to provide.
  //   - state/vol_oracle.rs::tests::o1_accumulator_matches_naive_at_exactly_full
  //     specifically pins the head=0 wrap-at-720 boundary.
  //
  // Re-enable when the codebase adopts bankrun (separate arc).
  it.skip(
    "ring buffer wraps correctly at the 720th sample (covered by Rust unit tests)",
    () => {},
  );

  // -------------------------------------------------------------------------
  // CU measurement: pull consumed-CU from a real push_vol_sample tx log.
  // Measures the *full* production code path (Pyth validation + log return
  // + ring + accumulator update), which is what Stage C will pay when
  // create_shared_vault CPIs into the read path. The dedicated
  // cu_profile_push_vol_sample instruction (feature-gated) measures only
  // the apply_normal_push hot path -- useful for after-the-fact algorithm
  // tuning; for the Stage B 80K-CU target we want the full-path number.
  it("CU measurement: full push_vol_sample consumed CU", async function () {
    this.timeout(20_000);
    // Build fresh oracle so we exercise both seed + normal-push branches
    // independently of T3 (which the rate-limit test already mutated).
    const cuFeedId = Array.from(
      Buffer.from(VOL_TEST_FEED_HEX.T3_REAL_PUSH, "hex"),
    );
    const [oraclePda] = deriveVolOracle(program.programId, cuFeedId);

    // T3 already ran -- the oracle has sample_count=1, last_spot=$250.
    // Sleep > 1s and push again so we capture a normal-branch tx (not
    // the seed branch which has different CU shape).
    await sleep(2000);

    const sig = await program.methods
      .pushVolSample()
      .accountsStrict({
        signer: wallet.publicKey,
        priceUpdate: VOL_FIXTURE.T3_250,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || !tx.meta.logMessages) {
      throw new Error("no logs available on the push tx");
    }

    // Look for "Program <pid> consumed N of M compute units"
    const consumedLine = tx.meta.logMessages.find((l) =>
      l.includes(program.programId.toBase58()) && l.includes("consumed"),
    );
    assert.isOk(consumedLine, `no consumed-CU log found; logs: ${tx.meta.logMessages.join("\n")}`);

    const match = /consumed (\d+) of/.exec(consumedLine!);
    assert.isOk(match, `couldn't parse CU from line: ${consumedLine}`);
    const consumed = parseInt(match![1], 10);
    console.log(`\n    [CU] push_vol_sample (full path) consumed ${consumed} CU\n`);

    // Stage B target: < 80K. Hard-fail above 80K; warn above 60K.
    assert.isBelow(consumed, 80_000, `CU exceeds Stage B target (80K)`);
  });
});
