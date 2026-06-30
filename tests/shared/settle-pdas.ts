// =============================================================================
// tests/shared/settle-pdas.ts — Phase 3 retro-harden settle_vault pot derivation
// =============================================================================
//
// Single, dependency-free source for the PDA seeds settle_vault now REQUIRES
// (the pot is un-omittable / derived from vault identity — same seeds as the
// on-chain handler). Pure: imports only @solana/web3.js + bn.js, so BOTH the
// bankrun suite (tests/bankrun/*) and the validator suite (tests/*.ts) can pull
// it without dragging in harness-coupled code. programId is passed in (bankrun
// uses OPTA_PROGRAM_ID; the validator suite uses program.programId).
//
// Seeds mirror programs/opta/src/instructions/settle_vault.rs:
//   canonical mint : ["vault_option_mint", market, strike_le8, expiry_le8, [ot], [es]]
//   pot record     : ["writer_ask_pot", option_mint]
//   pot USDC       : ["writer_ask_pot_usdc", option_mint]
//   vault USDC     : ["vault_usdc", vault]
//   protocol state : ["protocol_v2"]
// =============================================================================

import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

/** Canonical series mint from vault identity (option_type byte ot, exercise_style byte es). */
export function canonicalSeriesMint(
  programId: PublicKey, market: PublicKey, strike: BN, expiry: BN, otB: number, esB: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_option_mint"),
      market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([otB]),
      Buffer.from([esB]),
    ],
    programId,
  )[0];
}

/** Pot record + pot USDC PDAs from a canonical mint — the seed-of-truth for both. */
export function settlePotPdas(programId: PublicKey, optionMint: PublicKey) {
  return {
    writerAskPot: PublicKey.findProgramAddressSync(
      [Buffer.from("writer_ask_pot"), optionMint.toBuffer()], programId)[0],
    writerAskPotUsdc: PublicKey.findProgramAddressSync(
      [Buffer.from("writer_ask_pot_usdc"), optionMint.toBuffer()], programId)[0],
  };
}

export function vaultUsdcPda(programId: PublicKey, vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_usdc"), vault.toBuffer()], programId)[0];
}

export function protocolStatePda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], programId)[0];
}

/** Async: fetch the vault and build settle_vault's now-required pot-account fragment,
 * ready to spread into `.accounts({...})` / `.accountsStrict({...})`. Works with any
 * Anchor Program-like object exposing `.programId` + `.account.sharedVault.fetch`.
 * No-pot / EUR vaults ⇒ derived-empty pot + pot_usdc ⇒ handler's data_is_empty()
 * ⇒ swept == 0 (byte-identical settle). */
export async function settlePotAccountsFor(program: any, market: PublicKey, vault: PublicKey) {
  const v: any = await program.account.sharedVault.fetch(vault);
  const pid: PublicKey = program.programId;
  const otB = "put" in v.optionType ? 1 : 0;
  const esB = "american" in v.exerciseStyle ? 1 : 0;
  const optionMint = canonicalSeriesMint(pid, market, v.strikePrice, v.expiry, otB, esB);
  const { writerAskPot, writerAskPotUsdc } = settlePotPdas(pid, optionMint);
  return {
    vaultUsdcAccount: vaultUsdcPda(pid, vault),
    optionMint,
    writerAskPot,
    writerAskPotUsdc,
    protocolState: protocolStatePda(pid),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}
