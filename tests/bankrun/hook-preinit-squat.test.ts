// =============================================================================
// tests/bankrun/hook-preinit-squat.test.ts — A-to-Z H-01 regression
// =============================================================================
// H-01: opta_transfer_hook.initialize_extra_account_meta_list took any payer and
// a NON-signer UncheckedAccount protocol_state. Option mints are deterministic
// PDAs, so an attacker could precompute a series/per-writer mint and pre-init its
// HookState directly — the legit create_series / mint_from_vault CPI then reverts
// on the already-initialized hook_state, and because the mint address is
// deterministic that series can NEVER be created (permanent grief).
//
// Fix: protocol_state is now a `Signer`, and both opta CPI call sites sign for
// their protocol_state PDA (new_with_signer + PROTOCOL_SEED). A direct user call
// cannot forge that signature.
//
//   attack A — direct call, attacker-key protocol_state (signed) → InvalidProtocolState
//   attack B — direct call, canonical protocol_state PDA UNSIGNED → sig failure
//   legit    — create_series on the SAME predicted mint still succeeds (unblocked)
//   legit    — mint_from_vault (per-writer mint) hook-init via CPI still succeeds
// =============================================================================

import fs from "fs";
import path from "path";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey, Keypair, SystemProgram, Transaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { assert } from "chai";
import { REPO_ROOT } from "./bootstrap";
import {
  setupEnv, createVault, deposit, createSeries, mint, usdcAta, actor, pda, exists,
  getClockUnix, HOOK_PROGRAM_ID, Env,
} from "./helpers";

const VAULT_OPTION_MINT_SEED = Buffer.from("vault_option_mint");
const HOOK_STATE_SEED = Buffer.from("hook-state");
const EXTRA_METAS_SEED = Buffer.from("extra-account-metas");

describe("hook pre-init squat guard (A-to-Z H-01)", function () {
  this.timeout(180_000);

  let e: Env;
  let hook: Program<any>;
  let attacker: Keypair;
  let predictedMint: PublicKey, predHookState: PublicKey, predExtraMetas: PublicKey;
  let expiry: BN;
  const strike = new BN(10_000_000); // $10

  before(async () => {
    e = await setupEnv("HSQUAT", "hsquat-feed", 100);
    attacker = actor(e);
    const hookIdl = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "target/idl/opta_transfer_hook.json"), "utf-8"));
    hook = new Program(hookIdl, e.h.provider) as Program<any>;

    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);

    // Predict the CANONICAL series mint for (market, $10, expiry, call, american)
    // — exactly the address create_series will use. option_type=0 (call),
    // exercise_style=1 (american).
    predictedMint = pda([
      VAULT_OPTION_MINT_SEED, e.market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([0]), Buffer.from([1]),
    ]);
    predHookState = pda([HOOK_STATE_SEED, predictedMint.toBuffer()], HOOK_PROGRAM_ID);
    predExtraMetas = pda([EXTRA_METAS_SEED, predictedMint.toBuffer()], HOOK_PROGRAM_ID);
  });

  async function directHookInit(protocolStateAcct: PublicKey, signers: Keypair[]) {
    const ix = await hook.methods.initializeExtraAccountMetaList(expiry).accountsStrict({
      payer: attacker.publicKey,
      mint: predictedMint,
      extraAccountMetaList: predExtraMetas,
      hookState: predHookState,
      protocolState: protocolStateAcct,
      systemProgram: SystemProgram.programId,
    }).instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = attacker.publicKey;
    tx.recentBlockhash = e.h.context.lastBlockhash;
    tx.sign(...signers);
    // A missing required signature (attack B: the PDA can't sign) can either come
    // back as a failed result or throw at the sig-verify boundary. Either way the
    // call is rejected — normalize both to a non-null result.
    try {
      const res = await e.h.context.banksClient.tryProcessTransaction(tx);
      return { result: res.result, logs: (res.meta?.logMessages ?? []).join("\n") };
    } catch (ex: any) {
      return { result: "threw", logs: String(ex) };
    }
  }

  it("attack A — attacker-key protocol_state (signed) reverts InvalidProtocolState", async () => {
    const r = await directHookInit(attacker.publicKey, [attacker]);
    assert.isNotNull(r.result, "direct hook init with a bogus protocol_state must fail");
    assert.isTrue(r.logs.includes("InvalidProtocolState"), "error = InvalidProtocolState (key check)");
    assert.isFalse(await exists(e, predHookState), "no hook_state created by the attack");
  });

  it("attack B — canonical protocol_state PDA UNSIGNED fails (Signer gate)", async () => {
    // The attacker passes the real protocol_state PDA but cannot sign for it (it
    // is opta's PDA). The Signer constraint rejects the missing signature.
    const r = await directHookInit(e.protocolState, [attacker]);
    assert.isNotNull(r.result, "unsigned canonical protocol_state must fail the Signer gate");
    assert.isFalse(await exists(e, predHookState), "still no hook_state created");
  });

  it("legit — create_series on the SAME predicted mint still succeeds (attack did not block it)", async () => {
    const s = await createSeries(e, strike, expiry, { call: {} });
    assert.isTrue(s.optionMint.equals(predictedMint), "created mint == the predicted/attacked address");
    assert.isTrue(await exists(e, predHookState), "hook_state now created by the legit CPI (new_with_signer)");
    assert.isTrue(await exists(e, predExtraMetas), "extra-account-metas created too");
  });

  it("legit — mint_from_vault (per-writer mint) hook-init via CPI still succeeds", async () => {
    const writer = actor(e);
    // Fund + American vault + deposit, then mint (exercises mint_from_vault's hook CPI).
    await usdcAta(e, writer.publicKey, 1_000_000_000_000n);
    const { vault, vaultUsdc } = await createVault(e, "american", strike, expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 5000);
    const now = await getClockUnix(e.h.context);
    const m: any = await mint(e, vault, wp, writer, 1, now + 111, true);
    const wHookState = pda([HOOK_STATE_SEED, m.optionMint.toBuffer()], HOOK_PROGRAM_ID);
    assert.isTrue(await exists(e, wHookState), "per-writer mint hook_state created via CPI new_with_signer");
  });
});
