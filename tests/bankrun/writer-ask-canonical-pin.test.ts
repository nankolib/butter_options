// =============================================================================
// tests/bankrun/writer-ask-canonical-pin.test.ts — Phase 3 Slice D2.5
// =============================================================================
// Proves the canonical-mint pin: a WriterAsk may ONLY rest on a create_series
// canonical mint (VaultMint.writer == default). A per-writer mint_from_vault mint
// (writer == the minter) is rejected with CanonicalMintRequired — closing the
// gap where such a writer-ask's pot would be unreconcilable on the void path (D3).
//
//   1  GAP CLOSED: post WriterAsk on a per-writer mint → CanonicalMintRequired;
//      the same post on a create_series canonical mint → succeeds.
//   2  Bid unaffected: a Bid on the per-writer mint still posts (the pin lives
//      inside the WriterAsk arm only). Full Bid/ResaleAsk byte-identity is carried
//      by exchange-book.test.ts (untouched by the pin).
//
// fill_writer_ask MIRROR — untestable via the public API: post_order is now the
// SOLE creator of WriterAsk orders and it pins canonical, so no non-canonical
// WriterAsk order can exist to fill. Fabricating one via setAccount means
// hand-crafting a RestingOrder + escrow + pot byte-layout — a brittle test of the
// harness, not the system. The mirror require! (defense-in-depth vs a hypothetical
// pre-fix order, of which devnet has none — the gate's always been false) is
// carried by the audit. (Decision per the D2.5 greenlight: drop the brittle synthetic.)
//
// Testing build (WRITER_ASKS_ENABLED + AMERICAN_ENABLED true). cpt = strike = $10.
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, createSeries, usdcAta, bal, actor, pda, getClockUnix,
  HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK = { writerAsk: {} };
const BID = { bid: {} };

describe("writer-ask canonical-mint pin (Phase 3 Slice D2.5)", function () {
  this.timeout(180_000);

  let e: Env;
  let writer: Keypair, vault: PublicKey, strike: BN, expiry: BN;
  let perWriter: any;   // mint_from_vault mint (writer == the minter → rejected)
  let canonical: any;   // create_series mint (writer == default → accepted)
  let nonceCtr = 970;
  const nextNonce = () => new BN(nonceCtr++);

  async function postOrder(kind: any, m: any, owner: Keypair, price: BN, qty: number, nonce: BN, expectError = false) {
    const order = pda([RESTING_ORDER_SEED, m.optionMint.toBuffer(), owner.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.optionMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.postOrder(kind, price, new BN(qty), nonce).accountsStrict({
      owner: owner.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = owner.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(owner);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    const logs = (res.meta?.logMessages ?? []) as string[];
    if (!expectError && res.result) throw new Error("post failed: " + JSON.stringify(res.result) + "\n" + logs.join("\n"));
    return { order, escrow, result: res.result, logs };
  }

  before(async () => {
    e = await setupEnv("WAPIN", "wa-pin-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 100_000_000_000n);
    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);
    strike = usdc(10);
    const cv = await createVault(e, "american", strike, expiry, { call: {} }, writer);
    vault = cv.vault;
    // Per-writer mint (mint_from_vault → record.writer = writer) + canonical
    // mint (create_series → record.writer = default), BOTH for the same vault.
    const wp = await deposit(e, vault, cv.vaultUsdc, writer, 50_000);
    perWriter = await mint(e, vault, wp, writer, 5, now, true);
    canonical = await createSeries(e, strike, expiry, { call: {} });
  });

  it("1 — GAP CLOSED: WriterAsk on a per-writer mint REJECTED (CanonicalMintRequired); on a canonical mint SUCCEEDS", async () => {
    // Per-writer mint → rejected.
    const bad = await postOrder(WRITER_ASK, perWriter, writer, usdc(7), 3, nextNonce(), true);
    assert.isNotNull(bad.result, "WriterAsk on a per-writer mint must fail");
    assert.isTrue(bad.logs.join("\n").includes("CanonicalMintRequired"), "error = CanonicalMintRequired");

    // Canonical mint → succeeds, escrow funded cpt×qty.
    const good = await postOrder(WRITER_ASK, canonical, writer, usdc(7), 3, nextNonce());
    assert.isNull(good.result, "WriterAsk on a canonical mint succeeds");
    assert.equal((await bal(e, good.escrow)).toString(), strike.muln(3).toString(), "escrow seeded cpt×3 on the canonical mint");
  });

  it("2 — Bid unaffected by the pin: a Bid on the per-writer mint still posts (pin is WriterAsk-arm-only)", async () => {
    const r = await postOrder(BID, perWriter, writer, usdc(2), 4, nextNonce());
    assert.isNull(r.result, "Bid on the per-writer mint posts (the canonical pin does not touch the Bid arm)");
    assert.equal((await bal(e, r.escrow)).toString(), usdc(2).muln(4).toString(), "bid escrow holds price×qty USDC");
  });
});
