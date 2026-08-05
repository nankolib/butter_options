// =============================================================================
// ixDecode.ts — instruction decoding for the three user actions with NO event
// =============================================================================
//
// Phase 0 recon found three point-bearing instructions that emit nothing:
//
//   settle_expiry               permissionless settler   actor = accounts[0] caller
//   create_market               permissionless creator   actor = accounts[0] creator
//   reclaim_writer_ask_residual permissionless cranker   actor = accounts[0] cranker
//
// All three carry the actor at account index 0 (verified against the #[derive(Accounts)]
// structs, 2026-07-25). settle_expiry and create_market both have TRAILING optional
// Switchboard accounts; optional-account presence shifts nothing at indices 0-3, so
// extraction is stable across both the Pyth and SB paths.
//
// Discriminator = sha256("global:<snake_name>")[0..8] (Anchor convention).
// =============================================================================

import { createHash } from "node:crypto";

export interface IxTarget {
  /** Anchor instruction name (snake_case). */
  name: string;
  /** Synthetic tape event name. */
  eventName: string;
  /** Account index holding the acting wallet. */
  actorIndex: number;
  /** Extra account indices to capture, by label. */
  capture: Record<string, number>;
}

export const IX_TARGETS: IxTarget[] = [
  {
    name: "settle_expiry",
    eventName: "IxSettleExpiry",
    actorIndex: 0, // caller
    capture: { market: 1, settlement_record: 3 },
  },
  {
    // W2/O7 amendment (rules-v1.1). settle_vault is the USER-FACING settle act:
    // permissionless, oracle-free, no deadline. settle_expiry — the only thing
    // W2 credited under v1 — is structurally crank-owned for Switchboard markets,
    // where a signed quote is verifiable for only ~300s after expiry, so a user
    // could never realistically land one.
    //
    // ZERO BASE POINTS. This IX is quest-credit only: it is deliberately absent
    // from rules_v1's base-scoring switch, so it earns no takerPts, no makerPts
    // and no flat award. Adding one here would be a second, unreviewed scoring
    // surface.
    //
    // `settlement_record` is the (asset, expiry) tuple identity and is what W2
    // dedupes on — one click fanning 129 vaults emits 129 of these against ONE
    // settlement_record, and must count as ONE completion.
    name: "settle_vault",
    eventName: "IxSettleVault",
    actorIndex: 0, // authority (Signer)
    capture: { shared_vault: 1, market: 2, settlement_record: 3 },
  },
  {
    name: "create_market",
    eventName: "IxCreateMarket",
    actorIndex: 0, // creator
    capture: { market: 3 },
  },
  {
    name: "reclaim_writer_ask_residual",
    eventName: "IxReclaimWriterAskResidual",
    actorIndex: 0, // cranker
    capture: { vault: 1, writer_ask_position: 2 },
  },
];

function ixDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

const BY_DISC = new Map<string, IxTarget>(
  IX_TARGETS.map((t) => [ixDiscriminator(t.name).toString("hex"), t]),
);

/** Synthetic event names produced by ix decoding — allowlisted by construction. */
export const IX_EVENT_NAMES: readonly string[] = IX_TARGETS.map((t) => t.eventName);

export interface DecodedIx {
  target: IxTarget;
  actor: string;
  captured: Record<string, string | null>;
}

/**
 * Match one instruction's raw data against the ix-decode targets.
 *
 * `ixAccounts` must be THIS INSTRUCTION'S resolved account list (i.e.
 * message.accountKeys[ix.accounts[i]] in order), not the tx-wide key array —
 * the actorIndex/capture indices are positions in the #[derive(Accounts)] struct.
 *
 * Returns null when the instruction is not one of the three targets.
 */
export function matchIx(data: Uint8Array, ixAccounts: readonly string[]): DecodedIx | null {
  if (data.length < 8) return null;
  const target = BY_DISC.get(Buffer.from(data.subarray(0, 8)).toString("hex"));
  if (!target) return null;

  const actor = ixAccounts[target.actorIndex];
  if (!actor) return null;

  const captured: Record<string, string | null> = {};
  for (const [label, idx] of Object.entries(target.capture)) {
    captured[label] = ixAccounts[idx] ?? null;
  }
  return { target, actor, captured };
}
