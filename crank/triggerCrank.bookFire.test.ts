// ============================================================================
// crank/triggerCrank.bookFire.test.ts — Phase B1 book-fire keeper helpers
// ============================================================================
// Vanilla TS + node:assert (same shape as triggerCrank.test.ts). Covers the PURE
// book-fire building blocks the Jul-31 flip will wire into the tick:
//   - selectBestAsk: cheapest ask ≤ max_premium, WriterAsk wins exact ties,
//     ResaleAsk only when strictly better-priced, zero-depth/over-budget rejected.
//   - assembleBookAccounts / assembleBidAccounts: the eleven [21]-[31] optionals
//     order, kind-correct null pattern, PDAs matching the on-chain seeds.
// The assembler's key order is asserted against BOOK_ACCOUNT_ROLES so a struct
// reorder on EITHER side (keeper or execute_trigger.rs) breaks this test.
// ============================================================================

import assert from "node:assert/strict";
import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { Connection } from "@solana/web3.js";
import {
  selectBestAsk,
  selectBestBid,
  classifySellRoute,
  assembleBookAccounts,
  assembleBidAccounts,
  assembleExecuteAccounts,
  bookAccountsForBuy,
  classifyFireError,
  buildExecuteTriggerIx,
  loadTriggerProgram,
  BOOK_ACCOUNT_ROLES,
  type BookAskView,
  type BookBidView,
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
  assert.equal(acc.book_hook_metas, null);
  assert.equal(acc.book_hook_program, null);
  assert.equal(acc.book_hook_state, null);
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
  assert.equal((acc.book_hook_metas as PublicKey).toBase58(), expMetas.toBase58());
  assert.equal((acc.book_hook_program as PublicKey).toBase58(), HOOK_ID.toBase58());
  assert.equal((acc.book_hook_state as PublicKey).toBase58(), expState.toBase58());

  // The shared [21]-[24] slots are always populated (escrow seed is kind-agnostic).
  assert.ok(acc.book_order && acc.book_maker && acc.book_escrow && acc.book_maker_usdc);
});

test("BOOK_ACCOUNT_ROLES: exactly the eleven [21]-[31] roles in struct order", () => {
  assert.deepEqual([...BOOK_ACCOUNT_ROLES], [
    "book_order", "book_maker", "book_escrow", "book_maker_usdc",
    "writer_ask_pot", "writer_ask_pot_usdc", "writer_ask_position",
    "book_hook_metas", "book_hook_program", "book_hook_state",
    "book_maker_option",
  ]);
});

// ---- B2: selectBestBid / assembleBidAccounts / classifySellRoute -----------
function mkBid(over: Partial<BookBidView> = {}): BookBidView {
  return {
    pubkey: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    optionMint: MINT.toBase58(),
    vault: VAULT.toBase58(),
    pricePerContract: usd(5),
    quantityRemaining: 10n,
    ...over,
  };
}

test("selectBestBid: picks the HIGHEST bid at or above the floor", () => {
  const low = mkBid({ pricePerContract: usd(4) });
  const high = mkBid({ pricePerContract: usd(9) });
  const mid = mkBid({ pricePerContract: usd(6) });
  assert.equal(selectBestBid([low, high, mid], usd(3))?.pubkey, high.pubkey);
});

test("selectBestBid: bids below the floor are never selected", () => {
  const under = mkBid({ pricePerContract: usd(2) });
  assert.equal(selectBestBid([under], usd(5)), undefined);
  // …and the floor is inclusive.
  const exact = mkBid({ pricePerContract: usd(5) });
  assert.equal(selectBestBid([exact], usd(5))?.pubkey, exact.pubkey);
});

test("selectBestBid: zero-depth bids are skipped even when best-priced", () => {
  const empty = mkBid({ pricePerContract: usd(9), quantityRemaining: 0n });
  const real = mkBid({ pricePerContract: usd(6) });
  assert.equal(selectBestBid([empty, real], usd(1))?.pubkey, real.pubkey);
});

test("selectBestBid: floor 0 is BOOK INELIGIBLE — never selects (6082 on-chain)", () => {
  // Every pre-B2 sell trigger stored max_premium 0. The keeper must not hand any
  // of them a bid, or the on-chain arm would reject with SellFloorRequired.
  assert.equal(selectBestBid([mkBid({ pricePerContract: usd(9) })], 0n), undefined);
});

test("selectBestBid: empty book → undefined (the steady state, not an error)", () => {
  assert.equal(selectBestBid([], usd(5)), undefined);
});

test("assembleBidAccounts: [21]-[23]+[28]-[31] set, [24]-[27] null, roles ordered", () => {
  const bid = mkBid();
  const acc = assembleBidAccounts(bid, PROGRAM_ID, HOOK_ID);
  // Key ORDER must equal the on-chain struct order.
  assert.deepEqual(Object.keys(acc), [...BOOK_ACCOUNT_ROLES]);
  // [21]-[23]
  assert.equal(acc.book_order!.toBase58(), bid.pubkey);
  assert.equal(acc.book_maker!.toBase58(), bid.owner);
  assert.equal(
    acc.book_escrow!.toBase58(),
    PublicKey.findProgramAddressSync(
      [Buffer.from("resting_order_escrow"), new PublicKey(bid.pubkey).toBuffer()], PROGRAM_ID)[0].toBase58(),
    "book_escrow is the per-order PDA the program re-derives");
  // [24]-[27] are ask-only on a sell.
  assert.equal(acc.book_maker_usdc, null, "a sell pays owner_usdc_account, not the maker");
  assert.equal(acc.writer_ask_pot, null);
  assert.equal(acc.writer_ask_pot_usdc, null);
  assert.equal(acc.writer_ask_position, null);
  // [28]-[30] shared hook triad — required, the option leg dispatches the hook.
  assert.equal(acc.book_hook_program!.toBase58(), HOOK_ID.toBase58());
  assert.ok(acc.book_hook_metas, "hook metas required on a sell");
  assert.ok(acc.book_hook_state, "hook state required on a sell");
  // [31] destination = the BIDDER's option ATA, exactly what the program pins to.
  assert.equal(
    acc.book_maker_option!.toBase58(),
    getAssociatedTokenAddressSync(MINT, new PublicKey(bid.owner), false, TOKEN_2022_PROGRAM_ID).toBase58(),
    "book_maker_option is the maker's Token-2022 ATA on (bid.owner, option_mint)");
});

test("assembleBidAccounts: buy assembler leaves [31] null (shapes stay disjoint)", () => {
  const acc = assembleBookAccounts(mkAsk(), USDC, PROGRAM_ID, HOOK_ID);
  assert.equal(acc.book_maker_option, null, "a buy never populates the sell delivery slot");
});

test("classifySellRoute: floor 0 → TP falls back to the vault, SL is book-ineligible", () => {
  const bids = [mkBid({ pricePerContract: usd(9) })];
  assert.deepEqual(classifySellRoute("takeProfitSell", 0n, bids), { route: "vault" });
  assert.deepEqual(classifySellRoute("stopLossSell", 0n, bids), {
    route: "skip", reason: "book_ineligible",
  });
});

test("classifySellRoute: skip-until-bid — empty book is a QUIET skip, not an error", () => {
  // The live bid side is empty by design, so this is what every StopLossSell
  // returns on every tick until writer bids ship.
  assert.deepEqual(classifySellRoute("stopLossSell", usd(5), []), {
    route: "skip", reason: "no_crossing_bid",
  });
  // Same when bids exist but all price under the owner's floor.
  assert.deepEqual(classifySellRoute("stopLossSell", usd(5), [mkBid({ pricePerContract: usd(2) })]), {
    route: "skip", reason: "no_crossing_bid",
  });
  // A TakeProfitSell still has somewhere to go.
  assert.deepEqual(classifySellRoute("takeProfitSell", usd(5), []), { route: "vault" });
});

test("classifySellRoute: a crossing bid routes to the book for BOTH sell kinds", () => {
  const best = mkBid({ pricePerContract: usd(8) });
  const bids = [mkBid({ pricePerContract: usd(6) }), best];
  for (const k of ["takeProfitSell", "stopLossSell"] as const) {
    const r = classifySellRoute(k, usd(5), bids);
    assert.equal(r.route, "book", `${k} routes to the book`);
    assert.equal((r as any).bid.pubkey, best.pubkey, `${k} takes the best bid`);
  }
});

// ---- Peg-path ix builds against the NEW IDL (the live-keeper crash guard) ---
// After the program upgrade the crank IDL declares the eleven book optionals, and
// accountsStrict requires EVERY declared account. assembleExecuteAccounts (peg
// path) must therefore pass them as null → Anchor emits the program-id sentinel
// → the on-chain arm reads book_order == None → vault peg. If a future edit drops
// those nulls, this test fails BEFORE the change reaches the VPS (where it would
// otherwise crash the keeper on every fire).
test("assembleExecuteAccounts (peg): executeTrigger ix builds with all 33 accounts vs new IDL", async () => {
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
  // 21 base/SB roles + 11 book roles must all be present as null (or real).
  for (const role of BOOK_ACCOUNT_ROLES) {
    const camel = role.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    assert.ok(camel in accounts, `peg assembler must include ${camel} (null)`);
    assert.equal((accounts as any)[camel], null, `${camel} must be null on the peg path`);
  }
  const ix = await buildExecuteTriggerIx(program, accounts);
  // 33 = 18 base + 3 SB + 11 book + 1 oco_peer. The slice is BOUNDED at 32 on
  // purpose: 2A appended oco_peer, and an unbounded slice(21) would sweep it in
  // and count twelve sentinels against an assertion that means "the ELEVEN book
  // optionals". Bounding keeps this test about the book tail and lets [32] be
  // asserted for what it is.
  assert.equal(ix.keys.length, 33, "executeTrigger ix has all 33 accounts (2A appended oco_peer at [32])");
  const tail = ix.keys.slice(21, 32).filter((k) => k.pubkey.equals(program.programId));
  assert.equal(tail.length, 11, "the eleven book optionals are the program-id sentinel (None)");
  assert.ok(ix.keys[32].pubkey.equals(program.programId),
    "[32] oco_peer is the sentinel on an unpaired trigger");
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

// ============================================================================
// B1.5 — keeper book discovery wired into the fire path
// ============================================================================
// These are the gates that make the flip meaningful: before B1.5 the assembler
// hardcoded all eleven optionals to null, so BOOK_TRIGGERS_ENABLED could never
// be reached on-chain (routing is `flag && book_order.is_some()`).

const BUY_VIEW: TriggerView = {
  pubkey: Keypair.generate().publicKey.toBase58(),
  owner: Keypair.generate().publicKey.toBase58(),
  market: Keypair.generate().publicKey.toBase58(),
  vault: VAULT.toBase58(),
  optionMint: MINT.toBase58(),
  holderOptionAta: Keypair.generate().publicKey.toBase58(),
  kind: "buy", comparator: "ge", thresholdUsdc: usd(100),
  quantity: 3n, maxPremiumPerContract: usd(5),
};

function mkProgram() {
  const dummyWallet = {
    publicKey: PROGRAM_ID,
    signTransaction: async (t: any) => t,
    signAllTransactions: async (t: any) => t,
  };
  return loadTriggerProgram(new Connection("http://127.0.0.1:8899"), dummyWallet as any);
}

test("B1.5 gate A: WriterAsk selection puts REAL keys at [21]-[27], sentinels elsewhere", async () => {
  const program = mkProgram();
  const ask = mkAsk({ kind: "writerAsk", pricePerContract: usd(4), quantityRemaining: 10n });
  const book = bookAccountsForBuy([ask], usd(5), USDC, PROGRAM_ID, HOOK_ID);
  assert.ok(book, "an ask within budget must produce book accounts");

  const accounts = assembleExecuteAccounts(
    BUY_VIEW, MINT.toBuffer(), USDC, PROGRAM_ID, PublicKey.default, program.programId, null, book);
  const ix = await buildExecuteTriggerIx(program, accounts);
  assert.equal(ix.keys.length, 33, "33 accounts on the wire (2A appended oco_peer at [32])");

  const tail = ix.keys.slice(21);                       // [21]..[31]
  const sentinel = (i: number) => tail[i].pubkey.equals(program.programId);
  // [21]-[24] + [25]-[27] carry real keys on a WriterAsk fire.
  for (const i of [0, 1, 2, 3, 4, 5, 6]) {
    assert.ok(!sentinel(i), `slot [${21 + i}] must be a REAL key on a WriterAsk fire`);
  }
  // [28]-[31] stay sentinel: no hook triad on a writer ask, no sell destination.
  for (const i of [7, 8, 9, 10]) {
    assert.ok(sentinel(i), `slot [${21 + i}] must remain the program-id sentinel`);
  }
  // The order key really is the ask we selected — not some other slot's value.
  assert.equal(tail[0].pubkey.toBase58(), ask.pubkey, "[21] is the selected ask");
  assert.equal(tail[1].pubkey.toBase58(), ask.owner, "[22] is the ask maker");
});

test("B1.5 gate B: no eligible ask → all ELEVEN stay null (peg fallback regression)", async () => {
  const program = mkProgram();
  // Three ways to have nothing to lift; each must leave the wire untouched.
  const cases: [string, ReturnType<typeof bookAccountsForBuy>][] = [
    ["empty book", bookAccountsForBuy([], usd(5), USDC, PROGRAM_ID, HOOK_ID)],
    ["all over budget", bookAccountsForBuy([mkAsk({ pricePerContract: usd(9) })], usd(5), USDC, PROGRAM_ID, HOOK_ID)],
    ["zero depth", bookAccountsForBuy([mkAsk({ quantityRemaining: 0n })], usd(5), USDC, PROGRAM_ID, HOOK_ID)],
  ];
  for (const [label, book] of cases) {
    assert.equal(book, null, `${label} must yield no book accounts`);
    const accounts = assembleExecuteAccounts(
      BUY_VIEW, MINT.toBuffer(), USDC, PROGRAM_ID, PublicKey.default, program.programId, null, book);
    for (const role of BOOK_ACCOUNT_ROLES) {
      const camel = role.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
      assert.equal((accounts as any)[camel], null, `${label}: ${camel} must be null`);
    }
    const ix = await buildExecuteTriggerIx(program, accounts);
    // Bounded at 32: [32] is oco_peer, not a book optional. See the note above.
    const tail = ix.keys.slice(21, 32).filter((k) => k.pubkey.equals(program.programId));
    assert.equal(tail.length, 11, `${label}: all eleven optionals are the sentinel → vault-peg fallback`);
  }
});

test("B1.5 gate C: simulate-gate INHERITANCE — a Custom error on a book fire is terminal", () => {
  // Not assumed: the send path's simulate-gate classifies a program rejection as
  // terminal (stop this tick) and everything else as retryable. A book fire goes
  // through the SAME gate, so a 6080 AskPriceExceedsMax must not be retried in a
  // loop against a fresh quote.
  const custom6080 = { InstructionError: [1, { Custom: 6080 }] };
  assert.equal(classifyFireError(custom6080), "terminal", "6080 on a book fire is terminal");
  assert.equal(classifyFireError({ err: { InstructionError: [1, { Custom: 6070 }] } }), "terminal",
    "NotAWriterAsk is terminal too");
  // Transport/gateway problems still retry with a fresh quote.
  assert.equal(classifyFireError(new Error("fetch failed")), "retryable");
  assert.equal(classifyFireError({ BlockhashNotFound: {} }), "retryable");
});

test("B1.5 gate D: discovery drops Bids and zero-depth, keeps both ask kinds", () => {
  // selectBestAsk is the consumer; enumerateAsksForMint must never hand it a Bid
  // (a StopEntryBuy lifts asks only) nor a zero-depth order.
  const writer = mkAsk({ kind: "writerAsk", pricePerContract: usd(6) });
  const resale = mkAsk({ kind: "resaleAsk", pricePerContract: usd(4) });
  const chosen = bookAccountsForBuy([writer, resale], usd(8), USDC, PROGRAM_ID, HOOK_ID);
  assert.ok(chosen, "a cheaper resale within budget is selectable");
  assert.equal(chosen!.book_order!.toBase58(), resale.pubkey, "strictly-cheaper resale wins");
  // …and its hook triad is populated while pot/position stay null.
  assert.equal(chosen!.writer_ask_pot, null);
  assert.ok(chosen!.book_hook_metas && chosen!.book_hook_program && chosen!.book_hook_state);
});
