# opta-indexer

Tape + points engine for the Opta program on devnet. **Still SHADOW MODE:** no
frontend, no on-chain writes, nothing user-visible. The points API exists but is
**loopback-only** and not exposed (see `GO-LIVE.md`). The visible output is an
hourly append to `shadow.md`.

## The two layers

| Layer | Tables | Rule |
|---|---|---|
| **TAPE** | `txs`, `events`, `faucet_claims`, `capital_flows` | Immutable indexed facts. Append-only, **never rewritten**. Row ids come from CHAIN position (`<sig>:<logIndex>`, `<sig>:ix<n>`) so growing the allowlist cannot renumber them, keeping re-indexing idempotent. |
| **PROJECTION** | `wallets` | Rebuildable classification (internal vs external). Safe to `UPDATE`. |
| **SCORE** | `scores` | A **pure** function of the tape (`src/score/rules_v1.ts`), versioned. Rules change → full recompute → identical result on an identical tape. |

`is_internal` deliberately lives in the `wallets` projection, **not** on the tape:
the registry (`src/registry.ts`) will change, and baking a mutable classification
into an append-only table would break its central invariant. Add a wallet to the
registry and re-run recompute — no re-index needed.

## Event sources

`src/tape/allowlist.ts` is a **hand-written allowlist**. Do not scaffold it from
the IDL: the IDL declares 38 events, 9 of which are v1-era corpses with zero
`emit!` sites anywhere in `programs/opta/src` (`MarketSettled` is the dangerous
one — it looks like it covers `settle_expiry` and does not). They are listed in
`DEAD_DO_NOT_HANDLE` and a test asserts the two sets stay disjoint.

Three point-bearing instructions emit nothing at all and are recovered by
instruction decoding (`src/tape/ixDecode.ts`), actor at account index 0:

| Instruction | Synthetic event | Actor |
|---|---|---|
| `settle_expiry` | `IxSettleExpiry` | `caller` |
| `create_market` | `IxCreateMarket` | `creator` |
| `reclaim_writer_ask_residual` | `IxReclaimWriterAskResidual` | `cranker` |

## Known limitation (accepted)

Token-2022 contract transfers never touch the program, so the derived
"held-to-settlement" position ledger cannot see them: a wallet that transferred
contracts out is still credited. The magnitude is **measured, not hidden** —
`diagnostics.negativePositions` and `diagnostics.holderCountDelta` are printed in
every `shadow.md` block.

## Build / test

```bash
npm ci
npm run typecheck     # tsc --noEmit
npm test              # node:test over every src/**/*.test.ts
npm run build         # tsc + copy-idl
```

Requires **node 20** (see `.nvmrc`). `better-sqlite3` has no prebuild for node 24;
on Windows use WSL.

## Deploy (VPS 144.202.58.6)

Code ships inside the `opta-crank` checkout; state lives in `/opt/opta-indexer`.
Same split as `opta-writer`.

```bash
ssh root@144.202.58.6
git -C /opt/opta-crank fetch origin
git -C /opt/opta-crank checkout <ref> -- indexer/
chown -R opta:opta /opt/opta-crank/indexer
cd /opt/opta-crank/indexer && npm ci && npm run build   # devDeps needed: tsc
# Pin the boot marker to the DEPLOYED ref — the enclosing checkout's HEAD is a
# different commit, because this is a path-overlay not a full pull.
sed -i "s/^OPTA_INDEXER_COMMIT=.*/OPTA_INDEXER_COMMIT=<ref>/" /opt/opta-indexer/.env \
  || echo "OPTA_INDEXER_COMMIT=<ref>" >> /opt/opta-indexer/.env
systemctl restart --no-block opta-indexer
```

Rollback: `git -C /opt/opta-crank checkout HEAD -- indexer/` + rebuild + restart.

### Boot-marker assert (RULE 1)

First stdout line must be:

```json
{"service":"opta-indexer","commit":"<sha>","schemaVersion":3,"rulesVersion":"v1","questsVersion":"v1","cursor":"<sig|null>","backfillDone":<bool>,"usdcMintOk":true}
```

```bash
journalctl -u opta-indexer -n 200 --no-pager | grep opta-indexer | head -1
```

Never `journalctl -f` on this box.

## Points API (Phase 2b)

**Loopback only** — `127.0.0.1:8791`, in-process. The nginx conf that would make
it public ships **staged, not applied**: `deploy/nginx/points-api.conf.staged`.
See `GO-LIVE.md` before exposing anything.

Reads (all carry `computed_at`):

    GET /api/points/leaderboard?board=profit|volume|writer|referrals|social&limit=50
    GET /api/points/wallet/:pubkey
    GET /api/points/quests
    GET /api/points/stats

Writes — every one requires an ed25519 signature over the canonical message

    opta-epoch0|{action}|{wallet}|{paramsHash}|{nonce}|{expiry_unix}

`paramsHash` = `base58(sha256(canonicalJson(params)))`, so a captured signature
cannot be replayed for a different action *or* different arguments. Nonces are
single-use; `expiry` must be within 5 minutes.

    POST /api/points/referral/code     {}                        -> idempotent 6-char code
    POST /api/points/referral/bind     {code}
    POST /api/points/social/submit     {tweet_url}
    POST /api/points/bounty/submit     {kind, proof_url}

Bounty review is a CLI, not an endpoint:

    node dist/scripts/bounty-review.js list [pending]
    node dist/scripts/bounty-review.js approve <id> <points>
    node dist/scripts/bounty-review.js reject  <id>

## Ops

| Task | Command |
|---|---|
| Recompute after a rules change | `node dist/scripts/recompute.js` |
| Review bounties | `node dist/scripts/bounty-review.js list` |
| Determinism check | `node dist/scripts/recompute.js --json --as-of 0 > a.json` twice, then `diff` |
| Tape size | `sqlite3` is not installed — use `node -e` with `better-sqlite3` |

## Config (`/opt/opta-indexer/.env`)

| Var | Default | Notes |
|---|---|---|
| `OPTA_RPC_URL` | — | **required**, private Helius endpoint, never logged |
| `OPTA_PROGRAM_ID` | `CtzJ4MJY…z9Cq` | |
| `OPTA_INDEXER_STATE_DIR` | `/opt/opta-indexer` | |
| `OPTA_INDEXER_BACKFILL_FLOOR` | `1782864000` | 2026-07-01T00:00:00Z |
| `OPTA_INDEXER_TICK_MS` | `60000` | live-tail interval |
| `OPTA_INDEXER_BATCH_SIZE` | `10` | getTransaction per JSON-RPC batch |
| `OPTA_INDEXER_RPS` | `5` | batches/sec, not txs/sec |
| `OPTA_INDEXER_SHADOW_MS` | `3600000` | shadow render interval |
| `OPTA_INDEXER_API_PORT` | `8791` | loopback API port |
| `OPTA_INDEXER_API_HOST` | `127.0.0.1` | **do not** change without reading GO-LIVE.md |
| `OPTA_INDEXER_API_ENABLED` | `1` | set `0` to disable the listener |
| `OPTA_INDEXER_WRITE_COOLDOWN_SECS` | `10` | per-wallet, per-action |
| `OPTA_SOCIAL_POINTS` / `OPTA_SOCIAL_MAX_PER_DAY` | `20` / `3` | cap enforced at submit AND in the evaluator |
| `X_BEARER_TOKEN` | — | from `/etc/opta/x-read.env`, never logged |
