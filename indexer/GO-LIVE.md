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

## 3. Faucet SOL top-up — BLOCKING for any real campaign

Measured 2026-07-25: faucet `J8Kct5tS…RpEPz` holds **4.58 SOL ≈ 91 drops** at
0.05 SOL each, against **974 USDC drops**. SOL runs out ~10× sooner than USDC and
**cannot be minted** — it must be transferred from the admin wallet, which is
**LOCAL-only in WSL** (`/home/nanko/.config/solana/id.json`, deliberately not on
the VPS).

- [ ] Decide the target tester count, multiply by 0.05 SOL, add headroom
- [ ] Top up via `scripts/_exec_fund_faucet.mjs` (run from WSL)
- [ ] Re-verify both balances; confirm SOL drops ≥ USDC drops
- [ ] Set a low-balance alert — running dry mid-campaign funds testers with USDC
      they cannot spend

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
