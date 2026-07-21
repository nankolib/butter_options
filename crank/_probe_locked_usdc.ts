// READ-ONLY: locked-USDC census for the opta-writer wallet.
// Two independent on-chain sources, reported side by side:
//   A) RestingOrder(kind=writerAsk, owner=writer): quantity_remaining
//      * collateral_per_contract  — USDC still escrowed behind LIVE asks.
//   B) WriterAskPosition(backer=writer): collateral_committed — the
//      protocol's own committed-collateral ledger for this backer.
// A < B means collateral committed to positions whose ask is no longer
// resting (partially/fully filled, or cancelled-but-unreclaimed).
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import type { Opta } from "@app/idl/opta";

const PROG = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const W = new PublicKey("HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS");
const usd = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

(async () => {
  const c = new Connection(process.env.OPTA_RPC_URL!, "confirmed");
  const p = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(c, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }),
  );

  // vault -> assetName, memoised (vault->market->assetName)
  const assetOf = new Map<string, string>();
  const resolve = async (vaultPk: string): Promise<string> => {
    const hit = assetOf.get(vaultPk);
    if (hit) return hit;
    let name = "?";
    try {
      const v: any = await (p.account as any).sharedVault.fetch(new PublicKey(vaultPk));
      const m: any = await (p.account as any).optionsMarket.fetch(new PublicKey(v.market));
      name = m.assetName;
    } catch { /* leave "?" */ }
    assetOf.set(vaultPk, name);
    return name;
  };

  // ---- A) live resting writer asks ----
  const roDisc = (p.coder.accounts as any).memcmp("restingOrder");
  const ro = await c.getProgramAccounts(PROG, {
    filters: [{ memcmp: roDisc }, { memcmp: { offset: 8, bytes: W.toBase58() } }],
  });
  const byAsset = new Map<string, { asks: number; locked: number; contracts: number }>();
  let askCount = 0, lockedA = 0;
  for (const { account } of ro) {
    let r: any;
    try { r = p.coder.accounts.decode("restingOrder", account.data); } catch { continue; }
    if (!r.kind || !("writerAsk" in r.kind)) continue;
    const qty = Number(r.quantityRemaining);
    const cpc = Number(r.collateralPerContract);
    const locked = (qty * cpc) / 1e6;
    const asset = await resolve(new PublicKey(r.vault).toBase58());
    const e = byAsset.get(asset) ?? { asks: 0, locked: 0, contracts: 0 };
    e.asks += 1; e.locked += locked; e.contracts += qty / 1e6;
    byAsset.set(asset, e);
    askCount += 1; lockedA += locked;
  }

  // ---- B) WriterAskPosition ledger for this backer ----
  const wapDisc = (p.coder.accounts as any).memcmp("writerAskPosition");
  const wap = await c.getProgramAccounts(PROG, {
    filters: [{ memcmp: wapDisc }, { memcmp: { offset: 8, bytes: W.toBase58() } }],
  });
  let lockedB = 0, posCount = 0;
  const byAssetB = new Map<string, number>();
  for (const { account } of wap) {
    let w: any;
    try { w = p.coder.accounts.decode("writerAskPosition", account.data); } catch { continue; }
    const committed = Number(w.collateralCommitted) / 1e6;
    lockedB += committed; posCount += 1;
    const asset = await resolve(new PublicKey(w.vault).toBase58());
    byAssetB.set(asset, (byAssetB.get(asset) ?? 0) + committed);
  }

  console.log("\n=== A) LIVE RESTING WRITER ASKS (qty_remaining x collateral_per_contract) ===");
  console.log("asset".padEnd(10), "asks".padStart(5), "contracts".padStart(12), "lockedUSDC".padStart(16));
  for (const [a, e] of [...byAsset.entries()].sort((x, y) => y[1].locked - x[1].locked)) {
    console.log(a.padEnd(10), String(e.asks).padStart(5), e.contracts.toFixed(2).padStart(12), usd(e.locked).padStart(16));
  }
  console.log("-".repeat(46));
  console.log("TOTAL".padEnd(10), String(askCount).padStart(5), "".padStart(12), usd(lockedA).padStart(16));

  console.log("\n=== B) WriterAskPosition ledger (collateral_committed, backer=writer) ===");
  for (const [a, v] of [...byAssetB.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(a.padEnd(10), usd(v).padStart(16));
  }
  console.log("-".repeat(30));
  console.log(`positions=${posCount}  TOTAL=${usd(lockedB)}`);
  console.log(`\nA(live asks)=${usd(lockedA)}   B(committed ledger)=${usd(lockedB)}   B-A=${usd(lockedB - lockedA)}`);
})().catch((e) => console.log("ERR", e.stack ?? e.message));
