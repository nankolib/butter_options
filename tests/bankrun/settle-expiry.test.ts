// =============================================================================
// tests/bankrun/settle-expiry.test.ts
// Ported from tests/opta.ts describe.skip "settle_expiry".
// The clock-dependent cases: happy settle, MarketNotExpired (pre-expiry),
// PriceUpdateBeforeExpiry (publish_time < expiry), double-settle.
// (MismatchedFeedId / unregistered-asset are feed/account-validation, not
//  clock-gated — covered by construction + the validator suite.)
// =============================================================================

import { assert } from "chai";
import { setupEnv, settleExpiry, settlementRecordPda, getClockUnix, setClockUnix, BN } from "./helpers";

describe("bankrun: settle_expiry (clock-dependent)", function () {
  this.timeout(180_000);

  it("happy: permissionless settle past expiry records SettlementRecord", async () => {
    const e = await setupEnv("SETTLEHAPPY", "settle-happy");
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 100);
    await setClockUnix(e.h.context, expiry.toNumber() + 30);
    await settleExpiry(e, expiry, 180, expiry.toNumber() + 5);
    const rec: any = await e.opta.account.settlementRecord.fetch(settlementRecordPda(e, expiry));
    console.log(`    happy: settlement_price=${rec.settlementPrice.toString()}`);
    assert.equal(rec.settlementPrice.toString(), "180000000", "settlement price $180 (6-dec)");
  });

  it("MarketNotExpired: pre-expiry settle reverts", async () => {
    const e = await setupEnv("SETTLEPRE", "settle-pre");
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 86_400); // far future; clock stays at now < expiry
    let reverted = false, err = "";
    try {
      await settleExpiry(e, expiry, 180, now);
    } catch (ex: any) { reverted = true; err = String(ex).slice(0, 140); }
    console.log(`    MarketNotExpired reverted=${reverted} (${err})`);
    assert.isTrue(reverted && /MarketNotExpired/.test(err), "must revert MarketNotExpired");
  });

  it("PriceUpdateBeforeExpiry: publish_time < expiry reverts", async () => {
    const e = await setupEnv("SETTLESTALE", "settle-stale");
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 100);
    await setClockUnix(e.h.context, expiry.toNumber() + 30);
    let reverted = false, err = "";
    try {
      await settleExpiry(e, expiry, 180, expiry.toNumber() - 10); // publish BEFORE expiry
    } catch (ex: any) { reverted = true; err = String(ex).slice(0, 140); }
    console.log(`    PriceUpdateBeforeExpiry reverted=${reverted} (${err})`);
    assert.isTrue(reverted && /PriceUpdateBeforeExpiry/.test(err), "must revert PriceUpdateBeforeExpiry");
  });

  it("double-settle: second settle_expiry reverts (record already exists)", async () => {
    const e = await setupEnv("SETTLEDBL", "settle-dbl");
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 100);
    await setClockUnix(e.h.context, expiry.toNumber() + 30);
    await settleExpiry(e, expiry, 180, expiry.toNumber() + 5);
    let reverted = false;
    try { await settleExpiry(e, expiry, 180, expiry.toNumber() + 6); } catch { reverted = true; }
    console.log(`    double-settle reverted=${reverted}`);
    assert.isTrue(reverted, "second settle must revert");
  });
});
