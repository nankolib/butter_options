import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as path from "path"; import type { Opta } from "@app/idl/opta";
const PROG=new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
(async()=>{
  const c=new Connection(process.env.OPTA_RPC_URL!,"confirmed");
  const p=new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname,"..","app","src","idl","opta.json"),"utf-8")) as Opta,new anchor.AnchorProvider(c,new anchor.Wallet(Keypair.generate()),{commitment:"confirmed"}));
  for(const t of ["GOOGL","AMZN","AMD","COIN","SPCX","HOOD"]){
    const [pda]=PublicKey.findProgramAddressSync([Buffer.from("market"),Buffer.from(t)],PROG);
    const ai=await c.getAccountInfo(pda);
    let s="FREE (true birth)";
    if(ai){ try{const m:any=p.coder.accounts.decode("optionsMarket",ai.data); s=`EXISTS src=${m.oracleSource} name=${m.assetName} class=${m.assetClass}`;}catch{s="EXISTS (undecodable)";} }
    console.log(`${t.padEnd(6)} ${pda.toBase58()}  ${s}`);
  }
})().catch(e=>console.log("ERR",e.message));
