import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { Buffer } from "buffer";
import idl from "../idl/opta.json";
import { PROGRAM_ID } from "../constants";
import { ensureDevnetConnection } from "./cluster";

export type OptaAccountName =
  | "optionsMarket"
  | "sharedVault"
  | "vaultMint"
  | "vaultResaleListing"
  | "writerPosition"
  | "protocolState"
  | "epochConfig";

const IDL_ACCOUNT_NAMES: Readonly<Record<OptaAccountName, string>> = {
  optionsMarket: "OptionsMarket",
  sharedVault: "SharedVault",
  vaultMint: "VaultMint",
  vaultResaleListing: "VaultResaleListing",
  writerPosition: "WriterPosition",
  protocolState: "ProtocolState",
  epochConfig: "EpochConfig"
};

export class OptaAccountReadError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OptaAccountReadError";
    this.cause = cause;
  }
}

export function createOptaProgram(connection: Connection): Program {
  const provider = { connection } as any;
  return new Program({ ...(idl as any), address: PROGRAM_ID.toBase58() }, provider);
}

/** RPC libraries may return Buffer-like Uint8Arrays on React Native. */
export function normalizeAccountBytes(data: Buffer | Uint8Array): Buffer {
  return Buffer.from(data);
}

export async function safeFetchAll<T = any>(
  program: Program,
  accountName: OptaAccountName
): Promise<{ publicKey: any; account: T }[]> {
  await ensureDevnetConnection(program.provider.connection);
  const discriminator = accountDiscriminator(accountName);
  let rawAccounts: Awaited<ReturnType<Connection["getProgramAccounts"]>>;
  try {
    rawAccounts = await program.provider.connection.getProgramAccounts(program.programId, {
      filters: [{
        memcmp: {
          offset: 0,
          bytes: bs58Encode(Buffer.from(discriminator))
        }
      }]
    });
  } catch (err) {
    throw new OptaAccountReadError(`Couldn't load ${accountName} accounts.`, err);
  }

  const decoded: { publicKey: any; account: T }[] = [];
  for (const raw of rawAccounts) {
    if (!raw.account.owner.equals(program.programId)) {
      throw new OptaAccountReadError(`${accountName} scan returned an account owned by another program.`);
    }
    const data = normalizeAccountBytes(raw.account.data);
    if (!hasDiscriminator(data, discriminator)) {
      throw new OptaAccountReadError(`${accountName} scan returned an account with the wrong discriminator.`);
    }
    try {
      decoded.push({
        publicKey: raw.pubkey,
        account: decodeOptaAccount(accountName, data) as T
      });
    } catch (err) {
      // Opta has historical program-owned accounts with layouts that predate
      // the current IDL. They are not current records and must never be
      // coerced into live market state, but one legacy row must not disguise
      // every valid row as a transport failure either.
      console.warn(`Skipping unreadable ${accountName} account ${raw.pubkey.toBase58()}.`);
    }
  }
  return decoded;
}

export async function fetchDecodedAccount<T = any>(
  program: Program,
  accountName: OptaAccountName,
  publicKey: PublicKey
): Promise<{ publicKey: PublicKey; account: T } | null> {
  await ensureDevnetConnection(program.provider.connection);
  let info: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    info = await program.provider.connection.getAccountInfo(publicKey, "confirmed");
  } catch (err) {
    throw new OptaAccountReadError(`Couldn't load ${accountName} account ${publicKey.toBase58()}.`, err);
  }
  if (!info) return null;
  if (!info.owner.equals(program.programId)) {
    throw new OptaAccountReadError(`${accountName} account ${publicKey.toBase58()} has the wrong owner.`);
  }

  const data = normalizeAccountBytes(info.data);
  if (!hasDiscriminator(data, accountDiscriminator(accountName))) {
    throw new OptaAccountReadError(`${accountName} account ${publicKey.toBase58()} has the wrong discriminator.`);
  }
  try {
    return { publicKey, account: decodeOptaAccount(accountName, data) as T };
  } catch (err) {
    throw new OptaAccountReadError(`Couldn't decode ${accountName} account ${publicKey.toBase58()}.`, err);
  }
}

function accountDiscriminator(accountName: OptaAccountName): number[] {
  const idlAccountName = IDL_ACCOUNT_NAMES[accountName];
  const accountDef = (idl as any).accounts?.find((account: any) => account.name === idlAccountName);
  const discriminator = accountDef?.discriminator as number[] | undefined;
  if (!discriminator || discriminator.length !== 8) {
    throw new OptaAccountReadError(`IDL is missing the ${idlAccountName} discriminator.`);
  }
  return discriminator;
}

function hasDiscriminator(data: Buffer, discriminator: number[]): boolean {
  if (data.length < discriminator.length) return false;
  return discriminator.every((byte, index) => byteAt(data, index) === byte);
}

function decodeOptaAccount(accountName: OptaAccountName, data: Buffer): any {
  const manuallyDecoded = decodeAccount(accountName, data);
  if (!manuallyDecoded) {
    throw new OptaAccountReadError(`${IDL_ACCOUNT_NAMES[accountName]} has an unsupported or invalid layout.`);
  }
  return manuallyDecoded;
}

function decodeAccount(accountName: OptaAccountName, data: Buffer): any | null {
  try {
    switch (accountName) {
      case "optionsMarket":
        return parseOptionsMarket(data);
      case "sharedVault":
        return parseSharedVault(data);
      case "vaultMint":
        return parseVaultMint(data);
      case "vaultResaleListing":
        return parseVaultResaleListing(data);
      case "writerPosition":
        return parseWriterPosition(data);
      case "protocolState":
        return parseProtocolState(data);
      case "epochConfig":
        return parseEpochConfig(data);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function parseOptionsMarket(data: Buffer): any | null {
  if (data.length < 48) return null;
  const nameLength = numberLe(data, 8, 4);
  if (nameLength <= 0 || nameLength > 16 || data.length < 12 + nameLength + 34) return null;
  const pythOffset = 12 + nameLength;
  const assetName = asciiStringAt(data, 12, nameLength);
  const assetClass = byteAt(data, pythOffset + 32);
  const oracleSource = data.length > pythOffset + 34 ? byteAt(data, pythOffset + 34) : 0;
  const account = {
    assetName,
    pythFeedId: Array.from(data.subarray(pythOffset, pythOffset + 32)),
    assetClass,
    bump: byteAt(data, pythOffset + 33),
    oracleSource
  };
  return isValidOptionsMarket(account) ? account : null;
}

function parseSharedVault(data: Buffer): any | null {
  // 236 bytes is the original layout through `bump`; every later field is a
  // trailing append with a zero-default migration path.
  if (data.length < 236) return null;
  const optionType = enumByte(data, 40, 1, "option type");
  const vaultType = enumByte(data, 57, 1, "vault type");
  const exerciseStyle = data.length > 240
    ? enumByte(data, 240, 1, "exercise style")
    : 0;
  return {
    market: pubkeyAt(data, 8),
    optionType: optionType === 0 ? { call: {} } : { put: {} },
    strikePrice: bnLe(data, 41, 8),
    expiry: bnLe(data, 49, 8),
    vaultType: vaultType === 0 ? { epoch: {} } : { custom: {} },
    totalCollateral: bnLe(data, 58, 8),
    totalShares: bnLe(data, 66, 8),
    vaultUsdcAccount: pubkeyAt(data, 74),
    collateralMint: pubkeyAt(data, 106),
    totalOptionsMinted: bnLe(data, 138, 8),
    totalOptionsSold: bnLe(data, 146, 8),
    netPremiumCollected: bnLe(data, 154, 8),
    isSettled: boolAt(data, 178, "is settled"),
    settlementPrice: bnLe(data, 179, 8),
    collateralRemaining: bnLe(data, 187, 8),
    creator: pubkeyAt(data, 195),
    createdAt: bnLe(data, 227, 8),
    bump: byteAt(data, 235),
    carryRateBps: data.length >= 240 ? bnLe(data, 236, 4) : new BN(0),
    exerciseStyle: exerciseStyle === 1 ? { american: {} } : { european: {} },
    exercisedOptions: data.length >= 249 ? bnLe(data, 241, 8) : new BN(0),
    earlyExercisePayout: data.length >= 257 ? bnLe(data, 249, 8) : new BN(0),
    spreadBps: data.length >= 259 ? numberLe(data, 257, 2) : 0,
    voided: data.length > 259 ? boolAt(data, 259, "voided") : false
  };
}

function parseVaultMint(data: Buffer): any | null {
  if (data.length < 137) return null;
  return {
    vault: pubkeyAt(data, 8),
    writer: pubkeyAt(data, 40),
    optionMint: pubkeyAt(data, 72),
    premiumPerContract: bnLe(data, 104, 8),
    quantityMinted: bnLe(data, 112, 8),
    quantitySold: bnLe(data, 120, 8),
    createdAt: bnLe(data, 128, 8),
    bump: byteAt(data, 136)
  };
}

function parseVaultResaleListing(data: Buffer): any | null {
  if (data.length < 129) return null;
  return {
    seller: pubkeyAt(data, 8),
    vault: pubkeyAt(data, 40),
    optionMint: pubkeyAt(data, 72),
    listedQuantity: bnLe(data, 104, 8),
    pricePerContract: bnLe(data, 112, 8),
    createdAt: bnLe(data, 120, 8),
    bump: byteAt(data, 128)
  };
}

function parseWriterPosition(data: Buffer): any | null {
  if (data.length < 137) return null;
  return {
    owner: pubkeyAt(data, 8),
    vault: pubkeyAt(data, 40),
    shares: bnLe(data, 72, 8),
    depositedCollateral: bnLe(data, 80, 8),
    premiumClaimed: bnLe(data, 88, 8),
    premiumDebt: bnLe(data, 96, 16),
    optionsMinted: bnLe(data, 112, 8),
    optionsSold: bnLe(data, 120, 8),
    depositedAt: bnLe(data, 128, 8),
    bump: byteAt(data, 136)
  };
}

function parseProtocolState(data: Buffer): any | null {
  if (data.length < 123) return null;
  return {
    admin: pubkeyAt(data, 8),
    feeBps: numberLe(data, 40, 2),
    treasury: pubkeyAt(data, 42),
    usdcMint: pubkeyAt(data, 74),
    totalMarkets: bnLe(data, 106, 8),
    totalVolume: bnLe(data, 114, 8),
    bump: byteAt(data, 122)
  };
}

function parseEpochConfig(data: Buffer): any | null {
  if (data.length < 45) return null;
  const weeklyExpiryDay = byteAt(data, 40);
  const weeklyExpiryHour = byteAt(data, 41);
  const minEpochDurationDays = byteAt(data, 43);
  if (weeklyExpiryDay > 6 || weeklyExpiryHour > 23) {
    throw new Error("Epoch configuration contains an invalid schedule");
  }
  return {
    authority: pubkeyAt(data, 8),
    weeklyExpiryDay,
    weeklyExpiryHour,
    monthlyEnabled: boolAt(data, 42, "monthly enabled"),
    minEpochDurationDays,
    bump: byteAt(data, 44)
  };
}

function pubkeyAt(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function bnLe(data: Buffer, offset: number, length: number): BN {
  let value = new BN(0);
  for (let i = offset + length - 1; i >= offset; i -= 1) {
    value = value.ushln(8).addn(byteAt(data, i));
  }
  return value;
}

function numberLe(data: Buffer, offset: number, length: number): number {
  return bnLe(data, offset, length).toNumber();
}

function byteAt(data: Buffer, offset: number): number {
  const value = data[offset];
  if (typeof value !== "number") {
    throw new Error("Account data is not byte-addressable");
  }
  return value;
}

function boolAt(data: Buffer, offset: number, label: string): boolean {
  const value = byteAt(data, offset);
  if (value !== 0 && value !== 1) throw new Error(`${label} is not a valid boolean`);
  return value === 1;
}

function enumByte(data: Buffer, offset: number, max: number, label: string): number {
  const value = byteAt(data, offset);
  if (value < 0 || value > max) throw new Error(`${label} has an invalid variant`);
  return value;
}

function asciiStringAt(data: Buffer, offset: number, length: number): string {
  let value = "";
  for (let i = 0; i < length; i += 1) {
    value += String.fromCharCode(byteAt(data, offset + i));
  }
  return value;
}

function isValidOptionsMarket(account: any): boolean {
  return (
    typeof account.assetName === "string" &&
    /^[A-Z0-9]{1,16}$/.test(account.assetName) &&
    typeof account.assetClass === "number" &&
    account.assetClass >= 0 &&
    account.assetClass <= 4 &&
    (account.oracleSource === 0 || account.oracleSource === 1)
  );
}

function bs58Encode(bytes: Buffer): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let encoded = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded += "1";
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    encoded += alphabet[digits[i]];
  }
  return encoded;
}
