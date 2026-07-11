import { clusterApiUrl, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export { TOKEN_2022_PROGRAM_ID };

export const EXPECTED_CLUSTER = "devnet" as const;
export const OPTA_CHAIN = "solana:devnet";
export const RPC_ENDPOINT =
  process.env.EXPO_PUBLIC_RPC_URL || clusterApiUrl("devnet");
export const HERMES_BASE =
  process.env.EXPO_PUBLIC_HERMES_BASE || "https://hermes.pyth.network";

export const PROGRAM_ID = new PublicKey(
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq"
);
export const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG"
);

export const PROTOCOL_SEED = "protocol_v2";
export const TREASURY_SEED = "treasury_v2";
export const EPOCH_CONFIG_SEED = "epoch_config";
export const SHARED_VAULT_SEED = "shared_vault";
export const SHARED_VAULT_AMERICAN_SEED = "shared_vault_american";
export const VAULT_USDC_SEED = "vault_usdc";
export const WRITER_POSITION_SEED = "writer_position";
export const VAULT_MINT_RECORD_SEED = "vault_mint_record";
export const VAULT_OPTION_MINT_SEED = "vault_option_mint";
export const VAULT_PURCHASE_ESCROW_SEED = "vault_purchase_escrow";
export const VAULT_RESALE_ESCROW_SEED = "vault_resale_escrow";
export const VOL_ORACLE_SEED = "vol_oracle";

export const SERIES_OPTION_TYPE_CALL = 0;
export const SERIES_OPTION_TYPE_PUT = 1;
export const PHASE2_CUTOFF_TIMESTAMP = 1777226400;
