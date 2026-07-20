import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const c = new Connection(rpc, "confirmed");
  const usdc = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");
  const m = await getMint(c, usdc, "confirmed", TOKEN_PROGRAM_ID);
  console.log("USDC mint", usdc.toBase58());
  console.log("  mintAuthority:", m.mintAuthority?.toBase58() ?? "NONE");
  console.log("  decimals:", m.decimals, "supply:", (Number(m.supply) / 1e6).toLocaleString());
  console.log("  admin 5YRMuuoY is mintAuth?", m.mintAuthority?.toBase58() === "5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk");
  const PROG = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
  for (const n of ["SBXAU", "XAU"]) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(n)], PROG);
    const ai = await c.getAccountInfo(pda);
    console.log(`market ${n}: ${pda.toBase58()} ${ai ? "EXISTS" : "absent"}`);
  }
})().catch((e) => console.log("ERR", e.message));
