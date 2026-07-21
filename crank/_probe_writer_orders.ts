import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path"; import type { Opta } from "@app/idl/opta";
const PROG=new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const W=new PublicKey("HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS");
(async()=>{
  const rpc=process.env.OPTA_RPC_URL!; const c=new Connection(rpc,"confirmed");
  const p=new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname,"..","app","src","idl","opta.json"),"utf-8")) as Opta,new anchor.AnchorProvider(c,new anchor.Wallet(Keypair.generate()),{commitment:"confirmed"}));
  const disc=(p.coder.accounts as any).memcmp("restingOrder");
  const raw=await c.getProgramAccounts(PROG,{filters:[{memcmp:disc},{memcmp:{offset:8,bytes:W.toBase58()}}]});
  const byMkt=new Map<string,number>(); let writerAsks=0;
  for(const {account} of raw){ let r:any; try{r=p.coder.accounts.decode("restingOrder",account.data);}catch{continue;}
    if(!r.kind||!("writerAsk" in r.kind))continue; writerAsks++;
    // resolve vault->market->asset via the vault account
    try{ const v:any=await (p.account as any).sharedVault.fetch(new PublicKey(r.vault));
      const m:any=await (p.account as any).optionsMarket.fetch(new PublicKey(v.market));
      byMkt.set(m.assetName,(byMkt.get(m.assetName)??0)+1);
    }catch{ byMkt.set("?",(byMkt.get("?")??0)+1); }
  }
  console.log("writer live WriterAsks (on-chain):",writerAsks);
  for(const [k,n] of [...byMkt.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(8)} ${n}`);
})().catch(e=>console.log("ERR",e.message));
