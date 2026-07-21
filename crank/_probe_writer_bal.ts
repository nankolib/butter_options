import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
(async()=>{
  const rpc=process.env.OPTA_RPC_URL||fs.readFileSync(path.join(os.homedir(),".opta-rpc-helius"),"utf-8").trim();
  const c=new Connection(rpc,"confirmed");
  const W=new PublicKey("HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS");
  const usdc=new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");
  const ata=getAssociatedTokenAddressSync(usdc,W,true,TOKEN_PROGRAM_ID);
  const ai=await c.getAccountInfo(ata);
  const bal=ai?Number(Buffer.from(ai.data).readBigUInt64LE(64))/1e6:0;
  const sol=(await c.getBalance(W))/1e9;
  console.log(`writer USDC = $${bal.toLocaleString()}   SOL = ${sol.toFixed(4)}`);
  console.log(bal>1_000_000?"FUNDED ✅ (>$1M) — SEND landed":"NOT FUNDED (still ~$19k baseline) — SEND has NOT run");
})().catch(e=>console.log("ERR",e.message));
