# GO-LIVE checklist — EPOCH 0 campaign

Everything on this list is **deliberately not done**. Each item is staged,
reversible, and independently verifiable. Nothing here happens until the call is
made to go public.

Current state: the points API runs **loopback-only** on `127.0.0.1:8791` inside
`opta-indexer`. It is unreachable from the internet. Shadow mode is still on —
nothing is user-visible.

---

## 1. Expose the API through nginx — ⚠️ touches the LIVE production domain

`opta.fyi` is a live nginx reverse-proxy to Vercel. This is the highest-risk
step on the list; do it first while attention is on it, not last.

```bash
ssh root@144.202.58.6
cp /etc/nginx/sites-available/opta.fyi.conf \
   /etc/nginx/sites-available/opta.fyi.conf.bak-pre-points     # ROLLBACK POINT
# fold in blocks 1 and 2 from indexer/deploy/nginx/points-api.conf.staged
nginx -t                                     # MUST pass — do not reload on failure
systemctl reload nginx
```

**Verify, in this order:**
1. `curl -sS -o /dev/null -w '%{http_code}\n' https://opta.fyi/` → **200** (the
   Vercel proxy still works — check this BEFORE celebrating the new route)
2. `curl -sS https://opta.fyi/api/points/stats` → JSON
3. `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://opta.fyi/api/points/referral/code` → 415 (not 404: proxying works, body validation rejects)

**Rollback:** `cp …bak-pre-points …opta.fyi.conf && nginx -t && systemctl reload nginx`

## 2. Consolidate the X bearer token

Phase 2b created `/etc/opta/x-read.env` (`root:opta 0640`) holding a **copy** of
`X_BEARER_TOKEN`. `/opt/opta-tweet/.env` still has its own copy, so the secret
exists in two places — accepted during build, not acceptable at go-live.

```bash
cp /opt/opta-tweet/.env /opt/opta-tweet/.env.bak-pre-xshare     # ROLLBACK POINT
sed -i '/^X_BEARER_TOKEN=/d' /opt/opta-tweet/.env
# add to /etc/systemd/system/opta-tweet.service, under the existing EnvironmentFile:
#   EnvironmentFile=/etc/opta/x-read.env
systemctl daemon-reload && systemctl restart --no-block opta-tweet
```

**Verify:** `systemctl is-active opta-tweet` → active, `NRestarts` unchanged, and
the bot's next cycle logs a successful X call. **Rollback:** restore the `.bak`
and remove the extra `EnvironmentFile` line.

**Also:** confirm the rotation checklist covers the new file. A key rotation must
now update **three** consumers, not two: `/opt/opta-crank/.env`,
`/etc/opta/x-read.env`, `/opt/opta-tweet/.env`.

## 3. Faucet SOL top-up — PARTIALLY DONE (covers early campaign, not scale)

**Executed 2026-07-30.** Faucet went 4.58 -> **17.58 SOL = 351 claims** at 0.05
each (5 SOL from admin + 8 SOL from the writer wallet). USDC side is not a
constraint: faucet holds $9.73M and the admin can mint on demand.

- [x] Top-up executed; faucet at 351 SOL claims
- [ ] **NOT sufficient for scale.** 351 claims covers the early campaign only.
      SOL cannot be minted — it must be accumulated.
- [ ] **Accumulate devnet SOL before pushing past ~300 testers:** daily
      `faucet.solana.com` grabs, and/or request a devnet SOL grant from the
      Solana Foundation or Helius. Start this early — it is rate-limited and
      slow, so it cannot be done reactively.
- [ ] Set a low-balance alert on the faucet wallet.

### 3b. ⚠️ WRITER SOL BURN — more urgent than the faucet

Measured over a 17-hour window (2026-07-29 17:20Z 25.774 SOL -> 2026-07-30
10:20Z 21.940 SOL): **~3.83 SOL burned = ~5.4 SOL/day.**

The writer runs ~200 reprices + ~200 cancels per hour, plus periodic repost
waves that mint new series and vaults (the 08:54Z heartbeat shows `posted:180`)
— and series/vault creation pays rent, which dominates the fee cost.

After sending 8 SOL to the faucet the writer holds **13.94 SOL ≈ 2.6 days** at
that rate. The funding plan assumed "~17.7 SOL ≈ 125 days", which implied
~0.14 SOL/day — roughly **38x lower than measured**. Two things compounded: the
writer had already burned 3.8 SOL overnight before the transfer, and the burn
assumption itself was wrong.

- [ ] **Decide within ~2 days:** top the writer back up, or accept it stopping.
      A writer with no SOL stops market-making entirely — the board goes stale
      and every quote surface with it.
- [ ] Options: return ~5 SOL from the faucet (leaves 251 claims, still ample for
      early testing), or from the admin reserve (only 5.2 SOL, earmarked for
      program upgrades), or accumulate externally per 3 above.
- [ ] Add a writer low-SOL alert. `OPTA_WRITER_LOW_BALANCE_WARN_SOL` defaults to
      1.0, which at 5.4 SOL/day is under 5 hours of warning — raise it to ~10.
- [ ] Longer term the burn itself is the problem: ~5 SOL/day is ~150 SOL/month
      of devnet gas that no reshuffling fixes.

## 4. Provenance completeness — gates the profit board

- [x] **DONE 2026-07-26.** `atasPolled` plateaued at **15 for 12 consecutive
      ticks** (~2h). Coverage is understood, not merely flat: eligible 28,
      polled 15, unpolled 13 — and **all 13 unpolled have no known USDC ATA
      because they never claimed from the faucet**, so `faucet_in = 0` and they
      are already profit-ineligible ("no faucet claim on record"). Zero unpolled
      wallets are classified not-a-wallet; zero unpolled for any other reason.
      The gap therefore cannot wrongly qualify anyone.
- [x] **DONE 2026-07-26.** `atasSkippedOverCap = 0` in every `capital tick`.
- [ ] Accept or fix: faucet history starts **2026-07-04**, three days after the
      trade tape, so wallets funded before then show `faucet_in = 0` and are
      correctly excluded. Fine for a fresh campaign; state it publicly if any
      existing wallet expects to compete.

## 5. Scaling — Phase 3 prerequisite, on the record since 2a

External-inflow detection is **O(wallets)**: per-ATA polling, capped at
`OPTA_INDEXER_ATA_MAX=500`. A plain SPL `transfer` does not name the mint, so no
single account observes every USDC movement.

- [ ] **Before any launch beyond ~500 active wallets**, replace this with a
      Helius webhook or a mint-wide stream. The cap logs loudly when hit, but a
      truncated provenance set silently mis-qualifies wallets.

## 6. Quest panel visual pass — REQUIRED before the flag goes on

The 2c automated screenshot set (56 shots, both modes x desktop/mobile) covers
every campaign surface EXCEPT one: the quest panel sits inside
PortfolioTerminalPage's connect-wallet gate, and headless chromium has no
wallet, so all 12 portfolio shots show the connect prompt rather than the panel.
Its logic is unit-tested; its APPEARANCE has never been reviewed.

- [ ] Connect a real wallet and review the quest panel in **dark** and **light**
- [ ] Check every block renders: totals, 7-step chain, referral (code + copy +
      bind), social submit, bounty submit
- [ ] Exercise the signed-action states — idle -> confirm in wallet -> pending ->
      success/fail — at least once end-to-end
- [ ] Verify on a **mobile viewport** too

```bash
ssh -N -L 8791:127.0.0.1:8791 root@144.202.58.6 &
cd app && VITE_EPOCH0_UI=1 VITE_POINTS_API_BASE=/api/points npx vite
```

## 6b. Writer-bid widening — canary passed at 3 cells, widening is a GO-LIVE call

The writer bid side is **LIVE** at `OPTA_WRITER_BID_MAX_CELLS=3`
(`OPTA_WRITER_BID_ENABLED=1`), flipped 2026-07-30T16:04:28Z. A full clean hour
passed on 2026-07-30 18:07–19:14Z: 7 posts, all exactly 1500 bps below model
mark and 2273–2287 bps below their resting anchors, **zero crosses, zero fills,
zero restarts**, quote-failure flat (267→265), boards unmoved.

Three cells is a canary throttle, not a market. It produces a visible two-sided
book on ~1 series at a time out of ~320.

- [ ] **Widen to 20–50 cells** and run a SECOND canary hour at the wider setting
      before calling the bid side done. The gates that matter change character at
      scale: `cell-cap` stops binding (it absorbed 1,062 skips at 3 cells), so
      `bidMaxNotionalPerAsset` / `bidMaxNotionalGlobal` / `bidReserveUsdc` become
      the live constraints for the first time.
- [ ] Re-verify no-cross across the wider set — 3 bids is a weak test of a
      no-cross invariant that must hold across every series simultaneously.
- [ ] Watch inventory: `OPTA_WRITER_MAX_LONG_PER_SERIES=10` has never bound,
      because no bid has ever been filled. At 20–50 cells a fill becomes likely
      and that cap gets its first real exercise.

## 7. Shadow → live cutover

- [ ] Freeze `quests_v1.json` and `rules_v1` weights; a rules change after launch
      re-scores retroactively (the whole point of the TAPE/SCORE split, but
      surprising to users mid-campaign)
- [ ] Review the backdated funnel: currently **O1=14, O2–O7=0** under D12 strict
      sequencing. If the campaign starts fresh this is fine; if it credits
      history, retune D12 first
- [ ] Decide whether existing internal wallets stay excluded (they should)
- [ ] Publish the rules page before the API is public

## 8. Purge Phase 2b test rows

Acceptance testing wrote real rows into the live DB via the API. They must go
before any public board is served.

```sql
-- test referrer / referee (deterministic keys from Buffer.alloc(32,'A'|'B'))
DELETE FROM referrals      WHERE referrer_wallet = 'FnDw11RnMuVPfRYeo2h9aGj8siN4iWJTz5UwdLtKcfA4';
DELETE FROM referral_codes WHERE wallet         = 'FnDw11RnMuVPfRYeo2h9aGj8siN4iWJTz5UwdLtKcfA4';
DELETE FROM social_posts   WHERE tweet_id       = '2080003991203725576';
DELETE FROM wallet_handles WHERE x_handle       = '_thekhay';
DELETE FROM bounty_submissions WHERE kind = 'bug' AND proof_url LIKE '%/issues/1';
```

- [x] **DONE 2026-07-26.** All five write-path tables purged to zero; both
      boards return `rows: []` after recompute.

## 9. Operational

- [ ] Raise `MemoryMax` above 200M **or** confirm the streaming render keeps peak
      under it (Phase 2b Item 0 brought the peak down — re-measure after a month
      of tape growth)
- [ ] Add `opta-indexer` to whatever uptime check the other services use
- [ ] Confirm `points.db` is included in any backup routine — the tape rebuilds
      from chain, but `referrals` / `social_posts` / `bounty_submissions` are
      **user-submitted data that exists nowhere else**
- [ ] Decide retention for `nonces` (swept hourly) and `write_cooldowns` (never
      swept — small, but unbounded in wallet count)

---

**Nothing above is done. Nothing above should be done until we say go.**
