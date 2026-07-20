import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as path from "path"; import type { Opta } from "@app/idl/opta";
const PROG=new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const amt=(d:Buffer|Uint8Array)=>Buffer.from(d).readBigUInt64LE(64);
const own=(d:Buffer|Uint8Array)=>new PublicKey(Buffer.from(d).subarray(32,64));
(async()=>{
  const c=new Connection(process.env.OPTA_RPC_URL!,"confirmed");
  const p=new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname,"..","app","src","idl","opta.json"),"utf-8")) as Opta,new anchor.AnchorProvider(c,new anchor.Wallet(Keypair.generate()),{commitment:"confirmed"}));
  const [mkt]=PublicKey.findProgramAddressSync([Buffer.from("market"),Buffer.from("NVDA")],PROG);
  const d=(p.coder.accounts as any).memcmp("sharedVault");
  const raw=await c.getProgramAccounts(PROG,{filters:[{memcmp:d}]});
  for(const {pubkey,account} of raw){
    let v:any; try{v=p.coder.accounts.decode("sharedVault",account.data);}catch{continue;}
    if(new PublicKey(v.market).toBase58()!==mkt.toBase58())continue;
    let usdc=0n,ownr="-";
    try{const ta=await c.getAccountInfo(new PublicKey(v.vaultUsdcAccount)); if(ta){usdc=amt(ta.data);ownr=own(ta.data).toBase58();}}catch{}
    console.log(`vault ${pubkey.toBase58()}`);
    console.log(`  settled=${v.isSettled} voided=${v.voided} strike=$${Number(v.strikePrice)/1e6} expiry=${Number(v.expiry)}`);
    console.log(`  total_collateral=${v.totalCollateral?.toString?.()} total_shares=${v.totalShares?.toString?.()}`);
    console.log(`  vault_usdc RAW micro = ${usdc}  ( = $${(Number(usdc)/1e6).toFixed(6)} )  ata_owner=${ownr}`);
  }
})().catch(e=>console.log("ERR",e.message));
