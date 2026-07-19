import * as anchor from "@coral-xyz/anchor"; import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path"; import type { Opta } from "@app/idl/opta";
(async()=>{const rpc=process.env.OPTA_RPC_URL!;const c=new Connection(rpc,{commitment:"confirmed"});
const p=new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname,"..","app","src","idl","opta.json"),"utf-8")) as Opta,new anchor.AnchorProvider(c,new anchor.Wallet(Keypair.generate()),{commitment:"confirmed"}));
const [mkt]=PublicKey.findProgramAddressSync([Buffer.from("market"),Buffer.from("SOL")],p.programId);
const m:any=await (p.account as any).optionsMarket.fetch(mkt);
const [vo]=PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"),Buffer.from(m.pythFeedId)],p.programId);
console.log(`reborn SOL market ${mkt.toBase58()} oracle_source=${m.oracleSource} feed=0x${Buffer.from(m.pythFeedId).toString("hex").slice(0,16)}`);
const exp=Math.floor(Date.parse("2026-07-31T08:00:00Z")/1000);
for(const strike of [80,120,160,180,200]){
const ix=await p.methods.getOptionPrice(new BN(strike*1e6),new BN(exp),{call:{}} as any,{american:{}} as any,0).accountsStrict({market:mkt,volOracle:vo}).instruction();
const{blockhash}=await c.getLatestBlockhash();
const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey("DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ"),recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ix]}).compileToV0Message());
const sim=await c.simulateTransaction(tx,{sigVerify:false});
if(sim.value.err){console.log(`❌ SOL $${strike} CALL Jul-31 ERR`,JSON.stringify(sim.value.err),(sim.value.logs??[]).filter(l=>/Error Message/i.test(l)).slice(-1).join(""));}
else{const b=Buffer.from(sim.value.returnData!.data[0],"base64");const u=(o:number)=>Number(new BN(b.subarray(o,o+8),"le").toString());
console.log(`✅ SOL $${strike} CALL Jul-31: premium=$${(u(0)/1e6).toFixed(2)} vol=${(u(8)/1e12*100).toFixed(1)}% spot=$${(u(16)/1e12).toFixed(2)}`);}}
})().catch(e=>console.log("ERR",e.message));
