import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { Buffer } from "buffer";
import idl from "../../../app/src/idl/opta.json";
import { PROGRAM_ID } from "../constants";

export function createOptaProgram(connection: Connection): Program {
  const provider = { connection } as any;
  return new Program({ ...(idl as any), address: PROGRAM_ID.toBase58() }, provider);
}

export async function safeFetchAll<T = any>(
  program: Program,
  accountName:
    | "optionsMarket"
    | "sharedVault"
    | "vaultMint"
    | "vaultResaleListing"
    | "protocolState"
): Promise<{ publicKey: any; account: T }[]> {
  const idlAccountName = {
    optionsMarket: "OptionsMarket",
    sharedVault: "SharedVault",
    vaultMint: "VaultMint",
    vaultResaleListing: "VaultResaleListing",
    protocolState: "ProtocolState"
  }[accountName];
  const accountDef = (idl as any).accounts?.find((account: any) => account.name === idlAccountName);
  const discriminator = accountDef?.discriminator as number[] | undefined;
  if (!discriminator) return [];

  try {
    const rawAccounts = await program.provider.connection.getProgramAccounts(program.programId, {
      filters: [{
        memcmp: {
          offset: 0,
          bytes: bs58Encode(Buffer.from(discriminator))
        }
      }]
    });
    const decoded: { publicKey: any; account: T }[] = [];
    for (const raw of rawAccounts) {
      const data = Buffer.from(raw.account.data);
      const manuallyDecoded = decodeAccount(accountName, data);
      if (manuallyDecoded) {
        decoded.push({
          publicKey: raw.pubkey,
          account: manuallyDecoded as T
        });
        continue;
      }

      try {
        const account = program.coder.accounts.decode(accountName, data) as any;
        if (accountName === "optionsMarket" && !isValidOptionsMarket(account)) continue;
        decoded.push({
          publicKey: raw.pubkey,
          account: account as T
        });
      } catch {
        try {
          const account = program.coder.accounts.decode(idlAccountName, data) as any;
          if (accountName === "optionsMarket" && !isValidOptionsMarket(account)) continue;
          decoded.push({
            publicKey: raw.pubkey,
            account: account as T
          });
        } catch {
          // Ignore legacy/corrupt devnet accounts that do not match the current IDL.
        }
      }
    }
    return decoded;
  } catch (err) {
    console.warn(`[opta-mobile] failed to fetch ${accountName}`, err);
    return [];
  }
}

function decodeAccount(accountName: string, data: Buffer): any | null {
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
  const account = {
    assetName,
    pythFeedId: Array.from(data.subarray(pythOffset, pythOffset + 32)),
    assetClass,
    bump: byteAt(data, pythOffset + 33),
    oracleSource: data.length > pythOffset + 34 ? byteAt(data, pythOffset + 34) : 0
  };
  return isValidOptionsMarket(account) ? account : null;
}

function parseSharedVault(data: Buffer): any | null {
  if (data.length < 241) return null;
  return {
    market: pubkeyAt(data, 8),
    optionType: byteAt(data, 40) === 0 ? { call: {} } : { put: {} },
    strikePrice: bnLe(data, 41, 8),
    expiry: bnLe(data, 49, 8),
    vaultType: byteAt(data, 57) === 0 ? { epoch: {} } : { custom: {} },
    totalCollateral: bnLe(data, 58, 8),
    totalShares: bnLe(data, 66, 8),
    vaultUsdcAccount: pubkeyAt(data, 74),
    collateralMint: pubkeyAt(data, 106),
    totalOptionsMinted: bnLe(data, 138, 8),
    totalOptionsSold: bnLe(data, 146, 8),
    netPremiumCollected: bnLe(data, 154, 8),
    isSettled: byteAt(data, 178) === 1,
    settlementPrice: bnLe(data, 179, 8),
    collateralRemaining: bnLe(data, 187, 8),
    creator: pubkeyAt(data, 195),
    createdAt: bnLe(data, 227, 8),
    bump: byteAt(data, 235),
    carryRateBps: data.length >= 240 ? bnLe(data, 236, 4) : new BN(0),
    exerciseStyle: data.length > 240 && byteAt(data, 240) === 1 ? { american: {} } : { european: {} },
    exercisedOptions: data.length >= 249 ? bnLe(data, 241, 8) : new BN(0),
    earlyExercisePayout: data.length >= 257 ? bnLe(data, 249, 8) : new BN(0),
    spreadBps: data.length >= 259 ? numberLe(data, 257, 2) : 0,
    voided: data.length > 259 ? byteAt(data, 259) === 1 : false
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
    account.assetName.length > 0 &&
    typeof account.assetClass === "number" &&
    account.assetClass >= 0 &&
    account.assetClass <= 4
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
