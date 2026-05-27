/// <reference types="vite/client" />

/**
 * Build identifier baked in at compile time via Vite's `define`
 * (see vite.config.ts → resolveBuildId). Compared against /version.json
 * by useVersionCheck to detect a deployed-but-not-yet-loaded new build.
 */
declare const __BUILD_ID__: string;
