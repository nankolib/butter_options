// ============================================================================
// crank/triggerCrank.alt.test.ts — B1.6 ALT gates
// ============================================================================
//   run: npx ts-node --transpile-only -r tsconfig-paths/register triggerCrank.alt.test.ts
// Pure: an in-memory fixture ALT, no RPC.
//
// Gate 1 is deliberately TWO-DIRECTIONAL. A size assertion that only checked
// "the ALT build is under the limit" would pass even if the ALT did nothing, so
// it also asserts the LEGACY build is OVER — the gate must be able to see a
// nonzero signal before its green means anything.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount, PublicKey, Keypair, ComputeBudgetProgram,
  TransactionMessage, VersionedTransaction, Transaction, SystemProgram, Connection,
  SYSVAR_SLOT_HASHES_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  assembleExecuteAccounts, bookAccountsForBuy, buildExecuteTriggerIx,
  loadTriggerProgram, SB_ON_DEMAND_QUEUE, loadTriggerAlt,
  type BookAskView, type TriggerView,
} from "./triggerCrank";

const TX_LIMIT = 1232;
const ED25519_BYTES = 320; // SB managed quote, numSignatures: 2
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const USDC = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");
const MINT = Keypair.generate().publicKey;
const VAULT = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;
const pda = (s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];

const STATIC_SET = [
  pda([Buffer.from("protocol_v2")]), pda([Buffer.from("treasury_v2")]),
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SystemProgram.programId,
  SB_ON_DEMAND_QUEUE, SYSVAR_SLOT_HASHES_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, HOOK,
];

function fixtureAlt(addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: PAYER, addresses,
    },
  });
}

const view: TriggerView = {
  pubkey: Keypair.generate().publicKey.toBase58(), owner: PAYER.toBase58(),
  market: MARKET.toBase58(), vault: VAULT.toBase58(), optionMint: MINT.toBase58(),
  holderOptionAta: Keypair.generate().publicKey.toBase58(),
  kind: "buy", comparator: "ge", thresholdUsdc: 979650n, quantity: 1n, maxPremiumPerContract: 20000n,
};
const ask: BookAskView = {
  pubkey: Keypair.generate().publicKey.toBase58(), owner: Keypair.generate().publicKey.toBase58(),
  optionMint: MINT.toBase58(), vault: VAULT.toBase58(), kind: "writerAsk",
  pricePerContract: 6093n, quantityRemaining: 2066n,
};

function program() {
  const w = { publicKey: PROGRAM_ID, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
  return loadTriggerProgram(new Connection("http://127.0.0.1:8899"), w as any);
}

async function sizes(book: Record<string, PublicKey | null> | null, alt: AddressLookupTableAccount | null) {
  const p = program();
  const accounts = assembleExecuteAccounts(
    view, MINT.toBuffer(), USDC, PAYER, PublicKey.default, p.programId,
    { queue: SB_ON_DEMAND_QUEUE }, book);
  const ix = await buildExecuteTriggerIx(p, accounts);
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  let legacy = 99999;
  try {
    legacy = new Transaction({ feePayer: PAYER, recentBlockhash: "11111111111111111111111111111111" })
      .add(cu).add(ix).serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch { /* legacy overrun — keep the sentinel */ }
  const msg = new TransactionMessage({
    payerKey: PAYER, recentBlockhash: "11111111111111111111111111111111", instructions: [cu, ix],
  }).compileToV0Message(alt ? [alt] : []);
  return { legacy, v0: new VersionedTransaction(msg).serialize().length, msg, accounts };
}

// ---- GATE 1: size, TWO-DIRECTIONAL -----------------------------------------
test("B1.6 gate 1: legacy BOOK fire is OVER the limit (the signal this gate must see)", async () => {
  const p = program();
  const book = bookAccountsForBuy([ask], 20000n, USDC, p.programId, HOOK)!;
  const { legacy } = await sizes(book, null);
  assert.ok(legacy + ED25519_BYTES > TX_LIMIT,
    `legacy book+ed25519 must EXCEED ${TX_LIMIT} or this gate is vacuous (got ${legacy + ED25519_BYTES})`);
});

test("B1.6 gate 1: ALT book fire fits on BOTH tapes (SB carries the ed25519 quote)", async () => {
  const p = program();
  const alt = fixtureAlt(STATIC_SET);
  const book = bookAccountsForBuy([ask], 20000n, USDC, p.programId, HOOK)!;
  const b = await sizes(book, alt);
  assert.ok(b.v0 + ED25519_BYTES < TX_LIMIT, `SB book fire must fit (got ${b.v0 + ED25519_BYTES})`);
  assert.ok(b.v0 < TX_LIMIT, `Pyth book fire must fit (got ${b.v0})`);
  assert.ok(b.v0 < b.legacy, "the ALT must actually shrink the tx");
});

// ---- GATE 2: peg regression -------------------------------------------------
test("B1.6 gate 2: peg account SET is identical with and without the ALT", async () => {
  const withAlt = await sizes(null, fixtureAlt(STATIC_SET));
  const without = await sizes(null, null);
  assert.deepEqual(Object.keys(withAlt.accounts), Object.keys(without.accounts), "same account roles");
  for (const k of Object.keys(without.accounts)) {
    const a = (withAlt.accounts as any)[k];
    const b = (without.accounts as any)[k];
    assert.equal(a === null ? null : a.toBase58(), b === null ? null : b.toBase58(), `${k} diverged`);
  }
  assert.ok(withAlt.v0 < without.legacy, "the ALT shrinks the peg fire too");
});

// ---- GATE 3: resolution correctness + loud missing entry --------------------
test("B1.6 gate 3: every ALT-resolved key equals the non-ALT key (no silent substitution)", async () => {
  const alt = fixtureAlt(STATIC_SET);
  const withAlt = await sizes(null, alt);
  const without = await sizes(null, null);
  const resolved = [
    ...withAlt.msg.staticAccountKeys.map((k) => k.toBase58()),
    ...withAlt.msg.addressTableLookups.flatMap((l) =>
      [...l.writableIndexes, ...l.readonlyIndexes].map((i) => alt.state.addresses[i].toBase58())),
  ].sort();
  const plain = without.msg.staticAccountKeys.map((k) => k.toBase58()).sort();
  assert.deepEqual(resolved, plain, "ALT-resolved key set must equal the legacy key set exactly");
});

test("B1.6 gate 3: a table missing the cluster's SB queue is REJECTED at boot", async () => {
  const wrong: any = {
    getAddressLookupTable: async () => ({
      value: { state: { addresses: STATIC_SET.filter((a) => !a.equals(SB_ON_DEMAND_QUEUE)) } },
    }),
  };
  await assert.rejects(
    () => loadTriggerAlt(wrong, PROGRAM_ID.toBase58(), SB_ON_DEMAND_QUEUE),
    /does not contain the expected SB queue/,
    "a wrong-cluster table must fail at boot, not at fire time",
  );
  const missing: any = { getAddressLookupTable: async () => ({ value: null }) };
  await assert.rejects(
    () => loadTriggerAlt(missing, PROGRAM_ID.toBase58(), SB_ON_DEMAND_QUEUE), /not found/);
});

// ---- GATE 4: fallback -------------------------------------------------------
test("B1.6 gate 4: no ALT → peg still encodes legacy; the BOOK fire is what cannot", async () => {
  const peg = await sizes(null, null);
  assert.ok(peg.legacy + ED25519_BYTES < TX_LIMIT,
    `peg must still fit without an ALT (got ${peg.legacy + ED25519_BYTES})`);
  const p = program();
  const book = bookAccountsForBuy([ask], 20000n, USDC, p.programId, HOOK)!;
  const bk = await sizes(book, null);
  assert.ok(bk.legacy + ED25519_BYTES > TX_LIMIT,
    "book without an ALT must NOT fit — which is why the send path refuses loudly");
});
