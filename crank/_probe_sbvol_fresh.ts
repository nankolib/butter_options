import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js"; import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
const FEEDS: Record<string,string> = { BTC:"baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2", ETH:"1d8f55a03da760d0f322bc1d066427e95573f651d506e0e31a5499659349caa3", SOL:"e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463", XRP:"a1c4ce28a9a4abd471fb2eb11236c299a3b02cad72f3f93437aa01578405f736", FARTCOIN:"9612492ea0fdac76ef82ee98f21eee60c98ebb5cc8a2810fc415e56a7357a5f2" };
(async()=>{const rpc=process.env.OPTA_RPC_URL!;const c=new Connection(rpc,{commitment:"confirmed"});
const p=new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname,"..","app","src","idl","opta.json"),"utf-8")) as Opta,new anchor.AnchorProvider(c,new anchor.Wallet(Keypair.generate()),{commitment:"confirmed"}));
const now=(await c.getBlockTime(await c.getSlot()))!;console.log("cluster now",new Date(now*1000).toISOString());
for(const[sym,hex]of Object.entries(FEEDS)){const[pda]=PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"),Buffer.from(hex,"hex")],p.programId);
try{const o:any=await (p.account as any).volOracle.fetch(pda);const ts=Number(o.lastSampleTs.toString());const ageH=((now-ts)/3600).toFixed(1);
console.log(`  ${sym.padEnd(9)} samples=${o.sampleCount} last=${new Date(ts*1000).toISOString()} age=${ageH}h ${(now-ts)>21600?"❌ STALE(>6h)":"✅ fresh"}`);}catch(e:any){console.log(`  ${sym} FETCH FAIL ${e.message}`);}}
})().catch(e=>console.log("ERR",e.message));
