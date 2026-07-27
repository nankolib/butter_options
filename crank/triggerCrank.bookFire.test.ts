// ============================================================================
// crank/triggerCrank.bookFire.test.ts — Phase B1 book-fire keeper helpers
// ============================================================================
// Vanilla TS + node:assert (same shape as triggerCrank.test.ts). Covers the PURE
// book-fire building blocks the Jul-31 flip will wire into the tick:
//   - selectBestAsk: cheapest ask ≤ max_premium, WriterAsk wins exact ties,
//     ResaleAsk only when strictly better-priced, zero-depth/over-budget rejected.
//   - assembleBookAccounts: the ten [21]-[30] optionals in BOOK_ACCOUNT_ROLES
//     order, kind-correct null pattern, PDAs matching the on-chain seeds.
// The assembler's key order is asserted against BOOK_ACCOUNT_ROLES so a struct
// reorder on EITHER side (keeper or execute_trigger.rs) breaks this test.
// ============================================================================

import assert from "node:assert/strict";
import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { Connection } from "@solana/web3.js";
import {
  selectBestAsk,
  assembleBookAccounts,
  assembleExecuteAccounts,
  buildExecuteTriggerIx,
  loadTriggerProgram,
  BOOK_ACCOUNT_ROLES,
  type BookAskView,
  type TriggerView,
} from "./triggerCrank";

// ---- Tiny runner (identical shape to triggerCrank.test.ts) -----------------
type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- Fixtures --------------------------------------------------------------
const usd = (n: number) => BigInt(Math.round(n * 1_000_000)); // USDC 6-dec
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_ID = Keypair.generate().publicKey; // stand-in for opta_transfer_hook::ID
const USDC = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const VAULT = Keypair.generate().publicKey;

function mkAsk(over: Partial<BookAskView> = {}): BookAskView {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    optionMint: MINT.toBase58(),
    vault: VAULT.toBase58(),
    kind: "writerAsk",
    pricePerContract: usd(5),
    quantityRemaining: 10n,
    ...over,
  };
}

// ---- selectBestAsk ---------------------------------------------------------
test("selectBestAsk: picks the cheapest ask within budget", () => {
  const cheap = mkAsk({ pricePerContract: usd(4) });
  const asks = [mkAsk({ pricePerContract: usd(7) }), cheap, mkAsk({ pricePerContract: usd(6) })];
  assert.equal(selectBestAsk(asks, usd(8))?.pubkey, cheap.pubkey);
});

test("selectBestAsk: every ask over max_premium → undefined (trigger stays armed)", () => {
  const asks = [mkAsk({ pricePerContract: usd(9) }), mkAsk({ pricePerContract: usd(12) })];
  assert.equal(selectBestAsk(asks, usd(8)), undefined);
});

test("selectBestAsk: an ask exactly at max_premium is eligible (≤, not <)", () => {
  const atMax = mkAsk({ pricePerContract: usd(8) });
  assert.equal(selectBestAsk([atMax], usd(8))?.pubkey, atMax.pubkey);
});

test("selectBestAsk: zero-depth asks are skipped", () => {
  const empty = mkAsk({ pricePerContract: usd(3), quantityRemaining: 0n });
  const real = mkAsk({ pricePerContract: usd(6) });
  assert.equal(selectBestAsk([empty, real], usd(8))?.pubkey, real.pubkey);
});

test("selectBestAsk: exact price tie → WriterAsk wins over ResaleAsk", () => {
  const resale = mkAsk({ kind: "resaleAsk", pricePerContract: usd(5) });
  const writer = mkAsk({ kind: "writerAsk", pricePerContract: usd(5) });
  // Order-independent: resale first, writer second.
  assert.equal(selectBestAsk([resale, writer], usd(8))?.kind, "writerAsk");
});

test("selectBestAsk: ResaleAsk STRICTLY cheaper than any writer ask → selected (secondary)", () => {
  const resale = mkAsk({ kind: "resaleAsk", pricePerContract: usd(4) });
  const writer = mkAsk({ kind: "writerAsk", pricePerContract: usd(5) });
  assert.equal(selectBestAsk([writer, resale], usd(8))?.kind, "resaleAsk");
});

test("selectBestAsk: empty list → undefined", () => {
  assert.equal(selectBestAsk([], usd(8)), undefined);
});

// ---- assembleBookAccounts: positional layout -------------------------------
test("assembleBookAccounts: key order is exactly BOOK_ACCOUNT_ROLES (matches [21]-[30])", () => {
  const acc = assembleBookAccounts(mkAsk(), USDC, PROGRAM_ID, HOOK_ID);
  assert.deepEqual(Object.keys(acc), [...BOOK_ACCOUNT_ROLES]);
});

test("assembleBookAccounts: WriterAsk → pot/position set, hook accounts null", () => {
  const ask = mkAsk({ kind: "writerAsk" });
  const acc = assembleBookAccounts(ask, USDC, PROGRAM_ID, HOOK_ID);

  // [21]-[24] always present.
  assert.equal((acc.book_order as PublicKey).toBase58(), ask.pubkey);
  assert.equal((acc.book_maker as PublicKey).toBase58(), ask.owner);
  const expEscrow = PublicKey.findProgramAddressSync(
    [Buffer.from("resting_order_escrow"), new PublicKey(ask.pubkey).toBuffer()], PROGRAM_ID)[0];
  assert.equal((acc.book_escrow as PublicKey).toBase58(), expEscrow.toBase58());
  assert.equal(
    (acc.book_maker_usdc as PublicKey).toBase58(),
    getAssociatedTokenAddressSync(USDC, new PublicKey(ask.owner), false, TOKEN_PROGRAM_ID).toBase58());

  // [25]-[27] set to the writer-ask PDAs.
  const expPot = PublicKey.findProgramAddressSync(
    [Buffer.from("writer_ask_pot"), MINT.toBuffer()], PROGRAM_ID)[0];
  const expPotUsdc = PublicKey.findProgramAddressSync(
    [Buffer.from("writer_ask_pot_usdc"), MINT.toBuffer()], PROGRAM_ID)[0];
  const expPos = PublicKey.findProgramAddressSync(
    [Buffer.from("writer_ask_position"), MINT.toBuffer(), new PublicKey(ask.owner).toBuffer()], PROGRAM_ID)[0];
  assert.equal((acc.writer_ask_pot as PublicKey).toBase58(), expPot.toBase58());
  assert.equal((acc.writer_ask_pot_usdc as PublicKey).toBase58(), expPotUsdc.toBase58());
  assert.equal((acc.writer_ask_position as PublicKey).toBase58(), expPos.toBase58());

  // [28]-[30] null on a writer-ask fire.
  assert.equal(acc.resale_hook_metas, null);
  assert.equal(acc.resale_hook_program, null);
  assert.equal(acc.resale_hook_state, null);
});

test("assembleBookAccounts: ResaleAsk → hook accounts set, pot/position null", () => {
  const ask = mkAsk({ kind: "resaleAsk" });
  const acc = assembleBookAccounts(ask, USDC, PROGRAM_ID, HOOK_ID);

  // [25]-[27] null on a resale fire.
  assert.equal(acc.writer_ask_pot, null);
  assert.equal(acc.writer_ask_pot_usdc, null);
  assert.equal(acc.writer_ask_position, null);

  // [28]-[30] set: metas + state are hook-program PDAs, program is the hook id.
  const expMetas = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), MINT.toBuffer()], HOOK_ID)[0];
  const expState = PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), MINT.toBuffer()], HOOK_ID)[0];
  assert.equal((acc.resale_hook_metas as PublicKey).toBase58(), expMetas.toBase58());
  assert.equal((acc.resale_hook_program as PublicKey).toBase58(), HOOK_ID.toBase58());
  assert.equal((acc.resale_hook_state as PublicKey).toBase58(), expState.toBase58());

  // The shared [21]-[24] slots are always populated (escrow seed is kind-agnostic).
  assert.ok(acc.book_order && acc.book_maker && acc.book_escrow && acc.book_maker_usdc);
});

test("BOOK_ACCOUNT_ROLES: exactly the ten [21]-[30] roles in struct order", () => {
  assert.deepEqual([...BOOK_ACCOUNT_ROLES], [
    "book_order", "book_maker", "book_escrow", "book_maker_usdc",
    "writer_ask_pot", "writer_ask_pot_usdc", "writer_ask_position",
    "resale_hook_metas", "resale_hook_program", "resale_hook_state",
  ]);
});

// ---- Peg-path ix builds against the NEW IDL (the live-keeper crash guard) ---
// After the program upgrade the crank IDL declares the ten book optionals, and
// accountsStrict requires EVERY declared account. assembleExecuteAccounts (peg
// path) must therefore pass them as null → Anchor emits the program-id sentinel
// → the on-chain arm reads book_order == None → vault peg. If a future edit drops
// those nulls, this test fails BEFORE the change reaches the VPS (where it would
// otherwise crash the keeper on every fire).
test("assembleExecuteAccounts (peg): executeTrigger ix builds with all 31 accounts vs new IDL", async () => {
  const dummyWallet = {
    publicKey: PROGRAM_ID,
    signTransaction: async (t: any) => t,
    signAllTransactions: async (t: any) => t,
  };
  const program = loadTriggerProgram(new Connection("http://127.0.0.1:8899"), dummyWallet as any);
  const view: TriggerView = {
    pubkey: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    market: Keypair.generate().publicKey.toBase58(),
    vault: VAULT.toBase58(),
    optionMint: MINT.toBase58(),
    holderOptionAta: Keypair.generate().publicKey.toBase58(),
    kind: "buy", comparator: "ge", thresholdUsdc: usd(100),
    quantity: 3n, maxPremiumPerContract: usd(5),
  };
  const accounts = assembleExecuteAccounts(
    view, MINT.toBuffer(), USDC, PROGRAM_ID, PublicKey.default, program.programId, null);
  // 21 base/SB roles + 10 book roles must all be present as null (or real).
  for (const role of BOOK_ACCOUNT_ROLES) {
    const camel = role.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    assert.ok(camel in accounts, `peg assembler must include ${camel} (null)`);
    assert.equal((accounts as any)[camel], null, `${camel} must be null on the peg path`);
  }
  const ix = await buildExecuteTriggerIx(program, accounts);
  // 31 = 18 base + 3 SB + 10 book; the ten book keys are the program-id sentinel.
  assert.equal(ix.keys.length, 31, "executeTrigger ix has all 31 accounts");
  const tail = ix.keys.slice(21).filter((k) => k.pubkey.equals(program.programId));
  assert.equal(tail.length, 10, "the ten book optionals are the program-id sentinel (None)");
});

// ---- Runner ----------------------------------------------------------------
async function main(): Promise<void> {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`✗ ${t.name}`);
      console.error(`  ${err}`);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error("test runner crashed:", err); process.exit(1); });
