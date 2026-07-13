import type { Connection } from "@solana/web3.js";

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const verifiedConnections = new WeakSet<Connection>();

export function isExpectedDevnetGenesisHash(genesisHash: string): boolean {
  return genesisHash === DEVNET_GENESIS_HASH;
}

export function assertExpectedDevnetGenesisHash(genesisHash: string): void {
  if (!isExpectedDevnetGenesisHash(genesisHash)) {
    throw new Error("RPC cluster mismatch: Opta Seeker is locked to Solana devnet.");
  }
}

/** Verifies a Connection once before any RPC data from it is treated as Opta devnet data. */
export async function ensureDevnetConnection(connection: Connection): Promise<void> {
  if (verifiedConnections.has(connection)) return;
  const genesisHash = await connection.getGenesisHash();
  assertExpectedDevnetGenesisHash(genesisHash);
  verifiedConnections.add(connection);
}
