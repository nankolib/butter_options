# Seeker versionCode 3 — minimal field fix (Stage-2 proposal)

**Status: PROPOSAL. No build, no commit, no submission.** Local doc, not committed.
Drafted 2026-08-24. Depends on the logcat verdict (see §0).

---

## 0. Verdict dependency

This proposal fixes the **`requestId` silent-bail** defect. That defect is **strongly
supported but NOT yet confirmed** — `seeker.log` has not arrived, and there has been no
founder device traffic since `08:08:46 UTC` today.

Do not build until the log confirms it. The confirming signature is the **absence** of any
`scan timed out after 15s` line after 60s on skeletons, together with repeated scan sets in
the proxy log.

---

## 1. The defect

Two independent referential-instability sources feed one effect, and the effect's cleanup
silently discards in-flight loads.

### 1a. `connection` is a new object on every provider render

`@wallet-ui/react-native-web3js` (`dist/index.native.mjs:90-97`):

```js
function MobileWalletProvider({ ..., commitmentOrConfig = { commitment: "confirmed" }, endpoint, ... }) {
  const connection = useMemo(() => new Connection(endpoint, commitmentOrConfig),
                             [commitmentOrConfig, endpoint]);
```

`commitmentOrConfig` is a **default parameter** — a fresh object literal each render — and the
memo is keyed on it. Opta does not pass the prop, so every `MobileWalletProvider` render
produces a **new `Connection`**.

It re-renders at launch: `ThemeProvider` hydrates the theme from AsyncStorage, sets state, and
the provider subtree re-renders while the first scan set is still in flight.

### 1b. `owner` is a new `PublicKey` on every render (rehydrated sessions only)

`mobile/src/state/useConnectionState.ts:21-30, 70-76`:

```ts
function normalizeAccount(account) {
  const address = addr && typeof addr.toBase58 === "function" ? addr : new PublicKey(addr);
  return { ...account, address };            // new object every call
}
...
return { phase, error, account: normalizeAccount(wallet.account), connect, disconnect };
```

On a **rehydrated session** the cached address deserializes as a base58 **string** (the lib's
cache reviver revives `publicKey`, not `address` — this is the coercion added by `79aa0b5` for
the launch crash), so `new PublicKey(addr)` runs on **every render**.

Measured:

```
FRESH connect  (address already a PublicKey): owner stable?  true
REHYDRATED     (address is a base58 string) : owner stable?  false
```

`wallet.account` itself IS stable (nanostores `computed` + `useStore`), so the churn is
introduced entirely by `normalizeAccount`.

### 1c. The amplifier

`mobile/src/state/useMarketState.ts`:

```ts
const currentRequest = ++requestId.current;
const nextSnapshot = await loadMarketSnapshot(connection);
if (currentRequest !== requestId.current) return;   // SILENT — never calls setPhase
...
useEffect(() => { ...; void fetchAll(false); return () => { requestId.current += 1; }; },
          [connection, fetchAll, owner]);
```

`fetchAll = useCallback(..., [connection, owner])`. Unstable `connection` or `owner` →
effect re-runs → cleanup bumps `requestId` → the in-flight load bails **without setting
phase** → `phase` stays `"loading"` → **skeletons forever, no error, no chips**.

A `setClock` interval re-renders every 15s (`CLOCK_TICK_MS`), so on the rehydrated path any
load outliving the render gap is killed and retried indefinitely.

**Why it works on Wi-Fi and fails on cellular:** load completes in 2–4s < 15s tick → commits.
Slow cellular → load outlives the tick → never commits.

---

## 2a. The fix — chosen approach and diff

**Chosen: stabilise at source in `useConnectionState` (plus one prop on the provider).**

Rejected alternatives:

| Option | Why not |
|---|---|
| Memoize `owner` on base58 in `App.tsx` | Fixes one consumer only; `connection.account` is read in several places, so the landmine stays armed for the next caller |
| Change deps to `owner?.toBase58()` | Classic stale-closure hazard — `fetchAll` still closes over `owner`. Needs an eslint-disable and is fragile under future edits |
| **Stabilise in `useConnectionState`** | One line, at the source of the churn, fixes every consumer. Sound because `wallet.account` is provably referentially stable |

### Diff 1 — `mobile/src/state/useConnectionState.ts`

```diff
-import { useCallback, useEffect, useState } from "react";
+import { useCallback, useEffect, useMemo, useState } from "react";

 export function useConnectionState(wallet: WalletConnection) {
   const [phase, setPhase] = useState<ConnectionPhase>(
     wallet.account ? "connected" : "disconnected"
   );
   const [error, setError] = useState<string | null>(null);
+
+  // The rehydrated session deserializes `address` as a base58 string, so
+  // normalizeAccount mints a fresh PublicKey on every render. Consumers use the
+  // result as a hook dependency (App.tsx -> useMarketState), where a new identity
+  // each render re-runs the load effect and its cleanup silently invalidates the
+  // in-flight snapshot. Memoize on the wallet's own account object, which the
+  // wallet lib holds stable via a nanostores computed.
+  const account = useMemo(() => normalizeAccount(wallet.account), [wallet.account]);

   ...

   return {
     phase,
     error,
-    account: normalizeAccount(wallet.account),
+    account,
     connect,
     disconnect
   };
 }
```

### Diff 2 — `mobile/src/App.tsx`

```diff
+// The wallet provider defaults this prop to a fresh object literal each render and
+// memoizes its Connection on it, so an omitted prop means a new Connection on every
+// provider render. Pass a module-level constant so the Connection is stable.
+const WALLET_COMMITMENT = { commitment: "confirmed" } as const;
+
 export default function App() {
   return (
     <SafeAreaProvider>
       <ThemeProvider>
-        <MobileWalletProvider chain={OPTA_CHAIN} endpoint={RPC_ENDPOINT} identity={identity}>
+        <MobileWalletProvider
+          chain={OPTA_CHAIN}
+          endpoint={RPC_ENDPOINT}
+          identity={identity}
+          commitmentOrConfig={WALLET_COMMITMENT}
+        >
           <OptaSeekerApp />
         </MobileWalletProvider>
       </ThemeProvider>
     </SafeAreaProvider>
   );
 }
```

Both diffs are additive and behaviour-preserving. No IDL change, no instruction change, no
account-layout change, no network change.

### Optional belt-and-braces (recommend YES, 3 lines)

The silent bail is correct *in principle* (a newer request will set phase). It is only fatal
because the newer request is itself immediately superseded. Once §2a lands that cannot happen.
If you want defence in depth without changing semantics, log the bail so the next occurrence
is visible in logcat:

```diff
-      if (currentRequest !== requestId.current) return;
+      if (currentRequest !== requestId.current) {
+        console.warn(`[opta] snapshot ${currentRequest} superseded by ${requestId.current}`);
+        return;
+      }
```

---

## 2a-test. S5 regression test

Fails on the rehydrated path pre-fix, passes post-fix.

`mobile/src/state/useConnectionState.test.tsx` (new):

```tsx
import { renderHook } from "@testing-library/react-native";
import { PublicKey } from "@solana/web3.js";
import { useConnectionState } from "./useConnectionState";

const B58 = "HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS";
const stubWallet = (address: unknown) => ({
  account: { address } as any,
  connect: async () => ({ address: new PublicKey(B58) }),
  disconnect: async () => undefined
});

describe("S5 — connection account identity", () => {
  it("keeps owner identity stable across renders on a REHYDRATED session", () => {
    // Cached session: address arrives as a base58 string, not a PublicKey.
    const wallet = stubWallet(B58);
    const { result, rerender } = renderHook(() => useConnectionState(wallet));
    const first = result.current.account?.address;
    rerender({});
    const second = result.current.account?.address;

    expect(first).toBeInstanceOf(PublicKey);
    expect(first?.toBase58()).toBe(B58);
    // PRE-FIX: fails — normalizeAccount mints a new PublicKey each render.
    expect(second).toBe(first);
  });

  it("keeps owner identity stable across renders on a FRESH connect", () => {
    const wallet = stubWallet(new PublicKey(B58));
    const { result, rerender } = renderHook(() => useConnectionState(wallet));
    const first = result.current.account?.address;
    rerender({});
    expect(result.current.account?.address).toBe(first);
  });
});
```

Companion test for the amplifier (`useMarketState.test.tsx`): mount with a slow
`loadMarketSnapshot` (resolves after 200ms), force three re-renders inside that window, and
assert `phase !== "loading"` once the promise settles. Pre-fix this hangs at `"loading"`.

**Note:** `mobile/` has no test runner wired today. Adding `@testing-library/react-native` +
jest config is part of this ticket's cost — roughly the only non-trivial work in it.

---

## 2b. Candidate rider — the default-side fix (App.tsx:82)

**Recommendation: INCLUDE, in its narrowest form.**

`INITIAL_TRADE.side = "call"` and the floor is 3 puts, so even a fully-fixed load renders
"No offers for FARTCOIN · …". Shipping vC3 without this means the fix is invisible to the
founder and to any user whose first look lands on a side with no inventory.

Narrowest safe form — **default to the side that has inventory**, one effect, no persistence:

```diff
+  // Asset and expiry already self-correct to what exists; side did not, so a board
+  // whose inventory sits entirely on one side rendered an empty grid on first paint.
+  useEffect(() => {
+    if (!market.snapshot) return;
+    const forAsset = market.snapshot.offerings.filter(
+      (o) => o.asset === trade.asset && o.expiry === trade.expiry
+    );
+    if (forAsset.length === 0) return;
+    if (forAsset.some((o) => o.side === trade.side)) return;
+    setTrade((current) => ({ ...current, side: forAsset[0].side, offeringId: null }));
+  }, [market.snapshot, trade.asset, trade.expiry, trade.side]);
```

Risk assessment: mirrors the existing asset/expiry auto-correct effects exactly (same file,
same pattern, same guards), only fires when the current side has zero offers for an
asset/expiry that *does* have offers, and is a no-op once inventory exists on both sides. It
cannot loop — it only moves `side` to a value present in `forAsset`.

**Rejected: "persist last side."** Needs AsyncStorage plumbing, a hydration race with the
first paint, and a migration story. That is v1.1 work.

Ticket already filed for the underlying issue during Stage-1 recon.

---

## 2b-bis. Candidate rider — surface the actual error (added 2026-08-24)

**Recommendation: INCLUDE. ~4 lines, zero behavioural risk, high diagnostic value.**

Evidenced by the 2026-08-24 19:48 UTC device capture: the app showed
*"Couldn't load offers. Your positions are unaffected."* while the proxy logged **zero
requests** — a transport failure. But that screen is byte-identical to what a decode failure,
an RPC 500, or a genesis-hash mismatch would produce, because the panel is hardcoded:

`mobile/src/screens/TradeScreen.tsx:117-125`

```tsx
) : dataPhase === "error" ? (
  <ScreenStatePanel
    tone="error"
    title="Couldn't load offers."
    message="Your positions are unaffected."   // hardcoded — never the real cause
```

`useMarketState` already computes, sanitises (`sanitizeUserVisibleText`) and stores the real
message in `error`, but **`TradeScreen` never receives it as a prop** — the only `error`
tokens in the file are `dataPhase === "error"` and `tone="error"`.

So every failure class is indistinguishable in the field. Surfacing the sanitised string would
have short-circuited this entire investigation.

```diff
   ) : dataPhase === "error" ? (
     <ScreenStatePanel
       tone="error"
       title="Couldn't load offers."
-      message="Your positions are unaffected."
+      message={dataError ?? "Your positions are unaffected."}
```

plus threading `dataError?: string | null` through the existing props interface from
`market.error` in `App.tsx`. The text is already sanitised at the `useMarketState` boundary, so
no provenance can leak (per the oracle-provenance rule). Same treatment applies to
`WriteScreen`'s error panel.

---

## 2c. Other known field-breaking items in `a556f0c → HEAD` (list only, none added)

The mobile diff between the store build and HEAD is **IDL-only** — `mobile/src/idl/opta.json`,
452 lines changed, zero TypeScript changes. Verified structurally:

| Item | Field impact | Disposition |
|---|---|---|
| `TriggerOrder` gained `oco_link`, `tape` | **None** — mobile has zero references to `TriggerOrder` | no action |
| Instruction set: baked `synth_warm_vol_oracle` ↔ deployed `link_oco` | **None** — mobile calls neither | no action |
| All 14 account discriminators, all 8 mobile decoders | **0 offset mismatches** vs deployed | no action |
| 4 built instructions (`create_and_deposit`, `mint_from_vault`, `purchase_from_vault`, `buy_v2_resale`) | discriminators/args/accounts **identical** | no action |
| **Default side = call** (App.tsx:82) | Empty grid when inventory is one-sided | §2b rider |
| **`SCAN_TIMEOUT_MS = 15_000`** vs growing scans | SharedVault 5,217 accts / 3.11 MB raw, +116 in 48h | **v1.1** — add a `dataSize` filter |
| **No `RestingOrder` / `WriterAsk` support** | Book supply invisible (134/26/26 live accounts) | **v1.1** — ticket filed |
| Legacy 260/268-byte vaults render on mobile, hidden on web | Surfaces disagree on inventory | **v1.1**, cosmetic |

Nothing else field-breaking is known. vC3 ships §2a + §2b only.

---

## 2d. Build + submit runbook

**Facts carried from the July submission (HANDOFF §1962-1970):**

| | |
|---|---|
| Package | `com.opta.seeker` |
| Prior release | versionCode **2** / v1.0.0, submitted **2026-07-13** |
| Prior signed-APK SHA-256 | `450929D0AB923619693CBA1F76939B84BD0D7B059D5CC95F9AE036003D26CDB9` |
| Release ID | `801dec38…` |
| Publisher wallet | `AjMu…Vb1y` (fresh Phantom, self-custodied, PERMANENT) |
| Keystore | `D:\claude everything\keys\opta-release.keystore`, RSA-4096, cert SHA-256 `08:7F:F9:CB…`, valid → 2056 |
| Credentials | gitignored `mobile/android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) — confirmed ignored at `.gitignore:58` |
| Portal API key | env-only, never committed |

**Steps**

1. Bump `mobile/android/app/build.gradle`: `versionCode 2 → 3`, `versionName "1.0.0" → "1.0.1"`.
2. Apply §2a diffs (+ §2b rider). Run the S5 tests — must go red→green on the rehydrated case.
3. Confirm `keystore.properties` resolves; a release assemble **fails closed** if unconfigured
   (build.gradle:116-125), so an unsigned/debug-signed artifact cannot ship by accident.
4. `cd mobile/android && ./gradlew clean :app:assembleRelease`
5. Artifact: `mobile/android/app/build/outputs/apk/release/app-release.apk`.
   Capture the hash — this is the store-submitted identity:
   `certutil -hashfile app-release.apk SHA256`
   Record it next to the July hash. Verify the signing cert matches `08:7F:F9:CB…`:
   `apksigner verify --print-certs app-release.apk`
6. **Sideload and verify before submitting** — `adb install -r app-release.apk`. This is the
   only true test of the fix. Force-kill → relaunch (rehydrated session) → confirm chips and
   offers render. Requires live inventory (see §2e).
7. Submit via the dApp Store publishing tool under publisher wallet `AjMu…Vb1y`, minting a new
   **Release NFT** against the existing App NFT (`3sembGLq…`, collection `ARWvanaU…`). Portal
   API key from env.
8. Re-check the Details tab after approval — it showed Draft last time and publishes only on
   release approval.

**Expected review turnaround — CORRECTED 2026-08-24.** HANDOFF's "IN REVIEW" was **stale and
never closed out**. Founder confirms the listing has been **LIVE since `<APPROVAL_DATE — TBC>`**.

Consequences:

- **Store distribution is viable.** vC3 can reach field devices through the store; it is not a
  sideload-only fix. This reverses the §2e planning assumption below.
- **Update-review turnaround: estimate PENDING.** It should be derived from the real
  submitted→approved interval (2026-07-13 → `<APPROVAL_DATE>`), and update reviews are
  typically faster than a first listing (app identity, publisher wallet and NFT collection are
  already established; only the new Release NFT is reviewed). **Do not fill this in until the
  approval date is supplied** — an invented number would drive the §2e sequencing decision.
- HANDOFF must be corrected so this does not mislead a future session.

---

## 2e. Sequencing vs the 2026-08-28 floor expiry

The canary floor (3 puts × 5, WIF/FARTCOIN/JUP) **expires 2026-08-28T08:00:00Z** — about
3.9 days out.

**REVISED 2026-08-24** — the listing is live, so store distribution is a real delivery channel
(see §2d). Sequencing is now driven by the floor expiry, not by review time.

- **Sideload test against the EXISTING put floor, before 2026-08-28.** The §2b rider
  auto-corrects `side` to whichever side actually has inventory, so **puts alone are a
  sufficient proof**: a passing test shows the load committed (§2a fixed) *and* the rider moved
  the grid off the `"call"` default. A call-side floor would add nothing to the verification.
- **The call-side mint stays HELD.** It is not required for vC3 testing and is not requested by
  this proposal.
- **Steps 1–6 should complete before 2026-08-28T08:00:00Z.** That is the real deadline — after
  it the put floor settles and the board goes empty again, at which point a sideload test can no
  longer distinguish "fix works, board empty" from "fix broken."
- If testing slips past 2026-08-28, a floor refresh becomes a prerequisite again. That is the
  3b loop ticket, needs its own GO, and nothing here executes it.
- The floor is a **workaround** either way. The real fix remains v1.1 reading
  `RestingOrder`/`WriterAsk`, where supply already lives and no floor is needed.

---

## Cost / risk

| Item | Cost | Risk | Mitigation |
|---|---|---|---|
| §2a two diffs | ~6 lines | Low — additive, behaviour-preserving | S5 tests |
| Test infra (jest + RNTL) | Main effort in the ticket | Low | Confined to `mobile/` |
| §2b rider | ~10 lines | Low — mirrors existing auto-correct effects | Cannot loop; no-op once both sides have inventory |
| versionCode bump + signing | Mechanical | **Keystore loss = permanent loss of update rights** | Already backed up (Bitwarden + Drive) |
| Store review | TBC | Listing is **live**; update-review interval not yet estimated (needs the July approval date) | Sideload verifies before submission either way |
| Floor expiry 08-28 | — | After it, a sideload test cannot distinguish "fix works, board empty" from "fix broken" | Complete sideload test before 2026-08-28; existing put floor suffices (rider auto-corrects). Call mint stays HELD |
