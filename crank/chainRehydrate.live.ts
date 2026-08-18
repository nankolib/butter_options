// =============================================================================
// chainRehydrate.live.ts — does the indexer path produce Anchor's exact shape?
// =============================================================================
//
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register chainRehydrate.live.ts
//
// THE FAILURE THIS EXISTS TO CATCH
//
//   Every call site in the app consumes Anchor's runtime shape: BN for
//   u64/i64/u128, PublicKey for keys, `{ american: {} }` objects for enums. The
//   indexer serves JSON. If rehydration returns a string where a BN is expected,
//   nothing fails at the boundary — it fails later, inside a pricing model or a
//   transaction argument, or it silently formats a number wrong.
//
//   Enum variant ORDER is the sharpest edge: an off-by-one turns every call into
//   a put, and both shapes look perfectly valid.
//
//   So this fetches the SAME accounts through both paths and compares them field
//   by field, including types. It is a live check by necessity — a fixture would
//   only encode whatever shape I believed on the day I wrote it, which is the
//   exact assumption under test.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REHYDRATE } from "@app/utils/chainRehydrate";

const RPC = process.env.OPTA_RPC_URL || "https://rpc.opta.fyi/devnet";
const API = process.env.OPTA_CHAIN_API || "https://opta.fyi/api/chain";

const idl = JSON.parse(
  readFileSync(join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf8"),
);

const isPk = (v: any): boolean =>
  !!v && typeof v.toBase58 === "function" && typeof v.equals === "function";
/** BN exposes these three together; a plain string or number has none of them. */
const isBn = (v: any): boolean =>
  !!v && typeof v === "object" && typeof v.toTwos === "function" && typeof v.umod === "function";

/** Compare a rehydrated value against Anchor's, including its TYPE. */
function same(ours: any, theirs: any, path: string, out: string[]): void {
  // Same dual-instance hazard for BN.
  if (isBn(theirs)) {
    if (!isBn(ours)) { out.push(`${path}: expected BN-like, got ${typeof ours}`); return; }
    if (ours.toString() !== theirs.toString()) {
      out.push(`${path}: BN ${ours.toString()} != ${theirs.toString()}`);
    }
    return;
  }
  // DUCK-TYPED ON PURPOSE. `instanceof` is wrong here: app/node_modules and
  // crank/node_modules each carry their own copy of @solana/web3.js, so a
  // genuine PublicKey built by the app fails `instanceof` against the test's
  // class. The first run of this file reported every key field as "expected
  // PublicKey, got object" — the instrument, not the code. Compare by behaviour.
  if (isPk(theirs)) {
    if (!isPk(ours)) { out.push(`${path}: expected PublicKey-like, got ${typeof ours}`); return; }
    if (ours.toBase58() !== theirs.toBase58()) {
      out.push(`${path}: ${ours.toBase58()} != ${theirs.toBase58()}`);
    }
    return;
  }
  if (Array.isArray(theirs)) {
    if (!Array.isArray(ours)) { out.push(`${path}: expected array`); return; }
    if (ours.length !== theirs.length) { out.push(`${path}: length ${ours.length} != ${theirs.length}`); return; }
    for (let i = 0; i < theirs.length; i++) same(ours[i], theirs[i], `${path}[${i}]`, out);
    return;
  }
  if (theirs && typeof theirs === "object") {
    // Anchor enums: { american: {} }. The KEY is the whole meaning.
    const tk = Object.keys(theirs), ok = Object.keys(ours ?? {});
    if (tk.length === 1 && Object.keys(theirs[tk[0]] ?? {}).length === 0) {
      if (ok[0] !== tk[0]) out.push(`${path}: enum variant "${ok[0]}" != "${tk[0]}"  <-- VARIANT ORDER`);
      return;
    }
    for (const k of tk) same(ours?.[k], theirs[k], `${path}.${k}`, out);
    return;
  }
  if (ours !== theirs) out.push(`${path}: ${JSON.stringify(ours)} != ${JSON.stringify(theirs)}`);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const program = new Program(
    idl as any,
    new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "confirmed" }),
  );

  const cases: { name: string; anchorName: string; endpoint: string }[] = [
    { name: "sharedVault", anchorName: "sharedVault", endpoint: "vaults" },
    { name: "vaultMint", anchorName: "vaultMint", endpoint: "series" },
    { name: "optionsMarket", anchorName: "optionsMarket", endpoint: "markets" },
    { name: "epochConfig", anchorName: "epochConfig", endpoint: "epochs" },
  ];

  let bad = 0;
  for (const c of cases) {
    const res = await fetch(`${API}/${c.endpoint}`);
    if (!res.ok) { console.log(`  ${c.name}: endpoint ${res.status} — SKIPPED`); bad++; continue; }
    const body: any = await res.json();
    const rows: any[] = body.rows ?? [];
    // A sample across the collection, not just the head: the first row is the
    // one most likely to be accidentally correct.
    const step = Math.max(1, Math.floor(rows.length / 25));
    const sample = rows.filter((_, i) => i % step === 0).slice(0, 25);

    const problems: string[] = [];
    let compared = 0;
    for (const row of sample) {
      const info = await conn.getAccountInfo(new PublicKey(row.publicKey), "confirmed");
      if (!info) continue;
      let anchorAcct: any;
      try { anchorAcct = program.coder.accounts.decode(c.anchorName, info.data); }
      catch { continue; }
      const ours = REHYDRATE[c.name](row);
      const before = problems.length;
      for (const k of Object.keys(anchorAcct)) same((ours as any)[k], anchorAcct[k], `${c.name}.${k}`, problems);
      if (problems.length === before) compared++;
    }
    const ok = problems.length === 0;
    if (!ok) bad++;
    console.log(`  ${c.name.padEnd(14)} sampled ${String(sample.length).padStart(3)}  identical ${String(compared).padStart(3)}  ${ok ? "SHAPE MATCHES ANCHOR" : "MISMATCH"}`);
    problems.slice(0, 6).forEach((p) => console.log(`      ! ${p}`));
  }

  console.log(`\n${bad === 0 ? "ALL SHAPES MATCH ANCHOR" : "SHAPE MISMATCH — DO NOT FLIP"}`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
