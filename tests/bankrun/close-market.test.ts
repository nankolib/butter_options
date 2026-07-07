// =============================================================================
// tests/bankrun/close-market.test.ts
// Proves the admin-only close_market instruction (SB crypto migration cutover).
//
//   1. happy path   — admin closes the market; account gone + rent → admin.
//   2. non-admin    — a non-admin signer is rejected (Unauthorized); market survives.
//   3. double-close — a second close of the same market reverts (account gone).
//
// close_market has NO on-chain child-check by design (see close_market.rs);
// safety is enforced off-chain by scripts/preflight_close_market.ts. These tests
// cover the close mechanics + auth gate only.
// =============================================================================

import { assert } from "chai";
import { setupEnv, exists, actor } from "./helpers";

describe("bankrun: close_market (admin-only; cutover name-handover)", function () {
  this.timeout(180_000);

  it("happy path: admin closes the market and reclaims rent", async () => {
    const e = await setupEnv("CLOSEME", "closeme-feed");
    assert.isTrue(await exists(e, e.market), "market exists after setup");

    const marketAcct = await e.h.context.banksClient.getAccount(e.market);
    const rent = marketAcct!.lamports;
    const before = (await e.h.context.banksClient.getAccount(e.admin.publicKey))!.lamports;

    await e.opta.methods.closeMarket("CLOSEME").accountsStrict({
      admin: e.admin.publicKey,
      protocolState: e.protocolState,
      market: e.market,
    }).rpc();

    assert.isFalse(await exists(e, e.market), "market account is closed");
    const after = (await e.h.context.banksClient.getAccount(e.admin.publicKey))!.lamports;
    // admin nets the market rent minus the tx fee; rent (~0.001 SOL) >> fee (5000 lamports).
    assert.isAbove(after, before, "admin balance increased (rent reclaimed)");
    assert.isAbove(after - before, rent - 100_000, "admin received approximately the market rent");
  });

  it("rejects a non-admin caller and leaves the market intact", async () => {
    const e = await setupEnv("CLOSEME2", "closeme2-feed");
    const attacker = actor(e);

    let threw = false;
    try {
      await e.opta.methods.closeMarket("CLOSEME2").accountsStrict({
        admin: attacker.publicKey,
        protocolState: e.protocolState,
        market: e.market,
      }).signers([attacker]).rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /Unauthorized|ConstraintAddress|2012|0x7d0/, "address gate rejected non-admin");
    }
    assert.isTrue(threw, "non-admin close must revert");
    assert.isTrue(await exists(e, e.market), "market survives a rejected close");
  });

  it("rejects a double-close (account already gone)", async () => {
    const e = await setupEnv("CLOSEME3", "closeme3-feed");
    await e.opta.methods.closeMarket("CLOSEME3").accountsStrict({
      admin: e.admin.publicKey,
      protocolState: e.protocolState,
      market: e.market,
    }).rpc();
    assert.isFalse(await exists(e, e.market), "market closed by the first call");

    let threw = false;
    try {
      await e.opta.methods.closeMarket("CLOSEME3").accountsStrict({
        admin: e.admin.publicKey,
        protocolState: e.protocolState,
        market: e.market,
      }).rpc();
    } catch (err: any) {
      threw = true;
    }
    assert.isTrue(threw, "second close of the same market must revert");
  });
});
