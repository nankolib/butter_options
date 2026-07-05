// ============================================================================
// crank/ladderGenerator.ts — Admin ASK-ONLY inventory seeder (one-shot CLI)
// ============================================================================
// Pre-seeds a Deribit-style chain as vault-pegged asks: per asset×strike×tenor×
// side, a [create_series, create_and_deposit] cell (mint-on-fill; spread_bps=0 =
// model-fair ask). DRY-RUN is the DEFAULT; LIVE needs --live AND
// OPTA_GENERATOR_LIVE=1. SPENDS REAL admin USDC+SOL in live mode.
//
// Run (from crank/, RPC + keypair off-repo, NEVER printed):
//   OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" \
//   OPTA_GENERATOR_KEYPAIR=/path/to/admin.json \
//   ts-node --transpile-only -r tsconfig-paths/register ladderGenerator.ts \
//        [--asset BTC|ETH|SOL] [--side call|put] [--live]
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, ComputeBudgetProgram, SystemProgram,
  SYSVAR_RENT_PUBKEY, TransactionMessage, VersionedTransaction, TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";
import { weeklyExpiry, monthlyExpiry, quarterlyExpiry } from "@app/utils/tenors";
import { toUsdcBN } from "@app/utils/format";

// ---- pinned IDs / seeds (stable Rust constants) ----------------------------
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const TOKEN_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const IDL_JSON_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");

const S = {
  optionMint: "vault_option_mint", record: "vault_mint_record",
  vault: "shared_vault_american", vaultUsdc: "vault_usdc", writerPos: "writer_position",
  eaml: "extra-account-metas", hookState: "hook-state",
  protocol: "protocol_v2", epochConfig: "epoch_config", volOracle: "vol_oracle",
};

// Warm-oracle canonical markets, pinned per asset (recon-confirmed). The feed is
// read from each market on-chain (not hardcoded) → vol_oracle PDA is derived.
const ASSETS = [
  { ticker: "BTC", step: 5000, market: new PublicKey("G3PT11ZybpeMk78GSRGg8MzULWSYB5oN9w8KjJEUBRci") },
  { ticker: "ETH", step: 250, market: new PublicKey("HouoTH9ZLxB3q1oCv7ZKH4o4vyRyCNYGiDReVDWeztFu") },
  { ticker: "SOL", step: 10, market: new PublicKey("7ke68gTGTKTz3ENygmrcPLp4415pPpajywSdZcaggd7U") },
];

// Anchor account discriminators = sha256("account:<Name>")[..8]. Hardcoded +
// VERIFIED == the IDL's accounts[].discriminator AND the first 8 bytes of live
// on-chain accounts (SharedVault 4ksU9eXb, VaultMint GWeSCukg) on 2026-06-28.
// A wrong discriminator would silently empty the inventory scan and break
// idempotency, so these are pinned rather than derived from the processed IDL.
const DISC_VAULT_MINT = Buffer.from([219, 139, 146, 175, 62, 90, 224, 254]);
const DISC_SHARED_VAULT = Buffer.from([195, 36, 66, 128, 41, 62, 161, 142]);

// VolOracle byte offsets (account data incl. 8-byte discriminator).
const VO_LAST_TS = 5832, VO_LAST_SPOT = 5840, VO_SAMPLE_COUNT = 5850;
const WARMUP = 168, STALE_SECS = 6 * 3600;
const ES_AMERICAN = 1; // ExerciseStyle::American discriminant
const CU_LIMIT = 300_000; // 187K measured + headroom
const RENT_SERIES_SOL = 0.013509; // mint + record + eaml + hookState
const RENT_VAULT_SOL = 0.006583; // vault + usdc + writerPosition

// POLICY B (locked): the generator only activates asks on vaults IT created.
// A cell with a pre-existing vault it did NOT seed (vault present, record
// missing) is SKIPPED — never create a series on a user's collateral.
const SEED_EXISTING_VAULTS = false;

const L = (s: string) => console.log(s);
const redact = (u: string) => u.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const die = (code: number, msg: string): never => { L("\nABORT: " + msg); process.exit(code); };
const le8 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const usd = (n: number) => "$" + Math.round(n).toLocaleString();
const fdate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const pda = (seeds: (Buffer | Uint8Array)[], pid = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, pid)[0];

type CellStatus = "CREATE" | "HEAL" | "SKIP-USER-VAULT";

type Cell = {
  ticker: string; market: PublicKey; side: "call" | "put"; optIdx: number;
  strikeDollars: number; expiryTs: number; tenorLabels: string[];
  seriesMint: PublicKey; seriesRecord: PublicKey; vault: PublicKey;
  needSeries: boolean; needVault: boolean; status: CellStatus;
};

function deriveCell(market: PublicKey, strikeDollars: number, expiryTs: number, optIdx: number) {
  // SPEC-seeded (NO createdAt nonce): the series mint/record + American vault are
  // addressed by (market, strike, expiry, type[, style]) alone.
  const sLe = toUsdcBN(strikeDollars).toArrayLike(Buffer, "le", 8);
  const eLe = le8(expiryTs);
  const seriesMint = pda([Buffer.from(S.optionMint), market.toBuffer(), sLe, eLe, Buffer.from([optIdx]), Buffer.from([ES_AMERICAN])]);
  const seriesRecord = pda([Buffer.from(S.record), seriesMint.toBuffer()]);
  const vault = pda([Buffer.from(S.vault), market.toBuffer(), sLe, eLe, Buffer.from([optIdx])]);
  return { seriesMint, seriesRecord, vault };
}

const VALID_TENORS = ["weekly", "nextweekly", "monthly", "quarterly"] as const;
type TenorFilter = typeof VALID_TENORS[number];

function parseFlags() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const liveRequested = a.includes("--live");
  // Optional grid filters (compose with --asset/--side, AND semantics). Absent =
  // full-roll behavior, byte-identical to pre-filter. Respected by dry-run AND live.
  let strike: number | undefined;
  const strikeRaw = get("--strike");
  if (strikeRaw !== undefined) {
    strike = Number(strikeRaw);
    if (!Number.isFinite(strike) || strike <= 0)
      die(2, `--strike must be a positive number (got "${strikeRaw}")`);
  }
  let tenor: TenorFilter | undefined;
  const tenorRaw = get("--tenor")?.toLowerCase();
  if (tenorRaw !== undefined) {
    if (!(VALID_TENORS as readonly string[]).includes(tenorRaw))
      die(2, `--tenor must be one of ${VALID_TENORS.join("|")} (got "${tenorRaw}")`);
    tenor = tenorRaw as TenorFilter;
  }
  return {
    live: liveRequested && process.env.OPTA_GENERATOR_LIVE === "1",
    liveRequested,
    asset: get("--asset")?.toUpperCase(),
    side: get("--side")?.toLowerCase() as "call" | "put" | undefined,
    strike,
    tenor,
  };
}

async function readOracle(c: Connection, market: PublicKey) {
  const mi = await c.getAccountInfo(market);
  if (!mi) return null;
  const nl = mi.data.readUInt32LE(8);
  const feed = mi.data.slice(12 + nl, 12 + nl + 32);
  const vo = pda([Buffer.from(S.volOracle), feed]);
  const voi = await c.getAccountInfo(vo);
  if (!voi) return { feed, vo, warm: false, fresh: false, spot: 0, samples: 0 };
  const samples = voi.data.readUInt16LE(VO_SAMPLE_COUNT);
  const lastTs = Number(voi.data.readBigInt64LE(VO_LAST_TS));
  const spot = Number(voi.data.readBigInt64LE(VO_LAST_SPOT)) / 1e12;
  const nowSec = Math.floor(Date.now() / 1000);
  return { feed, vo, samples, warm: samples >= WARMUP, fresh: nowSec - lastTs < STALE_SECS, spot };
}

async function buildPlan(c: Connection, program: anchor.Program<Opta>, flags: ReturnType<typeof parseFlags>) {
  // Inventory scan: one getProgramAccounts per type → existence sets.
  const all = await c.getProgramAccounts(PROGRAM_ID, {});
  const vmDisc = DISC_VAULT_MINT;
  const svDisc = DISC_SHARED_VAULT;
  const zero32 = Buffer.alloc(32);
  // Series records = VaultMint (137 B) with writer == default (offset 8+32=40).
  const seriesRecords = new Set(all.filter((a) =>
    a.account.data.length === 137 && a.account.data.slice(0, 8).equals(vmDisc)
    && a.account.data.slice(40, 72).equals(zero32)).map((a) => a.pubkey.toBase58()));
  // Vaults = SharedVault (260 B) → created_at at offset 227.
  const vaults = new Map<string, number>(all.filter((a) =>
    a.account.data.length === 260 && a.account.data.slice(0, 8).equals(svDisc))
    .map((a) => [a.pubkey.toBase58(), Number(a.account.data.readBigInt64LE(227))]));

  const now = Date.now();
  const cells: Cell[] = [];
  const excluded: string[] = [];
  const assetGrids: Record<string, number[]> = {}; // for off-grid --strike rejection msg
  let reqSol = 0, reqUsdc = 0, policyBSkipped = 0, strikeMatched = false;

  for (const A of ASSETS) {
    if (flags.asset && A.ticker !== flags.asset) continue;
    const o = await readOracle(c, A.market);
    if (!o || !o.warm || !o.fresh) {
      excluded.push(`${A.ticker} (samples=${o?.samples ?? 0}, warm=${o?.warm}, fresh=${o?.fresh})`);
      continue; // seeding a cold/stale oracle makes unfillable vaults
    }
    // Tenors → expiries, deduped by identical Friday (labels merged).
    const raw: [string, number][] = [
      ["Weekly", weeklyExpiry(now)], ["NextWeekly", weeklyExpiry(now) + 7 * 86400],
      ["Monthly", monthlyExpiry(now)], ["Quarterly", quarterlyExpiry(now)],
    ];
    const byExp = new Map<number, string[]>();
    for (const [lab, ts] of raw) { if (!byExp.has(ts)) byExp.set(ts, []); byExp.get(ts)!.push(lab); }
    const atm = Math.round(o.spot / A.step) * A.step;
    const strikes = [-3, -2, -1, 0, 1, 2, 3].map((i) => atm + i * A.step).filter((s) => s > 0);
    assetGrids[A.ticker] = strikes;
    if (flags.strike !== undefined && strikes.includes(flags.strike)) strikeMatched = true;
    const sides: ("call" | "put")[] = flags.side ? [flags.side] : ["call", "put"];

    for (const [ts, labels] of [...byExp.entries()].sort((a, b) => a[0] - b[0])) {
      // --tenor filter (AND): skip expiries whose merged labels don't include it.
      if (flags.tenor && !labels.some((l) => l.toLowerCase() === flags.tenor)) continue;
      for (const strike of strikes) for (const side of sides) {
        // --strike filter (AND): keep only the exact grid-snapped strike.
        if (flags.strike !== undefined && strike !== flags.strike) continue;
        const optIdx = side === "call" ? 0 : 1;
        const d = deriveCell(A.market, strike, ts, optIdx);
        const hasRecord = seriesRecords.has(d.seriesRecord.toBase58());
        const hasVault = vaults.has(d.vault.toBase58()) && (vaults.get(d.vault.toBase58()) ?? 0) > 0;

        // ---- Idempotency / policy branch ----
        // 1. fully seeded → SKIP.
        if (hasRecord && hasVault) continue;
        // 2. POLICY B free-ride guard: vault PRESENT + record MISSING = a vault
        //    the generator did not seed → SKIP (never activate a peg on a user's
        //    collateral). NOTE the condition is `hasVault` — the OPPOSITE of the
        //    orphan-heal case below (which is `!hasVault`), so they never collide.
        if (hasVault && !hasRecord && !SEED_EXISTING_VAULTS) { policyBSkipped++; continue; }

        // 3. otherwise emit only the missing instruction(s):
        //    - CREATE: both missing (full ask seed).
        //    - HEAL  : vault MISSING + record PRESENT (orphan 2P8Annr4) →
        //              create_and_deposit ONLY. Unaffected by policy B.
        const needSeries = !hasRecord;
        const needVault = !hasVault;
        const status: CellStatus = needSeries && needVault ? "CREATE" : "HEAL";
        if (needSeries) reqSol += RENT_SERIES_SOL;
        if (needVault) { reqSol += RENT_VAULT_SOL; reqUsdc += strike; }
        cells.push({ ticker: A.ticker, market: A.market, side, optIdx, strikeDollars: strike,
          expiryTs: ts, tenorLabels: labels, ...d, needSeries, needVault, status });
      }
    }
  }
  // --strike given but it matched no processed asset's grid → clean rejection, no plan.
  if (flags.strike !== undefined && !strikeMatched) {
    const grids = Object.entries(assetGrids).map(([t, g]) => `${t} [${g.join(", ")}]`).join("  |  ");
    die(2, `--strike ${flags.strike} is off-grid. Valid grid-snapped strikes: ${grids || "(no warm asset in scope)"}`);
  }
  return { cells, excluded, reqSol, reqUsdc, policyBSkipped };
}

async function buildCellIxs(program: anchor.Program<Opta>, signer: PublicKey, usdcMint: PublicKey,
  protocolState: PublicKey, epochConfig: PublicKey, cell: Cell): Promise<TransactionInstruction[]> {
  const strikeBN = toUsdcBN(cell.strikeDollars);
  const expiryBN = new BN(cell.expiryTs);
  const optType = cell.side === "call" ? { call: {} } : { put: {} };
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT })];

  if (cell.needSeries) {
    const eaml = pda([Buffer.from(S.eaml), cell.seriesMint.toBuffer()], HOOK_ID);
    const hookState = pda([Buffer.from(S.hookState), cell.seriesMint.toBuffer()], HOOK_ID);
    ixs.push(await program.methods
      .createSeries(strikeBN, expiryBN, optType as any, { american: {} } as any)
      .accountsStrict({
        caller: signer, market: cell.market, protocolState,
        optionMint: cell.seriesMint, vaultMintRecord: cell.seriesRecord,
        transferHookProgram: HOOK_ID, extraAccountMetaList: eaml, hookState,
        systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_ID,
        rent: SYSVAR_RENT_PUBKEY,
      }).instruction());
  }
  if (cell.needVault) {
    const vaultUsdc = pda([Buffer.from(S.vaultUsdc), cell.vault.toBuffer()]);
    const writerPos = pda([Buffer.from(S.writerPos), cell.vault.toBuffer(), signer.toBuffer()]);
    const writerUsdc = await getAssociatedTokenAddress(usdcMint, signer);
    ixs.push(await program.methods
      // amount = strike (1 contract of capacity; collateral_per_token = strike).
      .createAndDeposit(strikeBN, expiryBN, optType as any, { epoch: {} } as any,
        usdcMint, 0, { american: {} } as any, strikeBN)
      .accountsStrict({
        writer: signer, market: cell.market, sharedVault: cell.vault,
        vaultUsdcAccount: vaultUsdc, usdcMint, writerPosition: writerPos,
        writerUsdcAccount: writerUsdc, protocolState, epochConfig,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction());
  }
  return ixs;
}

function printPlan(plan: Awaited<ReturnType<typeof buildPlan>>, adminSol: number, adminUsdc: number, live: boolean) {
  L("=== LADDER GENERATOR — " + (live ? "LIVE PLAN" : "DRY RUN (nothing sent)") + " ===");
  plan.excluded.forEach((e) => L(`  EXCLUDED ${e} — cold/stale oracle → would make unfillable vaults`));
  const byAsset: Record<string, Cell[]> = {};
  for (const c of plan.cells) (byAsset[c.ticker] ??= []).push(c);
  for (const [t, cs] of Object.entries(byAsset)) {
    const create = cs.filter((c) => c.status === "CREATE").length;
    const heal = cs.filter((c) => c.status === "HEAL").length;
    const coll = cs.filter((c) => c.needVault).reduce((s, c) => s + c.strikeDollars, 0);
    const exps = [...new Set(cs.map((c) => `${fdate(c.expiryTs)}{${c.tenorLabels.join("+")}}`))];
    L(`${t}: create=${create} heal=${heal} | collateral=${usd(coll)} | expiries=${exps.join(" ")}`);
  }
  for (const c of plan.cells.slice(0, 8))
    L(`  ${c.ticker} ${c.side === "call" ? "C" : "P"} ${usd(c.strikeDollars)} ${fdate(c.expiryTs)} {${c.tenorLabels.join("+")}} -> ${c.status}`);
  L("\n=== TOTALS ===");
  L(`cells to seed = ${plan.cells.length} (one tx each) | policy-B skipped (user vaults) = ${plan.policyBSkipped}`);
  L(`SOL rent ≈ ${plan.reqSol.toFixed(4)} | USDC collateral = ${usd(plan.reqUsdc)}`);
  L(`signer: ${adminSol.toFixed(3)} SOL | ${usd(adminUsdc)} USDC | coverage SOL ${adminSol >= plan.reqSol ? "OK" : "SHORT"} / USDC ${adminUsdc >= plan.reqUsdc ? "OK" : "SHORT"}`);
}

async function main() {
  const flags = parseFlags();
  const rpcUrl = process.env.OPTA_RPC_URL
    || (fs.existsSync(path.join(os.homedir(), ".opta-rpc-helius"))
      ? fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim()
      : die(2, "no RPC (set OPTA_RPC_URL or ~/.opta-rpc-helius)"));
  const kpPath = process.env.OPTA_GENERATOR_KEYPAIR;
  if (!kpPath) die(2, "OPTA_GENERATOR_KEYPAIR is required (admin keypair path — never printed)");
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath!, "utf-8"))));

  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(signer), { commitment: "confirmed" });
  const program = new anchor.Program<Opta>(JSON.parse(fs.readFileSync(IDL_JSON_PATH, "utf-8")), provider);
  L(JSON.stringify({ ev: "boot", rpc: redact(rpcUrl), signer: signer.publicKey.toBase58(),
    mode: flags.live ? "LIVE" : "DRY-RUN", asset: flags.asset ?? "all", side: flags.side ?? "both",
    strike: flags.strike ?? "all", tenor: flags.tenor ?? "all" }));

  const protocolState = pda([Buffer.from(S.protocol)]);
  const usdcMint = (await program.account.protocolState.fetch(protocolState)).usdcMint as PublicKey;
  const epochConfig = pda([Buffer.from(S.epochConfig)]);

  const plan = await buildPlan(connection, program, flags);
  const adminSol = (await connection.getBalance(signer.publicKey)) / 1e9;
  const adminUsdcAta = await getAssociatedTokenAddress(usdcMint, signer.publicKey);
  const adminUsdc = await connection.getTokenAccountBalance(adminUsdcAta)
    .then((r) => Number(r.value.amount) / 1e6).catch(() => 0);
  printPlan(plan, adminSol, adminUsdc, flags.live);

  if (plan.cells.length === 0) { L("\nNothing to seed (all exist / excluded). Done."); return; }

  if (!flags.live) {
    L("\nDRY-RUN — nothing sent." + (flags.liveRequested ? " (--live set but OPTA_GENERATOR_LIVE!=1 — refusing.)" : ""));
    return;
  }

  // ---- LIVE ----
  if (adminSol < plan.reqSol || adminUsdc < plan.reqUsdc)
    die(3, `signer underfunded: need ${plan.reqSol.toFixed(3)} SOL / ${usd(plan.reqUsdc)} USDC`);
  L(`\nLIVE: seeding ${plan.cells.length} cells, ~${plan.reqSol.toFixed(3)} SOL + ${usd(plan.reqUsdc)} USDC. Aborting in 5s… (Ctrl-C)`);
  await new Promise((r) => setTimeout(r, 5000));

  let created = 0;
  const failures: { cell: string; err: string }[] = [];
  for (const cell of plan.cells) {
    const tag = `${cell.ticker} ${cell.side} ${usd(cell.strikeDollars)} ${fdate(cell.expiryTs)} [${cell.status}]`;
    let landed = false;
    for (let attempt = 1; attempt <= 2 && !landed; attempt++) {
      try {
        const ixs = await buildCellIxs(program, signer.publicKey, usdcMint, protocolState, epochConfig, cell);
        const bh = await connection.getLatestBlockhash();
        const tx = new VersionedTransaction(new TransactionMessage({
          payerKey: signer.publicKey, recentBlockhash: bh.blockhash, instructions: ixs,
        }).compileToLegacyMessage());
        tx.sign([signer]);
        const sig = await connection.sendTransaction(tx, { skipPreflight: false });
        const conf = await connection.confirmTransaction(
          { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
        if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));
        landed = true; created++;
        L(`  OK  ${tag} sig=${sig}`);
      } catch (e: any) {
        // Never resend a landed cell: re-check the chain before retrying.
        const probe = cell.needVault ? cell.vault : cell.seriesRecord;
        const exists = await connection.getAccountInfo(probe).catch(() => null);
        if (exists) { landed = true; created++; L(`  OK  ${tag} (confirmed on re-check)`); break; }
        if (attempt === 2) {
          const msg = String(e?.message ?? e).slice(0, 160);
          failures.push({ cell: tag, err: msg });
          L(`  FAIL ${tag} — ${msg}`);
        }
        // else loop once more with a fresh blockhash (stale-retry, scoped to this cell)
      }
    }
  }
  L(`\n=== LIVE SUMMARY ===`);
  L(`created=${created} / ${plan.cells.length} | failed=${failures.length}`);
  failures.forEach((f) => L(`  FAIL ${f.cell} :: ${f.err}`));
  const spentSol = adminSol - (await connection.getBalance(signer.publicKey)) / 1e9;
  L(`SOL spent ≈ ${spentSol.toFixed(4)} (rent + fees)`);
}

main().catch((e) => { console.error("ladderGenerator crashed:", e); process.exit(1); });
