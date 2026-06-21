// =============================================================================
// app/src/pages/trade/orderFlows.ts — Pass 2 exchange write path (series)
// =============================================================================
//
// Pure, React-free transaction builders for the SERIES exchange paths. The
// hooks (usePegFill / usePostOrder / useFillOrder) are thin wrappers over these;
// keeping the logic here makes the write path unit-testable against devnet with
// a Keypair wallet (no React harness).
//
// Account shapes mirror the proven devnet scripts:
//   fill_vault_peg → scripts/seed-trade-series-devnet.ts
//   post_order / fill_order → scripts/smoke-book-devnet.ts
// Legacy buy/sell reuse the existing usePurchaseFlow / useResaleBuyFlow /
// usePortfolioActions — they are NOT reimplemented here.
// =============================================================================

import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  PROGRAM_ID, PROTOCOL_SEED, MARKET_SEED, VOL_ORACLE_SEED,
  VAULT_MINT_RECORD_SEED, VAULT_USDC_SEED,
  RESTING_ORDER_SEED, RESTING_ORDER_ESCROW_SEED,
  TRANSFER_HOOK_PROGRAM_ID, deriveExtraAccountMetaListPda, deriveHookStatePda,
} from "../../utils/constants";

const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const pda = (seeds: (Buffer | Uint8Array)[], pid: PublicKey = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, pid)[0];

/** A focused series contract, as resolved from the unified chain. */
export interface SeriesRef {
  asset: string;
  vault: string;       // backing SharedVault PDA
  optionMint: string;  // canonical series mint
}

export interface OrderCtx {
  protocolState: PublicKey;
  usdcMint: PublicKey;
  treasury: PublicKey;
}

export async function loadOrderCtx(program: Program<any>): Promise<OrderCtx> {
  const protocolState = pda([Buffer.from(PROTOCOL_SEED)]);
  const ps: any = await (program.account as any).protocolState.fetch(protocolState);
  return { protocolState, usdcMint: ps.usdcMint as PublicKey, treasury: ps.treasury as PublicKey };
}

async function seriesAccounts(program: Program<any>, ref: SeriesRef) {
  const market = pda([Buffer.from(MARKET_SEED), Buffer.from(ref.asset)]);
  const mkt: any = await (program.account as any).optionsMarket.fetch(market);
  const volOracle = pda([Buffer.from(VOL_ORACLE_SEED), Buffer.from(mkt.pythFeedId as number[])]);
  const optionMint = new PublicKey(ref.optionMint);
  const vault = new PublicKey(ref.vault);
  return {
    market, volOracle, optionMint, vault,
    record: pda([Buffer.from(VAULT_MINT_RECORD_SEED), optionMint.toBuffer()]),
    vaultUsdc: pda([Buffer.from(VAULT_USDC_SEED), vault.toBuffer()]),
    eaml: deriveExtraAccountMetaListPda(optionMint)[0],
    hookState: deriveHookStatePda(optionMint)[0],
  };
}

/**
 * Buy·Market against the vault peg: fill_vault_peg. Prices at fill via
 * get_option_price CPI; mints `quantity` contracts to the taker.
 */
export async function pegFill(
  program: Program<any>, ref: SeriesRef, quantity: number, maxPremiumMicro: BN, ctx?: OrderCtx,
): Promise<string> {
  const c = ctx ?? (await loadOrderCtx(program));
  const a = await seriesAccounts(program, ref);
  const taker = program.provider.publicKey!;
  const takerOption = getAssociatedTokenAddressSync(a.optionMint, taker, false, TOKEN_2022_PROGRAM_ID);
  const takerUsdc = getAssociatedTokenAddressSync(c.usdcMint, taker, false, TOKEN_PROGRAM_ID);
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, takerOption, taker, a.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  return program.methods.fillVaultPeg(new BN(quantity), maxPremiumMicro).accountsStrict({
    taker, sharedVault: a.vault, vaultMintRecord: a.record, market: a.market, volOracle: a.volOracle,
    protocolState: c.protocolState, optionMint: a.optionMint, takerOptionAccount: takerOption,
    takerUsdcAccount: takerUsdc, vaultUsdcAccount: a.vaultUsdc, treasury: c.treasury,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
  }).preInstructions([CU(400_000), ataIx]).rpc();
}

/**
 * Post a resting series order.
 *   - "bid"       → Buy·Limit: escrows USDC (price × qty).
 *   - "resaleAsk" → Sell·Limit on HELD tokens: escrows `quantity` contracts.
 * Caller must guarantee a held balance for resaleAsk.
 */
export async function postSeriesOrder(
  program: Program<any>, ref: SeriesRef, kind: "bid" | "resaleAsk",
  priceMicro: BN, quantity: number, nonce: BN, ctx?: OrderCtx,
): Promise<string> {
  const c = ctx ?? (await loadOrderCtx(program));
  const a = await seriesAccounts(program, ref);
  const owner = program.provider.publicKey!;
  const order = pda([Buffer.from(RESTING_ORDER_SEED), a.optionMint.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
  const escrow = pda([Buffer.from(RESTING_ORDER_ESCROW_SEED), order.toBuffer()]);
  const ownerOption = getAssociatedTokenAddressSync(a.optionMint, owner, false, TOKEN_2022_PROGRAM_ID);
  const ownerUsdc = getAssociatedTokenAddressSync(c.usdcMint, owner, false, TOKEN_PROGRAM_ID);
  const kindArg = kind === "bid" ? { bid: {} } : { resaleAsk: {} };
  return program.methods.postOrder(kindArg, priceMicro, new BN(quantity), nonce).accountsStrict({
    owner, sharedVault: a.vault, market: a.market, vaultMintRecord: a.record, optionMint: a.optionMint,
    order, escrow, protocolState: c.protocolState, ownerOptionAccount: ownerOption, ownerUsdcAccount: ownerUsdc,
    usdcMint: c.usdcMint, transferHookProgram: TRANSFER_HOOK_PROGRAM_ID, extraAccountMetaList: a.eaml, hookState: a.hookState,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(400_000)]).rpc();
}

/** A resting order the taker is about to fill. */
export interface FillableOrder {
  pubkey: string;
  owner: string;       // maker
  optionMint: string;
  vault: string;
  kind: "bid" | "resaleAsk" | "writerAsk" | "vaultPeg";
}

/**
 * Take a resting order: fill_order.
 *   - Filling an ASK (resaleAsk) → Buy: taker pays USDC, receives contracts.
 *   - Filling a BID → Sell: taker delivers contracts, maker pays USDC.
 * Taker funds whichever option ATA is the recipient (idempotent create).
 */
export async function fillSeriesOrder(
  program: Program<any>, order: FillableOrder, quantity: number, ctx?: OrderCtx,
): Promise<string> {
  const c = ctx ?? (await loadOrderCtx(program));
  const taker = program.provider.publicKey!;
  const maker = new PublicKey(order.owner);
  const optionMint = new PublicKey(order.optionMint);
  const vault = new PublicKey(order.vault);
  const eaml = deriveExtraAccountMetaListPda(optionMint)[0];
  const hookState = deriveHookStatePda(optionMint)[0];
  const takerUsdc = getAssociatedTokenAddressSync(c.usdcMint, taker, false, TOKEN_PROGRAM_ID);
  const makerUsdc = getAssociatedTokenAddressSync(c.usdcMint, maker, false, TOKEN_PROGRAM_ID);
  const takerOption = getAssociatedTokenAddressSync(optionMint, taker, false, TOKEN_2022_PROGRAM_ID);
  const makerOption = getAssociatedTokenAddressSync(optionMint, maker, false, TOKEN_2022_PROGRAM_ID);
  // The option recipient depends on side: ask fill → taker receives; bid fill → maker receives.
  const recipient = order.kind === "bid" ? maker : taker;
  const recipientAta = order.kind === "bid" ? makerOption : takerOption;
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, recipientAta, recipient, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  return program.methods.fillOrder(new BN(quantity)).accountsStrict({
    taker, optionMint, order: new PublicKey(order.pubkey), maker, sharedVault: vault,
    escrow: pda([Buffer.from(RESTING_ORDER_ESCROW_SEED), new PublicKey(order.pubkey).toBuffer()]),
    protocolState: c.protocolState, treasury: c.treasury,
    takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOption, makerOptionAccount: makerOption,
    transferHookProgram: TRANSFER_HOOK_PROGRAM_ID, extraAccountMetaList: eaml, hookState,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).preInstructions([CU(400_000), ataIx]).rpc();
}
