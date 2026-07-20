import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path"; import type { Opta } from "@app/idl/opta";
const PROG=new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const F:Record<string,string>={MSFT:"b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56",AAPL:"d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8",GOOGL:"c47268fa603180997ab954702ef058dcf56d97f597085d095278dfffd37c9103",AMZN:"bf3190ce3b040d25d1af35c66461fe8fee2f7dd4c83e72e5c13dcc89929abf3f",META:"56bb4c5863ad44b5c59d75cce27d170f8c05e50b9698c9a27480bc7c47f11570",NVDA:"5378913080bd823885beb8cc37d55842d438e2198f8ce711b7385b527a542bdf",AMD:"28fcb07fb1301a399cbe35b809cd8ffa45a22f5bd4e3a15845b4fca219846668",TSLA:"24f5404db181873fead6fd9ad15c7edc2265e8b7a494b3168055fa3bfbb3ced3",COIN:"60e0a2d31235e2e3c7414635f3bf0c14c671098ef953b0823d380913d627c868",MSTR:"5dc7af42f5237fb2d39aa65374c91234da9a92ba940ac9a5613b51d59d9a830a",CRCL:"077acbc9a679e4660b8ace50be067bd08a443f1ea7c0a48b4b6e444c23c17040"};
(async()=>{
  const rpc=process.env.OPTA_RPC_URL!; const c=new Connection(rpc,"confirmed");
  const p=new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname,"..","app","src","idl","opta.json"),"utf-8")) as Opta,new anchor.AnchorProvider(c,new anchor.Wallet(Keypair.generate()),{commitment:"confirmed"}));
  for(const [t,h] of Object.entries(F)){
    const [pda]=PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"),Buffer.from(h,"hex")],PROG);
    let s="ABSENT";
    try{const o:any=await (p.account as any).volOracle.fetch(pda); s=`EXISTS src=${o.oracleSource} sc=${o.sampleCount} seed=${o.seedVol}`;}catch{}
    console.log(`${t.padEnd(6)} ${pda.toBase58()}  ${s}`);
  }
})().catch(e=>console.log("ERR",e.message));
