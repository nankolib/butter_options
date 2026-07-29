// =============================================================================
// env.ts — configuration + kill switches, parsed once at boot (fail-fast).
// =============================================================================
// Mirrors the crank's env discipline: required vars fail-fast with process.exit,
// secrets are file paths (never inline), RPC is redacted in logs. The two kill
// switches the founder controls at runtime are OPTA_WRITER_ENABLED (soft: keep
// discovering + quoting + logging, post nothing) and `systemctl stop` (hard).
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";

export interface WriterConfig {
  rpcUrl: string;
  idlPath: string;
  wallet: Keypair;

  // --- kill switches / scope ---
  enabled: boolean;          // OPTA_WRITER_ENABLED — false = observe-only (no chain writes)
  dryRun: boolean;           // OPTA_WRITER_DRY_RUN — true = build plan + log, never send tx
  assets: string[] | null;   // OPTA_WRITER_ASSETS CSV allow-list; null = all discovered
  // HARD denylists — these WIN over the allow-list and stay in force when
  // assets=null (full board). A permanent exclusion belongs here, never in the
  // allow-list, so it cannot silently return the moment the allow-list is dropped.
  assetsExclude: string[];   // OPTA_WRITER_ASSETS_EXCLUDE CSV tickers (e.g. SBXAU — double-XAU exposure)
  excludeClasses: number[];  // OPTA_WRITER_EXCLUDE_CLASSES CSV asset_class (e.g. 2,4 = equity/ETF until their funding block lands)
  maxCellsThisRun: number;   // OPTA_WRITER_MAX_CELLS — cap on TOTAL live asks (canary; 0 = uncapped)

  // --- ladder / caps ---
  maxCellsPerAsset: number;  // OPTA_WRITER_MAX_CELLS_PER_ASSET (default 20)
  globalVaultCap: number;    // OPTA_WRITER_GLOBAL_VAULT_CAP (default 500 — full SB board ~200 asks + Monday equities ~260 ≈ 480; MAX_CELLS is the real throttle)
  targetNotionalMajor: number; // OPTA_WRITER_TARGET_NOTIONAL_MAJOR USD (default 2000)
  targetNotionalMeme: number;  // OPTA_WRITER_TARGET_NOTIONAL_MEME USD (default 500)

  // --- pricing / reprice ---
  repriceDriftBps: number;   // OPTA_WRITER_REPRICE_DRIFT_BPS (default 300 = 3%)
  repriceMaxAgeMs: number;   // OPTA_WRITER_REPRICE_MAX_AGE_MS (default 30m)
  quoteFailPullThreshold: number; // OPTA_WRITER_QUOTE_FAIL_PULL_THRESHOLD (default 2)

  // --- runtime ---
  tickMs: number;            // OPTA_WRITER_TICK_MS (default 5m)
  lowBalanceWarnSol: number; // OPTA_WRITER_LOW_BALANCE_WARN_SOL (default 1.0)
  minFreeUsdc: number;       // OPTA_WRITER_MIN_FREE_USDC (default 0) — warn below

  // --- C1 two-sided quoting (bids). Dark by default. ---
  // A bid is a DEPENDENT quote: it exists only alongside a resting ask on the
  // same series, and is re-derived whenever that ask is posted/repriced/pulled.
  // Asks always get budget priority — a failed ask post can strand permanent
  // series+vault rent, a failed bid post costs nothing.
  bidEnabled: boolean;            // OPTA_WRITER_BID_ENABLED (default FALSE)
  // ATM band is a CODE bound enforced in bids.ts, not a throttle: caps decide
  // how much is quoted inside the band, never where the band is.
  bidAtmRungs: number;            // OPTA_WRITER_BID_ATM_RUNGS (default 0 = ATM only)
  bidMaxNotionalPerAsset: number; // OPTA_WRITER_BID_MAX_NOTIONAL_PER_ASSET (USD)
  bidMaxNotionalGlobal: number;   // OPTA_WRITER_BID_MAX_NOTIONAL_GLOBAL (USD)
  bidReserveUsdc: number;         // OPTA_WRITER_BID_RESERVE_USDC — free-USDC floor bids never touch
  bidMaxCells: number;            // OPTA_WRITER_BID_MAX_CELLS (0 = uncapped; canary throttle)
  bidMaxLongPerSeries: number;    // OPTA_WRITER_MAX_LONG_PER_SERIES — inventory cap, contracts
  bidDepthFrac: number;           // OPTA_WRITER_BID_DEPTH_FRAC (fraction of the ask qty)

  // Optional fee-payer for the read-only get_option_price simulation. sigVerify
  // is false, so any funded system-owned pubkey works and nothing is signed;
  // this lets observe-mode quote before the bot wallet is funded. Default: the
  // bot wallet (prod behavior unchanged).
  simPayer: PublicKey | null;
}

const bool = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined || v === "") return dflt;
  return v === "1" || v.toLowerCase() === "true";
};
const num = (v: string | undefined, dflt: number): number => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export const redactRpc = (u: string): string => u.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");

function die(msg: string): never {
  console.error(JSON.stringify({ ev: "fatal", msg }));
  process.exit(1);
}

/**
 * Parse a CSV of asset_class numbers (OPTA_WRITER_EXCLUDE_CLASSES).
 *
 * MUST drop empty segments BEFORE Number(). `Number("") === 0` and
 * `Number.isFinite(0) === true`, so the previous
 * `.split(",").map(Number).filter(Number.isFinite)` turned an EMPTY or UNSET
 * variable into `[0]` — silently deny-listing asset_class 0 (crypto/memes), the
 * entire live crypto board, at the exact moment an operator tried to CLEAR the
 * denylist. Caught 2026-07-21 during the equity lift; the VPS `.env` still
 * carries a `=99` sentinel from that workaround, which can be dropped on the
 * next deliberate writer restart now that empty parses correctly.
 *
 * Empty / unset / whitespace / all-garbage => [] (exclude nothing).
 */
export function parseClassList(raw: string | undefined | null): number[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)                       // <- the fix: "" never reaches Number()
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function loadKeypair(p: string): Keypair {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    die(`OPTA_WRITER_KEYPAIR file not readable: ${p}`);
  }
  let arr: number[];
  try {
    arr = JSON.parse(raw);
  } catch {
    die(`OPTA_WRITER_KEYPAIR is not a JSON byte array: ${p}`);
  }
  if (!Array.isArray(arr) || arr.length !== 64) die(`OPTA_WRITER_KEYPAIR must be a 64-byte array (got ${Array.isArray(arr) ? arr.length : "non-array"})`);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    die(`OPTA_WRITER_KEYPAIR bytes are not a valid secret key: ${p}`);
  }
}

export function loadConfig(): WriterConfig {
  const rpcUrl = process.env.OPTA_RPC_URL || die("OPTA_RPC_URL is required");
  const kpPath = process.env.OPTA_WRITER_KEYPAIR || die("OPTA_WRITER_KEYPAIR is required (file path, never inline)");
  const wallet = loadKeypair(kpPath);

  // IDL: explicit override, else the self-contained copy shipped by copy-idl.js,
  // else the local dev tree.
  const idlDefault = path.resolve(__dirname, "../idl/opta.json");
  const idlDev = path.resolve(__dirname, "../../app/src/idl/opta.json");
  let idlPath = process.env.OPTA_WRITER_IDL || (fs.existsSync(idlDefault) ? idlDefault : idlDev);
  if (!fs.existsSync(idlPath)) die(`IDL not found (set OPTA_WRITER_IDL). Tried: ${idlPath}`);

  const assetsRaw = (process.env.OPTA_WRITER_ASSETS || "").trim();
  const assets = assetsRaw
    ? assetsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  const assetsExclude = (process.env.OPTA_WRITER_ASSETS_EXCLUDE || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const excludeClasses = parseClassList(process.env.OPTA_WRITER_EXCLUDE_CLASSES);

  return {
    rpcUrl,
    idlPath,
    wallet,
    enabled: bool(process.env.OPTA_WRITER_ENABLED, false), // default OFF — must be explicitly enabled
    dryRun: bool(process.env.OPTA_WRITER_DRY_RUN, false),
    assets,
    assetsExclude,
    excludeClasses,
    maxCellsThisRun: num(process.env.OPTA_WRITER_MAX_CELLS, 0),
    maxCellsPerAsset: num(process.env.OPTA_WRITER_MAX_CELLS_PER_ASSET, 20),
    globalVaultCap: num(process.env.OPTA_WRITER_GLOBAL_VAULT_CAP, 500),
    targetNotionalMajor: num(process.env.OPTA_WRITER_TARGET_NOTIONAL_MAJOR, 2000),
    targetNotionalMeme: num(process.env.OPTA_WRITER_TARGET_NOTIONAL_MEME, 500),
    repriceDriftBps: num(process.env.OPTA_WRITER_REPRICE_DRIFT_BPS, 300),
    repriceMaxAgeMs: num(process.env.OPTA_WRITER_REPRICE_MAX_AGE_MS, 30 * 60 * 1000),
    quoteFailPullThreshold: num(process.env.OPTA_WRITER_QUOTE_FAIL_PULL_THRESHOLD, 2),
    tickMs: Math.max(1000, num(process.env.OPTA_WRITER_TICK_MS, 5 * 60 * 1000)),
    lowBalanceWarnSol: num(process.env.OPTA_WRITER_LOW_BALANCE_WARN_SOL, 1.0),
    minFreeUsdc: num(process.env.OPTA_WRITER_MIN_FREE_USDC, 0),
    // Bids: dark by default. The master switch defaults FALSE so a deploy that
    // ships this code changes nothing until it is set deliberately.
    bidEnabled: bool(process.env.OPTA_WRITER_BID_ENABLED, false),
    bidAtmRungs: Math.max(0, num(process.env.OPTA_WRITER_BID_ATM_RUNGS, 0)),
    bidMaxNotionalPerAsset: num(process.env.OPTA_WRITER_BID_MAX_NOTIONAL_PER_ASSET, 250),
    bidMaxNotionalGlobal: num(process.env.OPTA_WRITER_BID_MAX_NOTIONAL_GLOBAL, 2500),
    bidReserveUsdc: num(process.env.OPTA_WRITER_BID_RESERVE_USDC, 5000),
    bidMaxCells: num(process.env.OPTA_WRITER_BID_MAX_CELLS, 0),
    bidMaxLongPerSeries: num(process.env.OPTA_WRITER_MAX_LONG_PER_SERIES, 10),
    bidDepthFrac: num(process.env.OPTA_WRITER_BID_DEPTH_FRAC, 0.25),
    simPayer: parseSimPayer(process.env.OPTA_WRITER_SIM_PAYER),
  };
}

function parseSimPayer(v: string | undefined): PublicKey | null {
  if (!v || !v.trim()) return null;
  try {
    return new PublicKey(v.trim());
  } catch {
    die(`OPTA_WRITER_SIM_PAYER is not a valid pubkey: ${v}`);
  }
}

/** Home-dir helper reused for local-dev RPC fallback file, mirroring the crank. */
export const homeFile = (name: string): string => path.join(os.homedir(), name);
