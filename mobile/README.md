# Opta Seeker Mobile

Android terminal client for the Opta Token-2022 options protocol on Solana Seeker.

## Shipped surface

- Trade uses the locked density-A layout: compact 44pt rows and every returned offer remains visible.
- Write creates the vault, deposits collateral, and mints contracts in one atomic transaction and one wallet approval.
- Portfolio independently scans holder and writer ledgers. Rows are read-only until a protocol action is fully wired.
- Dark and light modes use one token system with Inter, IBM Plex Mono, and Fraunces faces bundled through Expo.
- Buy and Write share the explicit lifecycle: review, simulate/build, wallet approval, send, confirm, confirmed/failed/status unknown.
- A submitted signature is stored before confirmation begins. Check Status only checks that signature; it never rebuilds, resends, or redeposits.

Epoch-American writing is deliberately hidden until the canonical on-chain series and fresh protocol-quote flow is available. European epoch and validated custom expiries remain functional. Info-card wording is product copy pending legal approval.

## Local setup

```powershell
cd mobile
npm install
npm run check:handoff
npm run typecheck
npm run doctor
npm run android
```

Mobile Wallet Adapter requires the custom Android development build; Expo Go is not sufficient.

The checked-in `android/` project is authoritative. Expo Doctor's app-config sync check is disabled intentionally; the handoff gate verifies the matching native scheme, orientation, theme, backup policy, permissions, package, and release-signing posture instead. Do not run Expo prebuild over this project.

Copy `.env.example` to `.env.local` only when overriding the public devnet endpoints. Never put a signer, seed phrase, or private key in Expo environment variables.

## Security contract

- The runtime verifies the Solana devnet genesis hash before reads, simulations, submissions, and status checks.
- USDC uses the classic SPL Token program; option mint and escrow accounts use Token-2022.
- Market, vault, mint, and position accounts are owner/discriminator/layout checked and cross-validated against canonical PDAs.
- Asset names are sanitized before display; internal oracle/provider provenance is never rendered.
- Generated, web, and mobile IDLs must remain byte-identical. `npm run check:handoff` enforces this.
- No keypair or private key is bundled. Wallet approval is delegated to Mobile Wallet Adapter.
- Release builds never fall back to Android debug signing.

## Build an APK for review

```powershell
cd mobile
npm run check:handoff
npm run typecheck
npm run build:apk
```

The standalone review artifact is written to `android/app/build/outputs/apk/review/app-review.apk`. It bundles the JavaScript and uses Android's local review/debug certificate; the release build never inherits that certificate. A store/release owner must configure production signing, EAS ownership if used, store artwork, privacy-policy metadata, and physical Seeker-device QA separately.
