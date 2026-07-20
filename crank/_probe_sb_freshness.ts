import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as path from "path"; import type { Opta } from "@app/idl/opta";
const PROG=new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const F: Array<[string,string]> = [["BTC","baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2"],["ETH","1d8f55a03da760d0f322bc1d066427e95573f651d506e0e31a5499659349caa3"],["SOL","e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463"],["XRP","a1c4ce28a9a4abd471fb2eb11236c299a3b02cad72f3f93437aa01578405f736"],["FARTCOIN","9612492ea0fdac76ef82ee98f21eee60c98ebb5cc8a2810fc415e56a7357a5f2"],["XAU","6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e"],["MSFT","b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56"]];
(async()=>{
  const c=new Connection(process.env.OPTA_RPC_URL!,"confirmed");
  const p=new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname,"..","app","src","idl","opta.json"),"utf-8")) as Opta,new anchor.AnchorProvider(c,new anchor.Wallet(Keypair.generate()),{commitment:"confirmed"}));
  const now=Math.floor(Date.now()/1000);
  for(const [t,h] of F){
    const [pda]=PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"),Buffer.from(h,"hex")],PROG);
    try{const o:any=await (p.account as any).volOracle.fetch(pda);
      const ts=Number((o.lastSampleTs??0).toString()); const age=ts>0?(now-ts):-1;
      console.log(`${t.padEnd(9)} sc=${String(o.sampleCount).padStart(4)} lastSample=${age<0?"never":(age/60).toFixed(1)+"min ago"} ${age>=0&&age<21600?"FRESH":"STALE"}`);
    }catch{console.log(`${t.padEnd(9)} ABSENT`);}
  }
})().catch(e=>console.log("ERR",e.message));
