// =============================================================================
// test-window-walk.ts — standalone behavioral test for the window-walker
// =============================================================================
//
// Runs 7 cases against a local node:http mock that impersonates Hermes,
// pointing the walker at it via the hermesBase parameter. No new deps.
//
// Run:  cd app && npx tsx scripts/test-window-walk.ts
//       (or with any installed TS runner)
// =============================================================================

import * as http from "node:http";
import { AddressInfo } from "node:net";
import { fetchHistoricalHermesUpdateInWindow } from "../src/utils/pythPullPost";

const FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const EXPIRY = 1779436800;

type CallEntry = { ts: number; at: number };

// Per-offset response config keyed by ts. If a ts isn't in the map, the
// server returns `defaultStatus` (404 by default). `alwaysStatus` lets a
// single ts return a specific status every call — used for the 429 cases.
interface MockSpec {
  responses?: Map<number, { status: number; bodyText?: string }>;
  defaultStatus?: number;
  defaultBodyText?: string;
  callLog: CallEntry[];
}

function startMock(
  spec: MockSpec,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const path = req.url?.split("?")[0] ?? "";
      const m = path.match(/^\/v2\/updates\/price\/(\d+)$/);
      if (!m) {
        res.statusCode = 404;
        res.end("bad path");
        return;
      }
      const ts = parseInt(m[1], 10);
      spec.callLog.push({ ts, at: Date.now() });
      const cfg = spec.responses?.get(ts);
      const status = cfg?.status ?? spec.defaultStatus ?? 404;
      if (status === 200) {
        const fakeVaa = Buffer.from(`fake-vaa-ts-${ts}`).toString("base64");
        const json = {
          binary: { encoding: "base64", data: [fakeVaa] },
          parsed: [
            {
              price: { publish_time: ts, price: "1", expo: -8, conf: "0" },
            },
          ],
        };
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(json));
      } else {
        res.statusCode = status;
        const bodyText =
          cfg?.bodyText ??
          spec.defaultBodyText ??
          (status === 429 ? '{"error":"too many requests"}' : "Update data not found");
        res.end(bodyText);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let passes = 0;
let fails = 0;

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    await fn();
    process.stdout.write(`PASS\n`);
    passes++;
  } catch (e: any) {
    process.stdout.write(`FAIL: ${e?.message ?? e}\n`);
    if (e?.stack) process.stdout.write(`${e.stack}\n`);
    fails++;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: missing substring "${needle}" in: ${haystack}`);
  }
}

(async () => {
  // -------------------------------------------------------------------------
  // Case 1 — Common case: 200 at +0
  // -------------------------------------------------------------------------
  await run("1. common — 200 at +0, single fetch", async () => {
    const spec: MockSpec = {
      responses: new Map([[EXPIRY + 0, { status: 200 }]]),
      callLog: [],
    };
    const m = await startMock(spec);
    try {
      const buf = await fetchHistoricalHermesUpdateInWindow(
        FEED,
        EXPIRY,
        60,
        `http://127.0.0.1:${m.port}`,
      );
      assertEq(spec.callLog.length, 1, "fetch count");
      assertContains(buf.toString(), `fake-vaa-ts-${EXPIRY}`, "returned VAA");
    } finally {
      await m.close();
    }
  });

  // -------------------------------------------------------------------------
  // Case 2 — Small gap: 200 at +3; walker refines bracket [2..2]
  // Expected probes: +0=404, +1=404, +3=200, refine +2=404 → return +3
  // -------------------------------------------------------------------------
  await run("2. small gap — 200 at +3, refine [2..2]", async () => {
    const spec: MockSpec = {
      responses: new Map([[EXPIRY + 3, { status: 200 }]]),
      callLog: [],
    };
    const m = await startMock(spec);
    try {
      const buf = await fetchHistoricalHermesUpdateInWindow(
        FEED,
        EXPIRY,
        60,
        `http://127.0.0.1:${m.port}`,
      );
      // Offsets queried (in order): 0, 1, 3, then refine 2.
      assertEq(spec.callLog.length, 4, "fetch count");
      const offsets = spec.callLog.map((c) => c.ts - EXPIRY);
      assertEq(JSON.stringify(offsets), JSON.stringify([0, 1, 3, 2]), "offset order");
      assertContains(buf.toString(), `fake-vaa-ts-${EXPIRY + 3}`, "returned VAA");
    } finally {
      await m.close();
    }
  });

  // -------------------------------------------------------------------------
  // Case 3 — Refine: 200 at +7; bracket [4..6] all 404 → return +7
  // Expected: 0,1,3,7,4,5,6 = 7 fetches
  // -------------------------------------------------------------------------
  await run("3. refine — 200 at +7, refine [4..6] all 404", async () => {
    const spec: MockSpec = {
      responses: new Map([[EXPIRY + 7, { status: 200 }]]),
      callLog: [],
    };
    const m = await startMock(spec);
    try {
      const buf = await fetchHistoricalHermesUpdateInWindow(
        FEED,
        EXPIRY,
        60,
        `http://127.0.0.1:${m.port}`,
      );
      assertEq(spec.callLog.length, 7, "fetch count");
      const offsets = spec.callLog.map((c) => c.ts - EXPIRY);
      assertEq(JSON.stringify(offsets), JSON.stringify([0, 1, 3, 7, 4, 5, 6]), "offset order");
      assertContains(buf.toString(), `fake-vaa-ts-${EXPIRY + 7}`, "returned VAA");
    } finally {
      await m.close();
    }
  });

  // -------------------------------------------------------------------------
  // Case 4 — Full-window gap: all 404 → throws with "HTTP 404"
  // Expected: exactly 7 exp probes, no refine
  // -------------------------------------------------------------------------
  await run("4. full-window gap — all 404, throws HTTP 404", async () => {
    const spec: MockSpec = { responses: new Map(), callLog: [] };
    const m = await startMock(spec);
    try {
      let thrown: Error | null = null;
      try {
        await fetchHistoricalHermesUpdateInWindow(
          FEED,
          EXPIRY,
          60,
          `http://127.0.0.1:${m.port}`,
        );
      } catch (e: any) {
        thrown = e;
      }
      if (!thrown) throw new Error("expected throw, got resolution");
      assertContains(thrown.message, "HTTP 404", "error.message");
      assertContains(thrown.message, "60-second window", "error.message");
      assertEq(spec.callLog.length, 7, "fetch count");
    } finally {
      await m.close();
    }
  });

  // -------------------------------------------------------------------------
  // Case 5 — Single 429 (no abort): +1 returns 429 always; +3 returns 200
  // Expected: probe(+0)=404, probe(+1)=429→retry=429 (consec=1, no abort),
  //           probe(+3)=200 → return +3. Refine is INTENTIONALLY SKIPPED
  //           because the immediately-prior offset (+1) was 429 not 404 —
  //           a rate-limited probe doesn't prove the bracket is empty.
  // Fetch count: 0(1) + 1(2 from retry) + 3(1) = 4
  // Wait between the two +1 calls must be ≥ ~1900 ms (rate-limit retry).
  // -------------------------------------------------------------------------
  await run("5. single 429-after-retry (no abort) — recovers, returns +3", async () => {
    const spec: MockSpec = {
      responses: new Map<number, { status: number; bodyText?: string }>([
        [EXPIRY + 1, { status: 429, bodyText: '{"error":"too many requests"}' }],
        [EXPIRY + 3, { status: 200 }],
      ]),
      callLog: [],
    };
    const m = await startMock(spec);
    try {
      const buf = await fetchHistoricalHermesUpdateInWindow(
        FEED,
        EXPIRY,
        60,
        `http://127.0.0.1:${m.port}`,
      );
      assertEq(spec.callLog.length, 4, "fetch count");
      const offsets = spec.callLog.map((c) => c.ts - EXPIRY);
      assertEq(JSON.stringify(offsets), JSON.stringify([0, 1, 1, 3]), "offset order");
      // Two consecutive +1 calls — the gap is the rate-limit retry wait.
      const t1a = spec.callLog[1].at;
      const t1b = spec.callLog[2].at;
      const retryGap = t1b - t1a;
      if (retryGap < 1900) {
        throw new Error(`retry gap too small: ${retryGap}ms (expected ≥ 1900)`);
      }
      assertContains(buf.toString(), `fake-vaa-ts-${EXPIRY + 3}`, "returned VAA");
    } finally {
      await m.close();
    }
  });

  // -------------------------------------------------------------------------
  // Case 6 — Consecutive 429 abort: +0 and +1 both return 429 always.
  // After +0 retry=429 (consec=1), throttle 500ms, +1 retry=429 (consec=2),
  // ABORT with substring "HTTP 429". Expected fetch count: 2*2 = 4.
  // -------------------------------------------------------------------------
  await run("6. consecutive 429 abort — throws HTTP 429", async () => {
    const spec: MockSpec = {
      responses: new Map<number, { status: number; bodyText?: string }>([
        [EXPIRY + 0, { status: 429 }],
        [EXPIRY + 1, { status: 429 }],
      ]),
      callLog: [],
    };
    const m = await startMock(spec);
    try {
      let thrown: Error | null = null;
      try {
        await fetchHistoricalHermesUpdateInWindow(
          FEED,
          EXPIRY,
          60,
          `http://127.0.0.1:${m.port}`,
        );
      } catch (e: any) {
        thrown = e;
      }
      if (!thrown) throw new Error("expected throw, got resolution");
      assertContains(thrown.message, "HTTP 429", "error.message");
      // Each of +0 and +1 = initial + 1 retry = 2 calls. Then abort.
      assertEq(spec.callLog.length, 4, "fetch count");
    } finally {
      await m.close();
    }
  });

  // -------------------------------------------------------------------------
  // Case 7 — Throttle: in the full-gap scenario, gaps between consecutive
  // probes (all 404, no 429 retries) must be ≥ ~450 ms (allow scheduling jitter).
  // -------------------------------------------------------------------------
  await run("7. throttle — ≥ 450ms gap between consecutive probes", async () => {
    const spec: MockSpec = { responses: new Map(), callLog: [] };
    const m = await startMock(spec);
    try {
      try {
        await fetchHistoricalHermesUpdateInWindow(
          FEED,
          EXPIRY,
          60,
          `http://127.0.0.1:${m.port}`,
        );
      } catch {
        /* expected to throw 404 */
      }
      assertEq(spec.callLog.length, 7, "fetch count");
      for (let i = 1; i < spec.callLog.length; i++) {
        const gap = spec.callLog[i].at - spec.callLog[i - 1].at;
        if (gap < 450) {
          throw new Error(
            `gap between probe ${i - 1} and ${i} too small: ${gap}ms (expected ≥ 450)`,
          );
        }
      }
    } finally {
      await m.close();
    }
  });

  process.stdout.write(`\n========================================\n`);
  process.stdout.write(`  ${passes} passed, ${fails} failed\n`);
  process.stdout.write(`========================================\n`);
  process.exit(fails > 0 ? 1 : 0);
})();
