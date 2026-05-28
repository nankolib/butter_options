// =============================================================================
// smoke-walker-live.ts — live smoke against real mainnet Hermes
// =============================================================================
//
// Read-only. No tx submission, no on-chain interaction. Verifies the walker
// behaves correctly against the real Hermes endpoint, not just mocks.
//
// Two scenarios:
//   1. known-200 BTC expiry (2026-05-15 08:00 UTC) — walker should return a
//      VAA on the first probe.
//   2. gap-incident BTC expiry (2026-05-22 08:00 UTC) — walker should throw
//      with substring "HTTP 404" and the friendly toast text.
//
// Run:  cd app && npx tsx scripts/smoke-walker-live.ts
// =============================================================================

import { fetchHistoricalHermesUpdateInWindow } from "../src/utils/pythPullPost";

const BTC =
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

(async () => {
  let fails = 0;

  // --- Scenario A: known-good expiry, walker should return on first probe ---
  process.stdout.write("\n=== A. known-200 expiry (1778832000) ===\n");
  const tA0 = Date.now();
  try {
    const buf = await fetchHistoricalHermesUpdateInWindow(BTC, 1778832000, 60);
    const ms = Date.now() - tA0;
    process.stdout.write(
      `PASS: walker returned VAA (${buf.length} bytes) in ${ms} ms\n`,
    );
  } catch (e: any) {
    fails++;
    process.stdout.write(`FAIL: expected success, got: ${e?.message}\n`);
  }

  // --- Scenario B: gap-incident expiry, walker should throw with HTTP 404 ---
  process.stdout.write("\n=== B. gap-incident expiry (1779436800) ===\n");
  const tB0 = Date.now();
  try {
    await fetchHistoricalHermesUpdateInWindow(BTC, 1779436800, 60);
    fails++;
    process.stdout.write(
      `FAIL: expected throw on gap expiry, walker returned successfully\n`,
    );
  } catch (e: any) {
    const ms = Date.now() - tB0;
    const msg: string = e?.message ?? String(e);
    process.stdout.write(`THROW after ${ms} ms\n  message: ${msg}\n`);
    const checks: Array<[string, boolean]> = [
      ['contains "HTTP 404"', msg.includes("HTTP 404")],
      ['contains "60-second window"', msg.includes("60-second window")],
      ['contains "archive gap"', msg.includes("archive gap")],
      ['contains "expiry=1779436800"', msg.includes("expiry=1779436800")],
    ];
    for (const [label, ok] of checks) {
      process.stdout.write(`  ${ok ? "PASS" : "FAIL"}: ${label}\n`);
      if (!ok) fails++;
    }
  }

  process.stdout.write(`\n=== smoke complete: ${fails} failures ===\n`);
  process.exit(fails > 0 ? 1 : 0);
})();
