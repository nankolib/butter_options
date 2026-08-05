# Founder smoke — shaded tutorial, wallet-gated advancement

Everything here needs a **connected wallet signing real devnet transactions**, so
headless cannot reach it. Everything that does *not* need a wallet is already
gated automatically and listed at the bottom so you know what NOT to re-check.

Use a **fresh wallet** — the tour auto-opens only for a connected wallet with
**zero** completions, so a used wallet will (correctly) not trigger it.

---

## Setup

1. New wallet in Phantom, switch to **devnet**.
2. Open `https://opta.fyi/markets`, connect.
3. Expect the walkthrough to **open by itself** within a few seconds.
   - If it does not: check `localStorage['opta.tour.dismissed']` — if it is `"1"`
     you dismissed it on this browser before. `resume walkthrough` at the bottom
     of the Campaign panel on `/portfolio` clears it.

---

## The steps

| # | Step | What to do | PASS looks like |
|---|---|---|---|
| 1 | welcome | read, press `next` | centred card, no spotlight |
| 2 | connect | already connected → skipped | tour does not stall here |
| 3 | faucet | claim **SOL**, then **USDC** from the two icons in the top bar | each icon is spotlit with a hole in the dim; **card advances on its own within ~6–12 s of the claim confirming** — you should not need to press `next` |
| 4 | trade | `/trade`, pick a strike in the grid, buy it | grid is spotlit; **advances on its own** once the fill confirms (quest O1) |
| 5 | portfolio | `/portfolio` | Campaign panel spotlit; your new position is listed |
| 6 | write | `/write`, write one vault | the write button is spotlit; **advances on its own** on confirmation (O2) |
| 7 | market | `/markets`, `New market` (`+ New` on mobile) | the button is spotlit, the modal is **dark**, not a white box; advances on O3 |
| 8 | hand-off | read | names exercise, settle, the quest panel and the leaderboards, then `done` closes it |

**The advancement in steps 3/4/6/7 is the thing to watch.** It is driven by
re-polling your wallet's quest state, *not* by the button press. If a step does
not advance within ~15 s of a confirmed transaction, that is the bug — note which
step and what `GET /api/points/wallet/<your pubkey>` returns for `quests`.

---

## The out-of-order rule — the one worth deliberately breaking

This is the behaviour most likely to regress into a plain counter, and the unit
gate only proves the logic, not the wiring.

1. Fresh wallet, connect, **dismiss** the tour immediately.
2. Go to `/write` and write a vault first (completes **O2**), skipping the fill.
3. `resume walkthrough` from the Campaign panel.

**PASS:** the tour opens on **buy your first contract** (the O1 step).
**FAIL:** it opens on *write a vault* — that means it is counting steps instead
of reading what you have actually completed.

---

## Dismiss / resume

1. Dismiss mid-step → overlay disappears.
2. **Reload the page** → it must **not** come back. A dismiss is permanent.
3. `/portfolio` → Campaign → `resume walkthrough` → it returns, on your first
   incomplete step (not back at the welcome card).

---

## Mobile

Repeat steps 3, 4 and 7 at phone width. Specifically:

- the card must stay fully on screen (it is clamped, but confirm at 390 px);
- `+ New` on `/markets` must be visible and spotlit;
- the spotlight ring must sit over the right control after you scroll — the
  overlay re-measures on scroll, so a stale hole is a bug.

---

## Already covered by automated gates — do NOT spend time re-checking

- Anchor resolution on `/markets`, `/trade`, `/write`, `/portfolio` at **1440 and
  390, dark and light** — all resolve, 0 page errors.
- Dismiss → persists → survives reload → resume restores, at both widths.
- The create-market modal is **dark** on the tour path (measured luminance 5.9).
- `/docs/rules`: **42 values compared field-for-field against the live API, all
  match**; console clean.
- The tour state machine: 12 unit assertions, including the out-of-order rule and
  "no step may be gated on a long-horizon quest", both red-proved.

## Known limits, so they are not reported as bugs

- The **faucet** and **quest-panel** anchors only exist once a wallet is
  connected, which is why they are in this script and not the headless gate.
- A step whose anchor is missing **degrades to a centred card on purpose** — it
  will still describe the action, just without the spotlight.
- O4 / O6 / O7 are **deliberately not steps.** O6 (hold to settlement) cannot be
  completed in a sitting, so the tour hands them off rather than stalling on them.
