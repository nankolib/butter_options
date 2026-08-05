# SB settle recon — Phase 1

Recon 2026-08-05, devnet. Gates the Phase 2 build.

**Headline: the brief's premise is wrong, and so was my own audit.** The 52 tuples
do not need an oracle read. **45 of them are settleable right now, by anyone, with
no oracle involved at all** — and were settleable before this session. The BLK-9
filter I shipped in Wave 1 is what is hiding them.

---

## 1. The Pyth/Switchboard asymmetry, from the source

`settle_expiry.rs` states it outright:

- **Pyth** settles on a **historical** at-expiry print. Hermes has an archive, so
  the crank fetches the print at `publish_time ∈ [expiry, expiry+60]` and can
  settle any time within `PYTH_MAX_AGE_SECS = 2_592_000` (30 days).
- **Switchboard has NO historical lookback.** A signed quote is verifiable only
  while its `signed_slothash` is still in the SlotHashes sysvar (~512 slots ≈
  3.5 min). `SB_SETTLE_WINDOW_SECS = 300`.

The SB arm enforces **two independent slot-based gates**:

```rust
require!(clock.unix_timestamp.saturating_sub(expiry) <= SB_SETTLE_WINDOW_SECS,
         OptaError::SwitchboardSettleWindowElapsed);
// …and the verifier's own max_age, in SLOTS:
sb_settlement_price_usdc(&queue, &slothashes, …, clock.slot,
                         secs_to_slots(SB_SETTLE_WINDOW_SECS), …)
```

### Answer 1 — attestation replay is structurally impossible

**The "settleable-with-attestation-replay" class does not exist and cannot be
built.** This is not a data-availability problem that a better archive would
solve: the second gate resolves the quote's `signed_slothash` against the **live**
SlotHashes sysvar. A quote signed days ago cannot be verified today no matter
where its bytes were stored.

`crank/settlementArchive.ts` confirms it from the other direction — it archives
attestations for *"every REAL confirmed Switchboard settle"*, i.e. it is a
**post-hoc audit trail for settles that already landed**, never a replay source.
On the VPS it holds **45 lines, last written Jul 31 19:46**, and every line
corresponds to a tuple that already has a SettlementRecord.

---

## 2. Why the 52 are unsettled — and it is not an oracle failure

**`settle_expiry` already ran for 45 of them.** The SettlementRecord PDA exists
on-chain for 45 of the 52 tuples — exactly matching the 45 archive lines.

What never ran is the **second half**: the `settle_vault` fan-out.

`crank/settleGuardJul31.ts` says this is by design:

> *"Settlement is PER-(asset,expiry) via the SettlementRecord PDA, so the guard
> settles **TUPLES, not vaults**: one settle_expiry per tuple makes every vault at
> that (asset,expiry) **settleable**."*

The crank deliberately lands the record and stops. The fan-out is the job of the
public-good settle UI — which is precisely what `settleAllForExpiry` Phase 2 is.

**`settle_vault` needs no oracle.** It is `permissionless`, reads
`record.settlement_price` from the SettlementRecord PDA, and its account list
contains **no oracle accounts at all** — no `price_update`, no `sb_queue`, no
`sb_slothashes`. Its only gates are `!is_settled`, `!voided`, `expiry <= now`.
There is no upper time bound.

### Proof, not inference

I got this wrong once by reasoning from the wiring, so it is measured:

**a) The path has already completed for Switchboard, 63 times.** 65 fully-settled
tuples exist, **63 Switchboard**, each with a SettlementRecord and every vault
settled — e.g. `SOL 2026-07-17` (17 vaults), `ETH 2026-07-10` (18), `BTC
2026-07-17` (14).

**b) Live simulation of `settle_vault` on the backlog, read-only, no send:**

| tuple | result | unsettled in tuple | CU |
|---|---|---|---|
| `SOL:1785484800` (Jul-31) | **SIM OK** | 129 | 18,277 |
| `ETH:1785484800` (Jul-31) | **SIM OK** | 82 | 15,275 |
| `AAPL:1785527100` (Jul-31) | **SIM OK** | 32 | 16,798 |
| `XAU:1784880000` (Jul-24) | **SIM OK** | 34 | 18,279 |
| `NVDA:1778918400` (May-15) | no SettlementRecord → dark | 1 | — |

15–18K CU per instruction, so the shipped chunk of 5 ix/tx (~90K) is comfortable
and needs no change.

---

## 3. Answer 3 — the split

| class | tuples | vaults | disposition |
|---|---:|---:|---|
| **Settleable NOW** — SettlementRecord exists, oracle-free fan-out | **45** | **2,175** | `settle_vault` batches. Works today. |
| **Settleable with attestation replay** | **0** | **0** | **Class does not exist** (§1). |
| **Permanently oracle-dark** — no record, SB, past window | **7** | **9** | `reclaim_unsettled` (7-day hatch). All are 34–82 days past expiry, so all are eligible now. |

The 7 dark tuples: `NVDA/AAPL/TSLA/MSFT 2026-05-15`, `BTC 2026-05-22`,
`MSTR 2026-06-27`, `SBXAU 2026-07-01`. All carry `total_collateral = 0`, so no
pooled collateral is stranded in them.

**On the `options_minted == 0` question:** 46 of the 52 tuples have `minted == 0`
— writer zero-pool shells with nothing at stake, consistent with the 2026-07-21
churn arc. Of the 6 with `minted > 0`, **five are in the dark set** (the May
expiries) and **one — `SOL 2026-07-31`, minted 14 / sold 14 — has a record and is
settleable now**. `XRP 2026-07-24` likewise carries a non-zero pool and a record.
So the recoverable value sits in the settleable class, not the dark one.

### Honest UI state for the dead class

They must not sit in a quest-earnable list. Proposal, implemented in Phase 2:
the settle list shows only tuples it can actually complete, and the 7 dark tuples
are surfaced separately as **"Unsettleable — past the oracle window"** with the
`reclaim_unsettled` disposition named. 9 vaults, zero collateral, so this is a
labelling job, not a recovery job.

---

## 4. ⚠️ Correction to the 2026-08-04 audit and to Wave 1

The audit claimed:

> *"`settle_expiry` cannot succeed for any asset. `AdminTools.handleSettle` is
> hard-wired to Hermes and never reads `oracleSource`; all 52 settleable tuples
> are Switchboard. Quest W2 and half of O7 are structurally uncompletable."*

**That was wrong**, and it stacked two unverified inferences:

1. I never traced into `settleAllForExpiry`, which **already** has the resume
   guard — `const existing = await connection.getAccountInfo(settlementPda); if
   (!existing) { …Pyth atomic tx… }`. With a record present, the Pyth phase is
   **skipped entirely** and it goes straight to the oracle-free fan-out.
2. I assumed `fetchHermesParsedPrice` throws on a 404. It does not — it is
   `try/catch → return null`. So the SB feedHash 404 degrades the confirmation
   modal's price to `—` and **does not fail the settle**.

So the settle UI already worked for those 45 tuples. The real defect was only
cosmetic: a null price in the receipt.

**Consequence: the Wave-1 BLK-9 filter (`oracleSource === 0`) is actively
harmful.** It hides all 45 settleable tuples and leaves only tuples the UI cannot
complete — the exact opposite of its intent. Phase 2 removes it.

---

## 5. What Phase 2 must build

- **(A) Backlog — nearly free.** Remove the BLK-9 filter; gate on
  *SettlementRecord exists* instead of oracle source. 45 tuples / 2,175 vaults
  become user-settleable immediately. Fix the receipt price for SB.
- **(B) Going forward — the real prize.** For a FUTURE expiry, no record exists
  yet, so a user must run the full SB `settle_expiry` **within 300 s of expiry**:
  capture a signed SB quote, self-pack the ed25519 precompile ix, and pass
  `sb_queue` / `sb_slothashes` / `sb_instructions`. That code lives in
  `crank/switchboardQuotePost.ts` and has never existed in the FE.

Next expiry for the in-window check: **2026-08-07T08:00Z**, 9 tuples / 260 vaults
(then 19:45Z, 13 tuples / 238 vaults).
