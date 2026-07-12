// =============================================================================
// Formatting utilities for display
// =============================================================================

import BN from "bn.js";

// MED-5: JavaScript's Number.MAX_SAFE_INTEGER is 2^53-1 ≈ 9.007e15. USDC has
// 6 decimals, so the safe-integer boundary in USDC base units is ~$9 billion.
// BN.toNumber() throws past that. Both helpers below guard the boundary
// explicitly so the failure surfaces a clean error before BN's internal throw.
const MAX_SAFE_USDC_BN = new BN("9007199254740991");

/** Convert on-chain USDC amount (scaled by 10^6) to human-readable string. */
export function formatUsdc(amount: BN | number): string {
  if (typeof amount !== "number" && amount.gt(MAX_SAFE_USDC_BN)) {
    throw new Error(
      "formatUsdc: amount exceeds JS safe-integer boundary (~$9B in USDC base units)",
    );
  }
  const num = typeof amount === "number" ? amount : amount.toNumber();
  return (num / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Convert on-chain USDC amount to raw number (for calculations). */
export function usdcToNumber(amount: BN | number): number {
  if (typeof amount !== "number" && amount.gt(MAX_SAFE_USDC_BN)) {
    throw new Error(
      "usdcToNumber: amount exceeds JS safe-integer boundary (~$9B in USDC base units)",
    );
  }
  const num = typeof amount === "number" ? amount : amount.toNumber();
  return num / 1_000_000;
}

/** Convert human-readable USDC to on-chain scaled amount. */
export function toUsdcBN(amount: number): BN {
  return new BN(Math.round(amount * 1_000_000));
}

/** Format a Unix timestamp as a human-readable date. */
export function formatExpiry(timestamp: BN | number): string {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.toNumber();
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format a date as short string (e.g., "Apr 15"). */
export function formatExpiryShort(timestamp: BN | number): string {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.toNumber();
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** Truncate a public key for display (e.g., "CtzJ...z9Cq"). */
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Format an on-chain sample timestamp (unix seconds) as a muted staleness
 * stamp: `as of HH:MM UTC` (24h, zero-padded UTC hours:minutes). Used only for
 * markets whose spot comes from the on-chain sample fallback; live-fed markets
 * render no stamp. Generic wording — no data-source names.
 */
export function formatAsOfUtc(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `as of ${hh}:${mm} UTC`;
}

/**
 * Convert a 32-byte feed_id (Anchor [u8; 32] = number[] | Uint8Array | Buffer)
 * to lowercase 64-char hex with NO `0x` prefix. The pull-oracle API + our
 * on-chain registry both store/accept this canonical form.
 */
export function hexFromBytes(bytes: number[] | Uint8Array | Buffer): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = (bytes as any)[i] & 0xff;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Inverse of hexFromBytes — convert a 64-char hex string (with or without
 * `0x` prefix) into a `number[]` of length 32. Anchor accepts this shape
 * for its `[u8; 32]` argument type. Throws on invalid input so the caller
 * can surface a clean error.
 */
export function hexToBytes32(hex: string): number[] {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(
      `hexToBytes32: expected 64-char hex (with optional 0x prefix), got "${hex}"`,
    );
  }
  const out: number[] = new Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Get days until expiry from a Unix timestamp. */
export function daysUntilExpiry(timestamp: BN | number): number {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.toNumber();
  const now = Date.now() / 1000;
  return Math.max(0, (ts - now) / 86400);
}

/** Check if a market has expired. */
export function isExpired(timestamp: BN | number): boolean {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.toNumber();
  return Date.now() / 1000 >= ts;
}
