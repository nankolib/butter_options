# Opta Seeker Mobile

Native Android app for Solana Seeker.

## What It Is

- Expo React Native app.
- Uses Solana Mobile Wallet Adapter through `@wallet-ui/react-native-web3js`.
- Targets Opta devnet by default.
- Reads live Opta markets, vault inventory, resale listings, Pyth/Hermes spot prices, and wallet Token-2022 positions.
- Builds primary-vault and resale purchase transactions with explicit review and simulation before wallet signing.
- Builds native writer transactions: create/deposit an epoch vault, then mint Token-2022 option contracts as a second reviewed stage.

## Local Setup

```powershell
cd mobile
npm install
npm run android
```

MWA uses native Android modules, so this must run as a custom Expo development build. Expo Go is not enough.

## Environment

Copy `.env.example` to `.env.local` if you need a paid RPC endpoint:

```text
EXPO_PUBLIC_RPC_URL=https://api.devnet.solana.com
EXPO_PUBLIC_HERMES_BASE=https://hermes.pyth.network
```

## Safety

- Devnet only in this package.
- No keypairs or private keys are stored in the app.
- Signing is delegated to a Mobile Wallet Adapter wallet.
- Transactions are simulated before the "Sign in wallet" action is enabled.
- Token-2022 option accounts are created idempotently in the purchase transaction.
- Writer flows are staged so each Seeker wallet signature has a clear review step.

## Build For APK Review

```powershell
cd mobile
npm run build:apk
```

Before production submission, replace `extra.eas.projectId`, add store artwork, complete a privacy policy URL, and run a physical Seeker-device QA pass.
