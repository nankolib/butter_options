// scripts/scan-zero-feed-markets.ts
// =============================================================================
// Pre-redeploy gate: scan all OptionsMarket accounts on devnet and abort if
// any have an all-zeros pyth_feed_id. Required before deploying any program
// version that adds a runtime check rejecting zero-feed markets (e.g. Run-7
// audit-fix arc's HIGH-3 guard at create_shared_vault.rs).
//
// Run (from repo root):
//   OPTA_RPC_URL="<endpoint>" npx ts-node --compiler-options '{"module":"commonjs","esModuleInterop":true}' scripts/scan-zero-feed-markets.ts
//
// Public devnet fallback if OPTA_RPC_URL is unset.
//
// Implementation note: uses raw getProgramAccounts + manual byte parsing
// rather than Anchor's program.account.optionsMarket.all() to avoid
// any IDL-deserialization issues. The pythFeedId is found by scanning
// past the discriminator + variable-length asset_name, which Anchor
// serializes as 4-byte LE length + UTF-8 bytes.
//
// Exit codes:
//   0 — clean: no zero-feed markets exist; safe to redeploy
//   1 — ABORT: at least one zero-feed market detected; fix before deploy
// =============================================================================

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");

// Anchor account discriminator: sha256("account:<TypeName>")[..8].
function accountDiscriminator(name: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

function hexFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += (b & 0xff).toString(16).padStart(2, "0");
  return out;
}

function redactRpc(url: string): string {
  return url.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
}

async function main(): Promise<void> {
  const rpc = process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");

  console.log("rpc:        ", redactRpc(rpc));
  console.log("program id: ", PROGRAM_ID.toBase58());
  console.log("");

  const disc = accountDiscriminator("OptionsMarket");
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(disc) } },
    ],
  });

  console.log(`fetched ${accounts.length} OptionsMarket account(s)`);
  console.log("");

  // OptionsMarket layout (per programs/opta/src/state/market.rs):
  //   bytes 0..8: discriminator
  //   bytes 8..12: asset_name length (Anchor String = LE u32)
  //   bytes 12..(12+len): asset_name UTF-8
  //   bytes (12+len)..(12+len+32): pyth_feed_id [u8; 32]
  //   byte (12+len+32): asset_class u8
  //   byte (12+len+33): bump u8
  const offenders: { name: string; pda: string; feedHex: string }[] = [];

  for (const { pubkey, account } of accounts) {
    const data = account.data;
    if (data.length < 12) {
      console.log(`  ⚠ SKIP   ${pubkey.toBase58()}  (too short: ${data.length} bytes)`);
      continue;
    }
    const nameLen = data.readUInt32LE(8);
    if (nameLen > 16 || data.length < 12 + nameLen + 32) {
      console.log(`  ⚠ SKIP   ${pubkey.toBase58()}  (malformed; nameLen=${nameLen}, dataLen=${data.length})`);
      continue;
    }
    const name = data.subarray(12, 12 + nameLen).toString("utf-8");
    const feed = data.subarray(12 + nameLen, 12 + nameLen + 32);
    const isZero = feed.every((b: number) => b === 0);
    const feedHex = hexFromBytes(feed);
    const trunc = `${feedHex.slice(0, 8)}…${feedHex.slice(-8)}`;
    const tag = isZero ? "❌ ZERO" : "OK";
    console.log(`  ${tag.padEnd(6)} ${name.padEnd(8)} ${pubkey.toBase58()}  feed=${trunc}`);
    if (isZero) {
      offenders.push({ name, pda: pubkey.toBase58(), feedHex });
    }
  }

  console.log("");
  if (offenders.length === 0) {
    console.log(`✓ clean: ${accounts.length} markets scanned, none have zero feed_id`);
    console.log("safe to redeploy");
    process.exit(0);
  }

  console.error(`ABORT: ${offenders.length} market(s) have zero pyth_feed_id`);
  for (const o of offenders) {
    console.error(`  ${o.name}: ${o.pda}`);
  }
  console.error("");
  console.error("These markets would be bricked by the new HIGH-3 guard at");
  console.error("create_shared_vault.rs. Migrate them to real feeds via");
  console.error("migrate_pyth_feed before redeploying.");
  process.exit(1);
}

main().catch((err: any) => {
  console.error("FATAL:", err?.message ?? err);
  if (err?.logs) console.error("Logs:", err.logs);
  process.exit(1);
});
