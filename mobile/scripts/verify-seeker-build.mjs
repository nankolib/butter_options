import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const repoRoot = resolve(mobileRoot, "..");
const failures = [];

const read = (...parts) => readFileSync(resolve(...parts), "utf8");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const requireText = (condition, message) => {
  if (!condition) failures.push(message);
};

function namedBlock(source, name) {
  const start = source.indexOf(`${name} {`);
  if (start < 0) return null;
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, index);
    }
  }
  return null;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [path];
  });
}

const idlPaths = [
  resolve(repoRoot, "target", "idl", "opta.json"),
  resolve(repoRoot, "app", "src", "idl", "opta.json"),
  resolve(mobileRoot, "src", "idl", "opta.json"),
];
const idlHashes = idlPaths.map(sha256);
requireText(new Set(idlHashes).size === 1, "Generated, web, and mobile IDLs must be byte-identical.");

const source = sourceFiles(resolve(mobileRoot, "src"))
  .filter((path) => [".ts", ".tsx"].includes(extname(path)))
  .map((path) => ({ path, text: read(path) }));

for (const file of source) {
  const name = relative(mobileRoot, file.path).replaceAll("\\", "/");
  if (name !== "src/theme.ts" && /#[0-9a-f]{3,8}\b|rgba?\s*\(/i.test(file.text)) {
    failures.push(`${name} contains a hardcoded color outside the theme.`);
  }
  if (/Alert\.alert|ActivityIndicator|NativeModules|buildWriteDepositTx|buildWriteMintTx/.test(file.text)) {
    failures.push(`${name} contains a blocked legacy or blocking UI path.`);
  }
  if (/(?:Ã|Â|â€¦|â€”|â€“|ï¿½|ðŸ)/.test(file.text)) {
    failures.push(`${name} contains mojibake.`);
  }
  if (/\.slice\(\s*0\s*,\s*8\s*\)/.test(file.text)) {
    failures.push(`${name} truncates the Trade offer list.`);
  }
}

const renderedDirectories = ["screens", "state", "ui"];
const rendered = source.filter(({ path }) => {
  const name = relative(resolve(mobileRoot, "src"), path).replaceAll("\\", "/");
  return name === "App.tsx" || renderedDirectories.some((directory) => name.startsWith(`${directory}/`));
});
for (const file of rendered) {
  const name = relative(mobileRoot, file.path).replaceAll("\\", "/");
  if (/(?:Pyth|Switchboard|Hermes|EWMA)/i.test(file.text)) {
    failures.push(`${name} exposes internal price-source provenance in rendered source.`);
  }
}

const app = read(mobileRoot, "src", "App.tsx");
requireText(app.includes("buildAtomicWriteTx"), "App must use the atomic write builder.");
requireText(app.includes("SafeAreaProvider"), "App must install the safe-area provider.");
requireText(app.includes("useOptaFonts"), "App must load the five required font faces.");
requireText(app.includes("Clipboard.setStringAsync"), "Signature copy must use a functional clipboard callback.");
requireText(app.includes("NavigationBar.setStyle(mode)"), "Manual theme changes must update Android navigation controls.");
requireText(app.includes("SystemUI.setBackgroundColorAsync"), "Manual theme changes must update Android system UI.");
requireText(app.includes("const americanWriteSupported = false"), "Unwired American writes must remain hidden.");
requireText(app.includes("wallet.signTransaction(transaction)"), "Wallet signing must be separated from RPC broadcast.");
requireText(!app.includes("signAndSendTransaction"), "Ambiguous wallet sign-and-send must not ship.");
requireText(app.includes("!transaction.hydrated"), "Transactional controls must stay gated until receipt restoration finishes.");
requireText(!app.includes('market.phase === "empty" ? "loaded"'), "A true no-market state must not expose Write one.");

const flow = read(mobileRoot, "src", "state", "useTransactionFlow.ts");
const durableReceiptIndex = flow.indexOf('JSON.stringify(receiptFor("sending"');
const broadcastIndex = flow.indexOf("connection.sendRawTransaction");
requireText(flow.includes("if (!hydrated) return"), "Review must be blocked until stored receipts hydrate.");
requireText(flow.includes("Saved transaction status could not be verified. New transactions remain disabled."), "Receipt hydration must fail closed.");
requireText(flow.includes("retryHydration"), "Receipt hydration failure must expose a functional retry.");
requireText(flow.includes("hasUnresolved"), "Unresolved signatures must block and relabel new transaction controls.");
requireText(durableReceiptIndex >= 0 && broadcastIndex > durableReceiptIndex, "The signature receipt must be persisted before broadcast.");
requireText(flow.includes("rpcSignature !== signature"), "RPC and precomputed transaction signatures must be compared.");

const transactionStatus = read(mobileRoot, "src", "solana", "transactionStatus.ts");
requireText(transactionStatus.includes("blockHeight > submitted.lastValidBlockHeight"), "Missing signatures must resolve only after blockhash expiry.");

const transactionSource = read(mobileRoot, "src", "solana", "transactions.ts");
requireText(transactionSource.includes("buildAtomicWriteTx"), "Atomic write transaction builder is missing.");
requireText(!transactionSource.includes("buildWriteDepositTx"), "Legacy deposit-only write builder must not ship.");
requireText(!transactionSource.includes("buildWriteMintTx"), "Legacy mint-only write builder must not ship.");
requireText(transactionSource.includes("ensureDevnetConnection(connection)"), "Every transaction connection must pass the devnet genesis gate.");

const marketData = read(mobileRoot, "src", "solana", "marketData.ts");
requireText(marketData.includes("getMetadataPointerState"), "Token-2022 metadata pointers must be validated.");
requireText(marketData.includes("deriveVaultResaleListing"), "Resale listing PDAs must be validated.");
requireText(marketData.includes("MAX_CONFIDENCE_BPS"), "Live prices must enforce the protocol confidence bound.");
requireText(marketData.includes("PRICE_FETCH_TIMEOUT_MS"), "Price requests must have a bounded timeout.");
requireText(marketData.includes("market.account.oracleSource !== 0"), "Unsupported price-source markets must stay hidden from transactional screens.");

const marketState = read(mobileRoot, "src", "state", "useMarketState.ts");
requireText(marketState.includes("AUTO_REFRESH_MS"), "Live prices must refresh before the write gate becomes permanently stale.");
requireText(marketState.includes("portfolioPhase"), "Portfolio failures must not poison Trade and Write market state.");

const manifest = read(mobileRoot, "android", "app", "src", "main", "AndroidManifest.xml");
const permissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((match) => match[1]);
requireText(permissions.length === 1 && permissions[0] === "android.permission.INTERNET", "Main manifest may request only INTERNET.");
requireText(/android:allowBackup="false"/.test(manifest), "Android backups must remain disabled.");
requireText(/android:screenOrientation="portrait"/.test(manifest), "Native Android orientation must match app.json.");
requireText(/<data android:scheme="opta-seeker"\/>/.test(manifest), "Native Android scheme must match app.json.");

const gradle = read(mobileRoot, "android", "app", "build.gradle");
const releaseBlock = namedBlock(gradle, "release");
requireText(releaseBlock != null, "Release build block is missing.");
requireText(releaseBlock != null && !/signingConfig\s+signingConfigs\.debug/.test(releaseBlock), "Release must never fall back to debug signing.");
requireText(/review\s*\{[\s\S]*?debuggable\s+false[\s\S]*?signingConfig\s+signingConfigs\.debug/.test(gradle), "Review APK must bundle JS and use only the local review certificate.");
requireText(/review\s*\{[\s\S]*?initWith\s+release[\s\S]*?matchingFallbacks\s*=\s*\['release'\]/.test(gradle), "Review APK must use release native dependencies, never dev-client debug fallbacks.");

const appConfig = JSON.parse(read(mobileRoot, "app.json"));
requireText(!appConfig.expo?.extra?.eas?.projectId, "Placeholder EAS ownership must not ship.");
requireText(appConfig.expo?.userInterfaceStyle === "automatic", "Android must follow the selected dark/light theme.");
requireText(appConfig.expo?.android?.allowBackup === false, "app.json must preserve disabled Android backups.");
requireText(gradle.includes(`applicationId '${appConfig.expo?.android?.package}'`), "Native Android package must match app.json.");
requireText(gradle.includes(`versionCode ${appConfig.expo?.android?.versionCode}`), "Native Android version code must match app.json.");

const packageJson = JSON.parse(read(mobileRoot, "package.json"));
requireText(!packageJson.scripts?.prebuild, "Unreviewed Expo prebuild must not rewrite the checked-in Android project.");
requireText(!packageJson.dependencies?.["expo-dev-client"], "The standalone APK must not ship Expo's development launcher.");
requireText(Boolean(packageJson.devDependencies?.["babel-preset-expo"]), "Metro's Expo Babel preset must be pinned as a development dependency.");
requireText(
  packageJson.expo?.doctor?.appConfigFieldsNotSyncedCheck?.enabled === false,
  "Checked-in native configuration must explicitly own app.json synchronization."
);
for (const dependency of [
  "expo-font",
  "expo-clipboard",
  "expo-system-ui",
  "expo-navigation-bar",
  "react-native-safe-area-context",
  "@expo-google-fonts/inter",
  "@expo-google-fonts/ibm-plex-mono",
  "@expo-google-fonts/fraunces",
]) {
  requireText(Boolean(packageJson.dependencies?.[dependency]), `Required dependency ${dependency} is missing.`);
}

if (failures.length) {
  console.error("Seeker handoff gate failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PASS Seeker handoff gate");
console.log(`PASS IDL parity ${idlHashes[0]}`);
console.log("PASS atomic write only, density A, theme/font, manifest, and release-signing guards");
