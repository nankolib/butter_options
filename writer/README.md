# opta-writer

Autonomous devnet market-maker for Opta. Keeps every live market animated by
resting a **WriterAsk** on each cell (canonical American series + 0-pool vault),
so the board shows prices and fillable liquidity. Write-only — it posts and
cancels asks, never fills, so the 6014 self-trade guard is unreachable.

Built to the Gate-1 signed-off spec (+ equity Custom-vault amendment). Sibling
of `crank/`, deployed as its own systemd service.

## What it does each tick (default 5 min)

1. Enumerate live markets from chain (`safeFetchAll` pattern — raw
   `getProgramAccounts` + discriminator memcmp + decode-and-skip). Source-agnostic:
   Monday's equities auto-join with zero code change.
2. For each in-scope, **quote-ready** market (VolOracle fresh <6h and warm ≥168
   samples **or** seeded), build a strike×tenor×side ladder.
3. Quote each cell on-chain (`get_option_price`, American, 400K CU sim), mark up
   by the tier spread, and **post** a WriterAsk (creating the series + vault first,
   bundled all-or-nothing) — or **reprice** an existing ask (cancel+repost on
   >3% drift or >30 min), or **pull** it (quote fails N× / equity market closed).
4. Hourly heartbeat with running counters; `writer-strand` alerts when a cancel
   fails (collateral stuck in an escrow).

## Ladder (defaults, all env-tunable)

- Strikes: spot × {0.90, 0.95, 1.00, 1.05, 1.10}, 3-sig-fig rounded.
- Tenors: nearest weekly + monthly. Crypto/memes/commodity/FX = 08:00Z **Epoch**;
  equity/ETF = Friday **19:45Z Custom** (inside NYSE session).
- Both Call + Put → 20 cells/asset.
- qty = clamp(round(targetNotional / strike), 1, 1e8); collateral = strike × qty.
- Spread: crypto 500 bps · meme 1000 · commodity 400 · equity/ETF/FX 600.
- Caps: 20 vaults/asset, 250 global, `OPTA_WRITER_MAX_CELLS` new/run (canary).

## Run

```bash
cd writer
npm install
npm run build           # tsc -> dist/ + copies the IDL into writer/idl/
OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" \
OPTA_WRITER_KEYPAIR=/opt/opta-writer/secrets/writer-keypair.json \
OPTA_WRITER_ENABLED=0 \            # observe-only until go-live
OPTA_WRITER_ASSETS=SOL \
OPTA_WRITER_MAX_CELLS=3 \
npm start
```

`npm run dev` runs from TypeScript via ts-node (local iteration only; the VPS
runs the precompiled `dist/`).

## Kill switches

| Control | Effect |
|---|---|
| `OPTA_WRITER_ENABLED=0` (default) | soft — discover + quote + log plans, write nothing |
| `OPTA_WRITER_DRY_RUN=1` | same no-write behavior (canary preview) |
| `OPTA_WRITER_ASSETS=SOL,BTC` | allow-list scope (empty = all) |
| `systemctl stop opta-writer` | hard |

## Wallet & custody

Dedicated gas+USDC wallet, **VPS-only** at `/opt/opta-writer/secrets/`
(`OPTA_WRITER_KEYPAIR`). Never the admin key (`5YRMuuoY`), never the crank key
(`5sHZ…`). USDC (devnet mint `AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL`) is
topped up by the admin from local (same pattern as the faucet wallet); the writer
holds no mint authority. Top up SOL to ~5 when it drops below the 1 SOL warn.

## Config

Every knob is an env var — see `src/env.ts`. Deploy unit: `deploy/opta-writer.service`.
MemoryMax rationale + the crank cap edit: `deploy/README-memorymax.md`.

## Vendored files (keep in sync with `app/src/utils/`)

- `src/marketHours.ts` ← `app/src/utils/marketHours.ts` (NYSE calendar, 2026–2027;
  extend before exhaustion).
- `src/pricing.ts` quote path ← `app/src/utils/optionPriceQuote.ts`.
- `src/tenors.ts` epoch math ← `app/src/utils/tenors.ts`.
- Seeds/IDs in `src/ids.ts` ← `app/src/utils/constants.ts` (lockstep).
