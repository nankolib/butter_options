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
  const seen=new Map<string,number>(); const vaultCache=new Map<string,string>();
  for(const {account} of raw){ let r:any; try{r=p.coder.accounts.decode("restingOrder",account.data);}catch{continue;}
    if(!r.kind||!("writerAsk" in r.kind))continue;
    const vk=new PublicKey(r.vault).toBase58(); let asset=vaultCache.get(vk);
    if(!asset){ try{ const v:any=await (p.account as any).sharedVault.fetch(new PublicKey(r.vault)); const m:any=await (p.account as any).optionsMarket.fetch(new PublicKey(v.market)); asset=`${m.assetName}|strike=${Number(v.strikePrice)/1e6}|exp=${Number(v.expiry)}|${("put" in (v.optionType??{}))?"P":"C"}`; }catch{asset="?";} vaultCache.set(vk,asset); }
    if(asset.startsWith("XRP")) seen.set(asset,(seen.get(asset)??0)+1);
  }
  console.log("distinct XRP (strike,exp,side) series with a live ask:",seen.size);
  const strikes=new Set([...seen.keys()].map(k=>k.split("|")[1]));
  console.log("distinct XRP strikes:",[...strikes].sort().join(", "));
  console.log("(a clean ladder = 5 strikes; more = orphan accumulation)");
})().catch(e=>console.log("ERR",e.message));
