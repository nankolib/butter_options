const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The mobile app consumes the canonical Opta IDL from the web app package.
// Keep Metro scoped to that folder only; watching the whole repo touches
// validator/test-ledger files that can be locked by local Solana processes.
config.watchFolders = [path.resolve(__dirname, "../app/src/idl")];

module.exports = config;
