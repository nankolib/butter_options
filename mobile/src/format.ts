import BN from "bn.js";

const MAX_SAFE_USDC_BN = new BN("9007199254740991");

export function usdcToNumber(amount: BN | number): number {
  if (typeof amount !== "number" && amount.gt(MAX_SAFE_USDC_BN)) {
    throw new Error("USDC amount exceeds JS safe integer boundary");
  }
  const raw = typeof amount === "number" ? amount : amount.toNumber();
  return raw / 1_000_000;
}

export function toUsdcBN(amount: number): BN {
  return new BN(Math.round(amount * 1_000_000));
}

export function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: value >= 1000 ? 0 : 2,
    maximumFractionDigits: value >= 1000 ? 0 : 2
  })}`;
}

export function shortAddress(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}_${address.slice(-4)}`;
}

export function shortDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC"
  });
}

export function countdown(unix: number): string {
  const diff = unix - Date.now() / 1000;
  if (diff <= 0) return "Expired";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function hexFromBytes(bytes: number[] | Uint8Array | Buffer): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += ((bytes as any)[i] & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}
