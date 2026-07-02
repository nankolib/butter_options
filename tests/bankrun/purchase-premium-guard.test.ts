// =============================================================================
// tests/bankrun/purchase-premium-guard.test.ts
// =============================================================================
// Proves the purchase_from_vault premium>0 guard (reuses InvalidPremium 6012):
//   1. A real-premium buy still succeeds — USDC moves, token delivered,
//      quantity_sold bumps (guard does not break legitimate buys).
//   2. A $0-premium record (the American series sentinel case, forced here via
//      bankrun account surgery so the test doesn't depend on a specific
//      sentinel-creation path) reverts with InvalidPremium (6012) BEFORE any
//      USDC/token movement.
// =============================================================================

import { assert } from "chai";
import { Buffer } from "buffer";
import {
  setupEnv, createVault, deposit, mint, purchase, usdcAta, bal,
  getClockUnix, usdc, BN, type Env,
} from "./helpers";

describe("purchase_from_vault premium>0 guard (InvalidPremium 6012)", function () {
  this.timeout(120_000);
  let e: Env;

  before(async () => {
    e = await setupEnv("PREMGUARD", "premguard");
  });

  it("1 — real-premium buy still succeeds (USDC moves, token delivered, quantity_sold bumps)", async () => {
    const now = await getClockUnix(e.h.context);
    const strike = usdc(100);
    const expiry = new BN(now + 7 * 86_400);
    const w = e.h.payer; // creator+writer (custom vault: only creator deposits)
    const { vault, vaultUsdc } = await createVault(e, "european", strike, expiry, { call: {} }, w);
    const writerPos = await deposit(e, vault, vaultUsdc, w, 1000);
    // EUROPEAN mint stores premium_per_contract = the arg (usdc(5)) — a real, >0 price.
    const m = await mint(e, vault, writerPos, w, 5, now, false);

    const buyer = e.h.payer === w ? (await import("@solana/web3.js")).Keypair.generate() : w;
    // Fund the buyer (SOL) + ensure a USDC ATA.
    const { fundWallet } = await import("./helpers");
    fundWallet(e.h.context, buyer);
    const buyerUsdcAta = await usdcAta(e, buyer.publicKey);
    const beforeUsdc = await bal(e, buyerUsdcAta);

    const { buyerOptionAta } = await purchase(e, vault, writerPos, m, vaultUsdc, buyer, 2);

    const optBal = await bal(e, buyerOptionAta);
    const afterUsdc = await bal(e, buyerUsdcAta);
    const rec: any = await e.opta.account.vaultMint.fetch(m.vaultMintRecord);
    console.log(`    1: optBal=${optBal} usdcPaid=${beforeUsdc - afterUsdc} quantitySold=${rec.quantitySold.toString()}`);
    assert.equal(optBal.toString(), "2", "buyer received 2 option tokens");
    assert.equal((beforeUsdc - afterUsdc).toString(), usdc(10).toString(), "buyer paid $10 (2 × $5)");
    assert.equal(rec.quantitySold.toString(), "2", "quantity_sold bumped to 2");
  });

  it("2 — $0 sentinel premium buy reverts InvalidPremium (6012), no USDC/token movement", async () => {
    const now = await getClockUnix(e.h.context);
    const strike = usdc(100);
    const expiry = new BN(now + 7 * 86_400 + 100); // distinct tuple → distinct vault PDA
    const w = e.h.payer;
    const { vault, vaultUsdc } = await createVault(e, "european", strike, expiry, { call: {} }, w);
    const writerPos = await deposit(e, vault, vaultUsdc, w, 1000);
    const m = await mint(e, vault, writerPos, w, 5, now + 1, false);

    // Account surgery: force VaultMint.premium_per_contract (u64 @ offset 104) to 0
    // — reproduces a $0 sentinel record that this path would otherwise sell for free.
    const acc = await e.h.context.banksClient.getAccount(m.vaultMintRecord);
    if (!acc) throw new Error("vault_mint_record not found");
    const data = Buffer.from(acc.data);
    data.writeBigUInt64LE(0n, 104);
    e.h.context.setAccount(m.vaultMintRecord, {
      lamports: acc.lamports, data, owner: acc.owner, executable: acc.executable, rentEpoch: Number(acc.rentEpoch),
    });
    const rec: any = await e.opta.account.vaultMint.fetch(m.vaultMintRecord);
    assert.equal(rec.premiumPerContract.toString(), "0", "premium forced to 0 for the test");

    const { Keypair } = await import("@solana/web3.js");
    const { fundWallet } = await import("./helpers");
    const buyer = Keypair.generate();
    fundWallet(e.h.context, buyer);
    const buyerUsdcAta = await usdcAta(e, buyer.publicKey);
    const beforeUsdc = await bal(e, buyerUsdcAta);

    let reverted = false, msg = "";
    try {
      await purchase(e, vault, writerPos, m, vaultUsdc, buyer, 1);
    } catch (err: any) {
      reverted = true;
      msg = String(err?.message ?? err);
    }
    const afterUsdc = await bal(e, buyerUsdcAta);
    console.log(`    2: reverted=${reverted} usdcDelta=${beforeUsdc - afterUsdc} msg=${msg.slice(0, 140)}`);
    assert.isTrue(reverted, "0-premium buy must revert");
    assert.isTrue(/6012|InvalidPremium/.test(msg), `revert must be InvalidPremium (6012); got: ${msg.slice(0, 200)}`);
    assert.equal((beforeUsdc - afterUsdc).toString(), "0", "no USDC moved on the reverted buy");
  });
});
