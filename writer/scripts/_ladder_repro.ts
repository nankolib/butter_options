// =============================================================================
// writer/scripts/_ladder_repro.ts — OFFLINE ladder repro harness (diagnostic).
// =============================================================================
// NOT wired into the service. Imports the ACTUAL deployed code paths
// (buildLadder / stickyStrike / roundSig / roundSigStep) from ../src/ladder and
// feeds them:
//   - live spot per asset, from the SAME source the writer uses
//     (VolOracle.last_spot_price / 1e12 — see writer/src/discovery.ts:108-109)
//   - existingStrikes from LIVE ON-CHAIN writer asks (vault.strike_price / 1e6),
//     mirroring engine.existingStrikesFor()
// Prints per asset: existing strikes, candidate ladder PRE-hysteresis, final
// ladder POST-hysteresis, and the per-strike keep/replace decision + reason.
// Then sweeps spot +/-1.5% in 10bp steps and reports the exact spot levels at
// which each rung flips.
// Read-only: no transactions, no writes.
// =============================================================================
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { roundSig, roundSigStep, stickyStrike } from "../src/ladder";

const PROG = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const W = new PublicKey("HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS");
// Verbatim from writer/src/ladder.ts:26 (module-private, so mirrored here for
// the sweep only; the keep/replace decisions all run through stickyStrike).
const STRIKE_MULTIPLIERS = [1.0, 0.95, 1.05, 0.9, 1.1];
const ASSETS = ["BTC", "ETH", "SOL", "XRP", "FARTCOIN", "XAU"];
const f = (x: number) => (x >= 1000 ? x.toFixed(0) : x >= 1 ? x.toFixed(4) : x.toFixed(6));

(async () => {
  const c = new Connection(process.env.OPTA_RPC_URL!, "confirmed");
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "app", "src", "idl", "opta.json"), "utf-8"));
  const p = new Program(idl as any, new anchor.AnchorProvider(c, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));

  // ---- live writer asks -> per-market existing strikes (engine.existingStrikesFor) ----
  const disc = (p.coder.accounts as any).memcmp("restingOrder");
  const ro = await c.getProgramAccounts(PROG, {
    filters: [{ memcmp: disc }, { memcmp: { offset: 8, bytes: W.toBase58() } }],
  });
  const vaultCache = new Map<string, { market: string; strike: number }>();
  const byMarket = new Map<string, Set<number>>();
  for (const { account } of ro) {
    let r: any;
    try { r = p.coder.accounts.decode("restingOrder", account.data); } catch { continue; }
    if (!r.kind || !("writerAsk" in r.kind)) continue;
    const v58 = new PublicKey(r.vault).toBase58();
    let info = vaultCache.get(v58);
    if (!info) {
      try {
        const v: any = await (p.account as any).sharedVault.fetch(new PublicKey(v58));
        info = { market: new PublicKey(v.market).toBase58(), strike: Number(v.strikePrice.toString()) / 1e6 };
      } catch { continue; }
      vaultCache.set(v58, info);
    }
    if (!byMarket.has(info.market)) byMarket.set(info.market, new Set());
    byMarket.get(info.market)!.add(info.strike);
  }

  for (const asset of ASSETS) {
    const [mktPda] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(asset)], PROG);
    const m: any = await (p.account as any).optionsMarket.fetch(mktPda).catch(() => null);
    if (!m) { console.log(`\n### ${asset}: market not found`); continue; }
    const feedHash = Buffer.from(m.sbFeedHash ?? m.feedId ?? m.pythFeedId ?? []);
    const [voPda] = PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), feedHash], PROG);
    const vo: any = await (p.account as any).volOracle.fetch(voPda).catch(() => null);
    const spot = vo ? Number((vo.lastSpotPrice ?? vo.lastSpot).toString()) / 1e12 : 0;
    const existing = [...(byMarket.get(mktPda.toBase58()) ?? new Set<number>())].sort((a, b) => a - b);
    const step = roundSigStep(spot, 3);
    const band = step * 0.75;

    console.log(`\n### ${asset}  spot=${f(spot)}  roundSigStep=${f(step)}  band(0.75*step)=${f(band)}`);
    console.log(`    existing strikes (live on-chain asks): [${existing.map(f).join(", ")}]`);
    console.log(`    ${"mult".padEnd(6)}${"rawTarget".padStart(12)}${"pre-hyst".padStart(12)}${"post-hyst".padStart(12)}  decision`);
    for (const mult of STRIKE_MULTIPLIERS) {
      const raw = spot * mult;
      const pre = roundSig(raw, 3);
      const post = stickyStrike(raw, existing);
      let why: string;
      if (existing.length === 0) why = "no anchors -> fresh";
      else {
        let best: number | null = null, bd = Infinity;
        for (const e of existing) { const d = Math.abs(raw - e); if (d <= band && d < bd) { best = e; bd = d; } }
        why = best != null
          ? `KEPT ${f(best)} (|raw-e|=${f(bd)} <= band ${f(band)})`
          : `REPLACED -> fresh ${f(pre)} (nearest |raw-e|=${f(Math.min(...existing.map((e) => Math.abs(raw - e))))} > band ${f(band)})`;
      }
      console.log(`    ${String(mult).padEnd(6)}${f(raw).padStart(12)}${f(pre).padStart(12)}${f(post).padStart(12)}  ${why}`);
    }

    // ---- sweep spot +/-1.5% in 10bp steps: where does each rung flip? ----
    console.log(`    --- sweep spot +/-1.5% @10bp: rung flip thresholds ---`);
    for (const mult of STRIKE_MULTIPLIERS) {
      const flips: string[] = [];
      let prev: number | null = null;
      for (let bp = -150; bp <= 150; bp += 10) {
        const s = spot * (1 + bp / 10000);
        const chosen = stickyStrike(s * mult, existing);
        if (prev !== null && chosen !== prev) flips.push(`${bp >= 0 ? "+" : ""}${bp}bp: ${f(prev)}->${f(chosen)}`);
        prev = chosen;
      }
      console.log(`    mult ${String(mult).padEnd(5)} ${flips.length === 0 ? "STABLE across +/-1.5%" : flips.join("  |  ")}`);
    }
  }
})().catch((e) => console.log("ERR", e.stack ?? e.message));
