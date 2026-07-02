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

// Writer-ask PDA seeds — mirror programs/opta/src/state/writer_ask_{pot,position}.rs
// (verified literals). Defined locally rather than in constants.ts to keep this
// slice to the four FE files (the flip/CSP edits to constants.ts are separate).
const WRITER_ASK_POT_SEED = "writer_ask_pot";
const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";
const WRITER_ASK_POSITION_SEED = "writer_ask_position";

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
 * Post a resting series order. The account block is identical across all kinds —
 * the escrow SOURCE differs by kind (protocol pulls from the right account):
 *   - "bid"       → Buy·Limit: escrows USDC (price × qty) from ownerUsdcAccount.
 *   - "resaleAsk" → Sell·Limit on HELD tokens: escrows `quantity` contracts
 *                   from ownerOptionAccount. Caller must guarantee a held balance.
 *   - "writerAsk" → Sell·Limit by WRITING new contracts: escrows USDC collateral
 *                   (collateral_per_contract × qty, protocol-set = vault strike)
 *                   from ownerUsdcAccount. American, canonical-mint series only;
 *                   collateral is derived on-chain (NOT the priceMicro arg, which
 *                   is the maker's ask premium). Caller must hold strike × qty USDC.
 */
export async function postSeriesOrder(
  program: Program<any>, ref: SeriesRef, kind: "bid" | "resaleAsk" | "writerAsk",
  priceMicro: BN, quantity: number, nonce: BN, ctx?: OrderCtx,
): Promise<string> {
  const c = ctx ?? (await loadOrderCtx(program));
  const a = await seriesAccounts(program, ref);
  const owner = program.provider.publicKey!;
  const order = pda([Buffer.from(RESTING_ORDER_SEED), a.optionMint.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
  const escrow = pda([Buffer.from(RESTING_ORDER_ESCROW_SEED), order.toBuffer()]);
  const ownerOption = getAssociatedTokenAddressSync(a.optionMint, owner, false, TOKEN_2022_PROGRAM_ID);
  const ownerUsdc = getAssociatedTokenAddressSync(c.usdcMint, owner, false, TOKEN_PROGRAM_ID);
  const kindArg = kind === "bid" ? { bid: {} } : kind === "resaleAsk" ? { resaleAsk: {} } : { writerAsk: {} };
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

/**
 * Take a WriterAsk resting order: fill_writer_ask. Distinct from fill_order —
 * the writer's contracts are MINTED on fill (mint-on-fill from the writer's
 * personal collateral), so the account set differs (writer-ask pot + position,
 * no maker option account, no transfer-hook accounts — mint_to does not fire the
 * hook). Account ORDER mirrors scripts/_smoke_writer_ask_devnet.ts (live 13/13).
 *   - premium = order.price_per_contract × quantity (deterministic; no slippage arg)
 *   - taker pays USDC, receives freshly-minted contracts.
 */
export async function fillWriterAsk(
  program: Program<any>, order: FillableOrder, quantity: number, ctx?: OrderCtx,
): Promise<string> {
  const c = ctx ?? (await loadOrderCtx(program));
  const taker = program.provider.publicKey!;
  const maker = new PublicKey(order.owner);
  const optionMint = new PublicKey(order.optionMint);
  const vault = new PublicKey(order.vault);
  const orderPk = new PublicKey(order.pubkey);
  const takerUsdc = getAssociatedTokenAddressSync(c.usdcMint, taker, false, TOKEN_PROGRAM_ID);
  const makerUsdc = getAssociatedTokenAddressSync(c.usdcMint, maker, false, TOKEN_PROGRAM_ID);
  const takerOption = getAssociatedTokenAddressSync(optionMint, taker, false, TOKEN_2022_PROGRAM_ID);
  const record = pda([Buffer.from(VAULT_MINT_RECORD_SEED), optionMint.toBuffer()]);
  const escrow = pda([Buffer.from(RESTING_ORDER_ESCROW_SEED), orderPk.toBuffer()]);
  const writerAskPot = pda([Buffer.from(WRITER_ASK_POT_SEED), optionMint.toBuffer()]);
  const writerAskPotUsdc = pda([Buffer.from(WRITER_ASK_POT_USDC_SEED), optionMint.toBuffer()]);
  const writerAskPosition = pda([Buffer.from(WRITER_ASK_POSITION_SEED), optionMint.toBuffer(), maker.toBuffer()]);
  // Taker's Token-2022 option ATA (mint-on-fill destination) + USDC ATA created
  // idempotently; maker USDC ATA created defensively (the writer normally already
  // has one from posting the ask, but guard against a closed account).
  const takerOptIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, takerOption, taker, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const takerUsdcIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, takerUsdc, taker, c.usdcMint, TOKEN_PROGRAM_ID);
  const makerUsdcIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, makerUsdc, maker, c.usdcMint, TOKEN_PROGRAM_ID);
  return program.methods.fillWriterAsk(new BN(quantity)).accountsStrict({
    taker, optionMint, order: orderPk, maker, sharedVault: vault,
    vaultMintRecord: record, escrow, protocolState: c.protocolState, treasury: c.treasury,
    takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOption,
    writerAskPot, writerAskPotUsdc, writerAskPosition, usdcMint: c.usdcMint,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).preInstructions([CU(400_000), takerOptIx, takerUsdcIx, makerUsdcIx]).rpc();
}

/**
 * Cancel a resting order (owner-only): cancel_order. Refunds the unfilled escrow
 * to the owner per kind — Bid/WriterAsk → USDC (ownerUsdcAccount); ResaleAsk →
 * contracts (ownerOptionAccount, Token-2022 + transfer hook). Owner-safe by
 * construction: the order PDA seed embeds owner.key() and closes to owner, so a
 * third party cannot derive/redirect it (the Slice-C refund-theft vector lived in
 * the permissionless sweep, not here). All 13 accounts are required every call
 * regardless of kind; the unused destination/hook accounts are still deserialized.
 * No instruction args (the nonce is read from the on-chain order).
 */
export async function cancelOrder(
  program: Program<any>, order: FillableOrder, ctx?: OrderCtx,
): Promise<string> {
  const c = ctx ?? (await loadOrderCtx(program));
  const owner = program.provider.publicKey!;
  const optionMint = new PublicKey(order.optionMint);
  const orderPk = new PublicKey(order.pubkey);
  const ownerOption = getAssociatedTokenAddressSync(optionMint, owner, false, TOKEN_2022_PROGRAM_ID);
  const ownerUsdc = getAssociatedTokenAddressSync(c.usdcMint, owner, false, TOKEN_PROGRAM_ID);
  return program.methods.cancelOrder().accountsStrict({
    owner, optionMint, order: orderPk,
    escrow: pda([Buffer.from(RESTING_ORDER_ESCROW_SEED), orderPk.toBuffer()]),
    protocolState: c.protocolState, ownerOptionAccount: ownerOption, ownerUsdcAccount: ownerUsdc,
    transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
    extraAccountMetaList: deriveExtraAccountMetaListPda(optionMint)[0],
    hookState: deriveHookStatePda(optionMint)[0],
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).preInstructions([CU(400_000)]).rpc();
}
