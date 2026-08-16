// Local /sb-exercise-american server for the step-7 browser burn.
//
// WHY THIS EXISTS: the VPS crank (/opt/opta-crank, HEAD d1d0471) predates the
// 2026-08-15 pot-arm work — `grep -c writerAskPot` on its
// switchboardExerciseAmerican.ts returns 0. It would build the 14-account legacy
// exercise, the program would see pot_leg = None, and a pot-only vault's
// shortfall would revert EarlyExercisePotRequired. So the browser must talk to
// THIS working tree, not to sb-create.opta.fyi, until the crank is redeployed.
//
// Run (from crank/):
//   OPTA_RPC_URL=<read rpc> OPTA_SB_CREATE_ENABLED=1 \
//   OPTA_SB_CREATE_PORT=8788 \
//   OPTA_SB_CREATE_ALLOW_ORIGINS=http://localhost:5173 \
//   npx ts-node --transpile-only -r tsconfig-paths/register _local_sb_endpoint.ts
//
// Signs nothing: the wallet below is a throwaway used only to load the read-only
// SB program for the quote fetch, exactly as the crank uses its own.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import path from "path";
import { startSbCreateMarketServer } from "./sbCreateMarketEndpoint";

(async () => {
  const rpc = process.env.OPTA_RPC_URL;
  if (!rpc) throw new Error("OPTA_RPC_URL required");
  const connection = new Connection(rpc, "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate()); // never signs a user tx
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = require(path.resolve(__dirname, "../app/src/idl/opta.json"));
  const program = new anchor.Program(idl as any, provider) as any;

  const handle = startSbCreateMarketServer({
    connection,
    wallet,
    program,
    // TEMPORARY (2026-08-16): timestamp every line so an endpoint build can be
    // aligned against the browser console for the same click.
    log: (level: string, msg: string, fields?: Record<string, unknown>) =>
      console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ?? {}) })),
  });

  console.log(JSON.stringify({
    level: "info",
    msg: "LOCAL sb endpoint up — point VITE_SB_CREATE_ENDPOINT at it",
    port: handle.port,
    note: "serves the WORKING-TREE pot-aware builder; the VPS build does not have it",
  }));

  process.on("SIGINT", () => { handle.close(); process.exit(0); });
})().catch((e) => { console.error("LOCAL ENDPOINT ERROR:", e?.message ?? e); process.exit(1); });
