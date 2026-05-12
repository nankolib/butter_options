import posthog from "posthog-js";

/**
 * Typed wrapper around posthog.capture. Centralises the event-name
 * union and the per-event property shape so call sites can't drift.
 *
 * Identity (wallet pubkey) is tagged automatically by PostHog after
 * PostHogIdentity calls posthog.identify(); no need to pass it per
 * event. Cluster is the one shared context worth passing explicitly
 * since not every call site has useConnection() in scope.
 */

export type OptaEventName =
  | "vault_purchase_success"
  | "resale_buy_success"
  | "vault_create_success"
  | "vault_mint_success"
  | "premium_claim_success"
  | "collateral_withdraw_success"
  | "unsold_burn_success"
  | "faucet_click";

type SharedEventProps = {
  cluster?: "devnet" | "mainnet-beta" | "testnet" | "localnet";
};

type EventPropsByName = {
  vault_purchase_success: {
    vault: string;
    asset: string;
    strike: number;
    expiry: number;
    type: "call" | "put";
    qty: number;
    usdc_value: number;
    tx: string;
  };
  resale_buy_success: {
    vault: string;
    asset: string;
    strike: number;
    expiry: number;
    type: "call" | "put";
    qty: number;
    usdc_value: number;
    tx: string;
  };
  vault_create_success: {
    vault: string;
    asset: string;
    strike: number;
    expiry: number;
    type: "call" | "put";
    vault_type: "epoch" | "custom";
    collateral_usdc: number;
    tx: string;
  };
  vault_mint_success: {
    vault: string;
    asset: string;
    strike: number;
    expiry: number;
    type: "call" | "put";
    qty: number;
    premium_per_contract: number;
    tx: string;
  };
  premium_claim_success: { vault: string; tx: string };
  collateral_withdraw_success: { vault: string; tx: string };
  unsold_burn_success: { vault: string; unsold_count: number; tx: string };
  faucet_click: Record<string, never>;
};

export function trackOptaEvent<N extends OptaEventName>(
  name: N,
  props: EventPropsByName[N] & SharedEventProps,
): void {
  posthog.capture(name, props);
}
