// =============================================================================
// tests/bankrun/writer-ask-post.test.ts — Phase 3 Slice A: WriterAsk post path
// =============================================================================
// Covers the new post_order WriterAsk arm (lock-at-post personal collateral) on
// an AMERICAN series vault. Runs under the `testing` build (WRITER_ASKS_ENABLED
// = true → dark gate open) used by `npm run test:bankrun`.
//
// Asserts:
//   (i)  the per-order USDC escrow holds EXACTLY cpt × quantity, where
//        cpt = required_collateral_per_contract(strike, type) = strike (1×).
//   (ii) order.collateral_per_contract == cpt on the stored RestingOrder,
//        kind == WriterAsk, and the OrderPosted tape carries kind u8 = 2.
//
// (iii) — the feature-free build rejecting the same post with 6054 — is covered
// by tests/bankrun/writer-ask-dark-gate.test.ts (run against a feature-free .so)
// and the deterministic feature_flags.rs unit test. A single compiled artifact
// cannot exercise both the open and closed dark-gate paths.
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
  setupEnv, createVault, createSeries, usdcAta, bal, actor, pda, getClockUnix,
  HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK = { writerAsk: {} };

describe("writer-ask post (Phase 3 Slice A — lock-at-post personal collateral)", function () {
  this.timeout(120_000);

  let e: Env;
  let writer: Keypair;
  let vault: PublicKey;
  let optionMint: PublicKey;
  let vaultMintRecord: PublicKey, extraMetas: PublicKey, hookState: PublicKey;
  let strike: BN, expiry: BN;
  let nonceCtr = 700;
  const nextNonce = () => new BN(nonceCtr++);

  function deriveOrder(owner: PublicKey, nonce: BN) {
    const order = pda([RESTING_ORDER_SEED, optionMint.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]);
    return { order, escrow };
  }

  function decodeEvents(logs: string[]): { name: string; data: any }[] {
    const out: { name: string; data: any }[] = [];
    for (const line of logs ?? []) {
      if (!line.startsWith("Program data: ")) continue;
      try {
        const d = (e.opta.coder as any).events.decode(line.slice("Program data: ".length));
        if (d) out.push(d);
      } catch { /* non-event line */ }
    }
    return out;
  }

  async function postWriterAsk(owner: Keypair, price: BN, qty: number, nonce: BN, expectError = false) {
    const { order, escrow } = deriveOrder(owner.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    // owner_option_account is unused on the WriterAsk branch (UncheckedAccount).
    const ownerOpt = getAssociatedTokenAddressSync(optionMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.postOrder(WRITER_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: owner.publicKey, sharedVault: vault, market: e.market, vaultMintRecord,
      optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = e.h.context.lastBlockhash;
    tx.sign(owner);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    const logs = (res.meta?.logMessages ?? []) as string[];
    if (!expectError && res.result) throw new Error("post failed: " + JSON.stringify(res.result) + "\n" + logs.join("\n"));
    return { order, escrow, result: res.result, logs, events: decodeEvents(logs) };
  }

  before(async () => {
    e = await setupEnv("WAPOST", "wa-post-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 100_000_000_000n);

    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);
    strike = usdc(10); // cpt = 1× strike = 10_000_000 micro-USDC / contract

    // American vault so the WriterAsk arm's American-only gate (D12) passes.
    const cv = await createVault(e, "american", strike, expiry, { call: {} }, writer);
    vault = cv.vault;

    // D2.5: writer-asks must rest on the CANONICAL create_series mint (the pin
    // rejects per-writer mint_from_vault mints). create_series gives the valid
    // VaultMint record (writer-sentinel == default) + hook state the post needs.
    const m: any = await createSeries(e, strike, expiry, { call: {} });
    optionMint = m.optionMint;
    vaultMintRecord = m.vaultMintRecord;
    extraMetas = m.extraMetas;
    hookState = m.hookState;
  });

  it("(i)+(ii) — WriterAsk escrows cpt×qty USDC and stamps collateral_per_contract", async () => {
    const qty = 3;
    const price = usdc(7); // maker-set ask price (independent of collateral)
    const nonce = nextNonce();
    const r = await postWriterAsk(writer, price, qty, nonce);
    assert.isNull(r.result, "WriterAsk post succeeded on American vault (testing build)");

    const cpt = strike; // required_collateral_per_contract = strike (1×)
    const expectedEscrow = cpt.muln(qty);

    // (i) per-order USDC escrow holds exactly cpt × quantity.
    assert.equal((await bal(e, r.escrow)).toString(), expectedEscrow.toString(),
      "per-order escrow holds cpt × quantity USDC");

    // (ii) the order carries collateral_per_contract == cpt, kind == WriterAsk.
    const acc: any = await (e.opta.account as any).restingOrder.fetch(r.order);
    assert.equal(acc.collateralPerContract.toString(), cpt.toString(), "collateral_per_contract == cpt");
    assert.equal(acc.pricePerContract.toString(), price.toString(), "maker-set price stored");
    assert.equal(acc.quantityInitial.toString(), qty.toString());
    assert.equal(acc.quantityRemaining.toString(), qty.toString());
    assert.ok("writerAsk" in acc.kind, "kind = WriterAsk");

    // OrderPosted tape carries kind u8 = 2 (WriterAsk).
    const ev = r.events.find((x) => x.name === "orderPosted");
    assert.ok(ev, "OrderPosted emitted");
    assert.equal(ev!.data.kind, 2, "OrderPosted.kind u8 = WriterAsk");
  });

  it("(ii-neg) — WriterAsk reverts when writer USDC < cpt × quantity (InsufficientCollateral)", async () => {
    const poor = actor(e);
    // Fund the poor writer with 15 USDC — LESS than cpt × qty (cpt=10, qty=2 → need 20).
    await usdcAta(e, poor.publicKey, 15_000_000n);
    const r = await postWriterAsk(poor, usdc(7), 2, nextNonce(), true);
    assert.isNotNull(r.result, "underfunded WriterAsk must fail");
    assert.isTrue(r.logs.join("\n").includes("InsufficientCollateral"), "error = InsufficientCollateral");
  });
});
