// =============================================================================
// expiryLabel — the trade context strip's "07 AUG · 2D 18H" label. PURE.
// =============================================================================
//
// Extracted from TradePageV2.tsx so it can be unit-tested (see tvSymbol.ts for
// why pure modules carry the logic in this app).
//
// ── THE DATE MUST BE UTC ────────────────────────────────────────────────────
// Every expiry on chain is a UTC instant, ExpiryTabs.tsx:56 already renders in
// UTC, and this label sits DIRECTLY ABOVE those tabs. Formatting in browser-
// local time therefore puts two different dates for the same contract on one
// screen. The 2026-08-04 gap audit caught it on AAPL: expiry
// 2026-08-07T19:45:00Z rendered "08 AUG" here and "07 AUG" in the tab, for
// every user at UTC+04:15 or east — including the founder's own timezone.
//
// Crypto expiries are 08:00 UTC so they never crossed the boundary, which is
// why this hid until the equity board (19:45 UTC market-hours settle) shipped.
// =============================================================================

/**
 * "07 AUG · 2D 18H" — UTC date + time remaining. Past expiry → "07 AUG · EXPIRED".
 *
 * @param expiryTs unix seconds
 * @param nowMs    injectable clock (defaults to Date.now()) so the countdown is testable
 */
export function expiryCountdown(expiryTs: number, nowMs: number = Date.now()): string {
  const now = nowMs / 1000;
  const diff = expiryTs - now;
  const dateStr = new Date(expiryTs * 1000)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })
    .toUpperCase();
  if (diff <= 0) return `${dateStr} · EXPIRED`;
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return d > 0 ? `${dateStr} · ${d}D ${h}H` : `${dateStr} · ${h}H ${m}M`;
}
