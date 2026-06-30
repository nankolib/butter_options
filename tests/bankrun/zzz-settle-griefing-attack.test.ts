// =============================================================================
// zzz-settle-griefing-attack.test.ts — Phase 3 retro-harden ADVERSARIAL proof
// =============================================================================
//
// Proves the settle_vault writer-ask pot is UN-OMITTABLE and UN-SUBSTITUTABLE:
// a permissionless settler cannot omit, substitute, or bypass the pot to settle
// with swept == 0 while a funded pot exists (the strand-the-collateral grief).
//
// Each grief is CONSTRUCTED and RUN — the revert is observed, not asserted in
// prose. The legitimate no-pot path (correctly-derived empty pot) must still
// succeed byte-identically (swept == 0, total_shares unchanged).
//
//   (a) omit the pot account            → Anchor "Account not provided" (required)
//   (b) substitute another vault's pot   → InvalidVaultMint (6029, require_keys_eq)
//   (c) empty account at a wrong address → InvalidVaultMint (6029, pin BEFORE data_is_empty)
//   (d) correct derived-empty pot        → settles, swept == 0, total_shares unchanged
// =============================================================================

import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, deposit, settleExpiry, settlementRecordPda,
  settlePotAccounts, setClockUnix, getClockUnix, usdc, actor, usdcAta, Env,
} from "./helpers";

const CALL = { call: {} };

describe("settle_vault griefing — pot un-omittable / un-substitutable (Phase 3 retro-harden)", function () {
  this.timeout(120_000);

  let e: Env;
  let expiry: BN;
  let vault: PublicKey, vaultUsdc: PublicKey;
  let otherPot: PublicKey;        // a DIFFERENT vault's canonical pot address
  let preTotalShares: string;     // total_shares snapshot before settle (byte-identity)

  before(async () => {
    e = await setupEnv("SETTLEGRIEF", "settle-grief-feed", 100);
    const writer = actor(e);
    await usdcAta(e, writer.publicKey, 10_000_000_000_000n);   // fund the depositor
    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);

    // Target: European no-pot vault, $100k deposited. swept must stay 0.
    const cv = await createVault(e, "european", usdc(40), expiry, CALL, writer);
    vault = cv.vault; vaultUsdc = cv.vaultUsdc;
    await deposit(e, vault, vaultUsdc, writer, 100_000);

    // A genuinely different vault (different strike) → a real, non-matching pot addr.
    const ov = await createVault(e, "european", usdc(55), expiry, CALL, writer);
    otherPot = (await settlePotAccounts(e, ov.vault)).writerAskPot;

    // Make the target settle-able: clock past expiry + SettlementRecord exists.
    await setClockUnix(e.h.context, now + 3600 + 30);
    await settleExpiry(e, expiry, 50, now + 3600 + 5);

    const v: any = await e.opta.account.sharedVault.fetch(vault);
    preTotalShares = v.totalShares.toString();
  });

  // Build the canonical settle account-set, then apply per-attack overrides.
  async function settleAccounts(overrides: Record<string, any> = {}) {
    const sp = await settlePotAccounts(e, vault);
    return {
      authority: e.admin.publicKey, sharedVault: vault, market: e.market,
      settlementRecord: settlementRecordPda(e, expiry),
      ...sp, ...overrides,
    };
  }

  it("(a) omit the pot account → rejected (required account not provided)", async () => {
    const full = await settleAccounts();
    delete (full as any).writerAskPot;   // omit the now-required pot record
    let err = "";
    try {
      await e.opta.methods.settleVault().accounts(full as any).rpc();
      assert.fail("settle succeeded with the pot omitted — grief NOT closed");
    } catch (ex: any) { err = String(ex); }
    console.log(`    (a) omit       → ${err.split("\n")[0].slice(0, 140)}`);
    assert.match(err, /writerAskPot|not provided|Account.*Missing|missing/i,
      "omitting the pot must be rejected at account resolution");
    // Vault must remain unsettled — the grief did not land.
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isFalse(v.isSettled, "vault must stay unsettled after a rejected omit");
  });

  it("(b) substitute another vault's pot → InvalidVaultMint (6029)", async () => {
    const accs = await settleAccounts({ writerAskPot: otherPot });
    let err = "";
    try {
      await e.opta.methods.settleVault().accountsStrict(accs).rpc();
      assert.fail("settle succeeded with a substituted pot — grief NOT closed");
    } catch (ex: any) { err = String(ex); }
    console.log(`    (b) substitute → ${err.split("\n")[0].slice(0, 140)}`);
    assert.match(err, /InvalidVaultMint|6029/, "a different vault's pot must be rejected by require_keys_eq");
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isFalse(v.isSettled, "vault must stay unsettled after a rejected substitution");
  });

  it("(c) empty account at a wrong (non-derived) address → InvalidVaultMint (6029), pinned BEFORE data_is_empty", async () => {
    const garbage = Keypair.generate().publicKey;   // empty + wrong address
    const accs = await settleAccounts({ writerAskPot: garbage });
    let err = "";
    try {
      await e.opta.methods.settleVault().accountsStrict(accs).rpc();
      assert.fail("settle succeeded with an empty wrong-address pot — bypass NOT closed");
    } catch (ex: any) { err = String(ex); }
    console.log(`    (c) wrong-addr → ${err.split("\n")[0].slice(0, 140)}`);
    assert.match(err, /InvalidVaultMint|6029/,
      "an empty account at a non-derived address must fail the pin before data_is_empty()");
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isFalse(v.isSettled, "vault must stay unsettled after a rejected bypass");
  });

  it("(d) correctly-derived empty pot on a genuine no-pot vault → settles, swept == 0, total_shares unchanged", async () => {
    const accs = await settleAccounts();   // the honest, derived account-set
    await e.opta.methods.settleVault().accountsStrict(accs).rpc();
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isTrue(v.isSettled, "honest no-pot settle must succeed");
    assert.equal(v.writerAskCollateralSwept.toString(), "0", "swept must be 0 (no pot)");
    assert.equal(v.writerAskEquivShares.toString(), "0", "equiv-shares must be 0 (no pot)");
    assert.equal(v.totalShares.toString(), preTotalShares, "total_shares byte-identical (no equiv added)");
    console.log(`    (d) honest     → settled, swept=0, total_shares unchanged (${preTotalShares})`);
  });
});
