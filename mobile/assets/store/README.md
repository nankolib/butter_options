# Solana dApp Store — listing assets & metadata drop-list

The dApp Store submission is **web-portal-first** ([publish.solanamobile.com](https://publish.solanamobile.com)).
The portal stores the listing assets/metadata and mints the NFTs; the CLI
(`@solana-mobile/dapp-store-cli`, portal-backed) only uploads a signed APK for
subsequent version releases. There is **no `config.yaml`** in the current flow.

Drop the finished files in this folder; Nanko uploads them in the portal.

## Visual assets (specs from Solana Mobile listing guidelines)

| Asset | Requirement | File to drop |
|-------|-------------|--------------|
| **App icon** | **512 × 512 px**, square | `icon-512.png` |
| **Screenshots** | at least **1 preview** required. Min **1080 px** on width/height; **all same orientation** (all portrait or all landscape) with **equal aspect ratios**. Capture from the Seeker at device resolution. | `screenshot-1.png`, `screenshot-2.png`, … |
| **Preview video** *(optional, alternative to screenshots)* | `.mp4` only; min 720 px, **1080p (1920×1080) recommended** | `preview.mp4` |
| **Feature graphic / banner** *(if the portal requests one at submit time)* | dimensions not published in guidelines — confirm in the portal UI | `feature-graphic.png` |

> Verify counts/extra assets live in the portal submit flow — the public guidelines
> pin the icon (512²) and screenshot/video minimums but leave screenshot **count**
> and any banner spec to the portal form.

## Text metadata (FOUNDER — sign-off required)

| Field | Constraint | Value |
|-------|-----------|-------|
| App name | — | `Opta` *(confirm)* |
| Short description | **≤ 30 characters** | `FOUNDER: <=30 chars>` |
| Long description | — | `FOUNDER` |
| What's new (per release) | — | `FOUNDER` (e.g. "Initial release") |
| Privacy policy URL | required by portal | `FOUNDER` |
| Website URL | — | `FOUNDER` |
| Support / contact (URL or email) | required by portal | `FOUNDER` |
| Publisher name | — | `FOUNDER` |

## Repo-truth (already fixed — do not re-enter)

- **Package:** `com.opta.seeker`
- **Version:** `1.0.0` (versionCode `2`)
- **Signed release APK:** `mobile/android/app/build/outputs/apk/release/app-release.apk`
- **Signing cert SHA-256:** `08:7F:F9:CB:BB:03:9A:5F:38:22:C3:8C:EA:2C:D6:A2:26:10:E7:D9:18:DF:63:99:26:D9:24:A0:A7:8D:5A:4A`
- **Target SDK / min SDK:** confirmed in the merged manifest (targetSdk 36 / minSdk 24)
- **Permissions (merged):** INTERNET, ACCESS_NETWORK_STATE, com.opta.seeker.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION (storage perms stripped)

## Publisher wallet (FOUNDER — permanent, mainnet)

The portal registers a **browser-extension wallet** (Phantom / Solflare / Backpack)
as the publisher. **This wallet cannot be changed later** — it owns the Publisher
and App NFTs for the life of the listing. Fund it with **~0.2 SOL (mainnet)** for
transaction fees + ArDrive upload costs. Do **not** use a throwaway keypair.
