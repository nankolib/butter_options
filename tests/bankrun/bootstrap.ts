// =============================================================================
// tests/bankrun/bootstrap.ts — Stage G Pass 1 bankrun harness (RISK-RETIREMENT)
// =============================================================================
//
// Stands up solana-bankrun + anchor-bankrun ALONGSIDE the existing validator
// harness (coexist; run-tests.sh untouched). Loads BOTH programs (opta +
// opta_transfer_hook) from target/deploy via startAnchor (Anchor.toml
// [programs.localnet] declares both), wires an anchor BankrunProvider, and
// provides helpers for the things bankrun changes vs a validator:
//
//   - @solana/spl-token CONNECTION helpers (createMint/mintTo/getAccount) do
//     NOT work under bankrun (no RPC). So we PRE-BAKE the USDC mint + funded
//     token accounts + SOL wallets via ctx.setAccount(), and drive every Opta
//     instruction through the Program client (BankrunProvider.sendAndConfirm).
//   - Pyth PriceUpdateV2 fixtures are injected via setAccount (owner = Pyth
//     receiver program), reusing the existing serializer in _pyth_fixtures.ts.
//     The receiver program itself is NOT loaded (settle_expiry only DESERIALIZES
//     the account; it never CPIs the receiver).
//   - setClock lets us cross expiry deterministically (the whole point).
//
// Loads the TEST-FEATURE .so (test-fast-vol + american-enabled + test-synth-vol,
// same set run-tests.sh builds). bankrun is in-process; nothing here deploys.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { startAnchor, Clock, ProgramTestContext } from "solana-bankrun";
import {
  PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, MintLayout, AccountLayout, MINT_SIZE, ACCOUNT_SIZE,
} from "@solana/spl-token";
import os from "os";
import fs from "fs";
import path from "path";
import { PYTH_RECEIVER_ID } from "../_pyth_fixtures";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const OPTA_PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
export const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const RENT_LAMPORTS = 5_000_000; // generous rent-exempt floor for pre-baked accounts

export interface Harness {
  context: ProgramTestContext;
  provider: BankrunProvider;
  opta: Program<any>;
  payer: Keypair; // the deployer keypair (CRIT-3 admin) — provider wallet + fee payer
}

/** Load the deployer keypair (CRIT-3 DEPLOYER_PUBKEY) from the standard CLI path. */
function loadDeployer(): Keypair {
  const p = process.env.OPTA_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

/** Load both programs from target/deploy + wire the anchor provider as the deployer/admin. */
export async function setupBankrun(): Promise<Harness> {
  // startAnchor reads Anchor.toml at REPO_ROOT and auto-loads every program in
  // [programs.localnet] (opta + opta_transfer_hook) from target/deploy/<name>.so.
  const context = await startAnchor(REPO_ROOT, [], []);
  // initialize_protocol requires admin == DEPLOYER_PUBKEY (CRIT-3), so the
  // provider wallet must be the deployer keypair. Fund it (bankrun genesis only
  // funds context.payer).
  const deployer = loadDeployer();
  context.setAccount(deployer.publicKey, {
    lamports: 1_000 * LAMPORTS_PER_SOL, data: Buffer.alloc(0),
    owner: SystemProgram.programId, executable: false, rentEpoch: 0,
  });
  const provider = new BankrunProvider(context, new anchor.Wallet(deployer));
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "target", "idl", "opta.json"), "utf-8"));
  const opta = new Program(idl, provider) as Program<any>;
  return { context, provider, opta, payer: deployer };
}

/** Fund a fresh keypair with SOL (system-owned) so it can pay account-init rent. */
export function fundWallet(ctx: ProgramTestContext, kp: Keypair, sol = 100): void {
  ctx.setAccount(kp.publicKey, {
    lamports: sol * LAMPORTS_PER_SOL,
    data: Buffer.alloc(0),
    owner: SystemProgram.programId,
    executable: false,
    rentEpoch: 0,
  });
}

/** Pre-bake an initialized SPL Token mint (classic Token program) with the given authority. */
export function prebakeMint(
  ctx: ProgramTestContext, mint: PublicKey, mintAuthority: PublicKey, decimals: number,
): void {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  ctx.setAccount(mint, {
    lamports: RENT_LAMPORTS, data, owner: TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0,
  });
}

/** Pre-bake an initialized SPL token account (classic) holding `amount` of `mint`. */
export function prebakeTokenAccount(
  ctx: ProgramTestContext, address: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint,
): void {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint, owner, amount,
      delegateOption: 0, delegate: PublicKey.default,
      state: 1, // initialized
      isNativeOption: 0, isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    },
    data,
  );
  ctx.setAccount(address, {
    lamports: RENT_LAMPORTS, data, owner: TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0,
  });
}

/** Inject a pre-serialized Pyth PriceUpdateV2 account (owner = Pyth receiver). */
export function injectPythFixture(ctx: ProgramTestContext, pubkey: PublicKey, body: Buffer): void {
  ctx.setAccount(pubkey, {
    lamports: RENT_LAMPORTS, data: body, owner: new PublicKey(PYTH_RECEIVER_ID),
    executable: false, rentEpoch: 0,
  });
}

/** Current on-chain clock unix timestamp (seconds). */
export async function getClockUnix(ctx: ProgramTestContext): Promise<number> {
  const clock = await ctx.banksClient.getClock();
  return Number(clock.unixTimestamp);
}

/** Set the on-chain clock's unix timestamp, preserving the other clock fields. */
export async function setClockUnix(ctx: ProgramTestContext, unix: number): Promise<void> {
  const c = await ctx.banksClient.getClock();
  ctx.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(Math.floor(unix))));
}
