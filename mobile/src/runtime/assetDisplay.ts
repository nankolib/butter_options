const DISPLAY_ALIASES: Readonly<Record<string, string | null>> = {
  SBXAU: null,
  XAUSMOKE: null,
  USOILSPOT: "WTI",
  UKOILSPOT: null
};

const PROVENANCE_SHAPE = /(PYTH|SWITCHBOARD|HERMES|EWMA|ORACLE|PROVIDER|FEED)/;

/**
 * Converts an untrusted on-chain asset label into a compact display symbol.
 * Source/test qualifiers are removed at the data boundary so they cannot leak
 * into chips, offers, positions, transaction summaries, or wallet review copy.
 */
export function sanitizeAssetDisplayName(raw: unknown): string | null {
  const original = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!original || original === "?") return null;
  if (Object.prototype.hasOwnProperty.call(DISPLAY_ALIASES, original)) {
    return DISPLAY_ALIASES[original];
  }

  if (/^SB[A-Z0-9]/.test(original)) return null;
  if (/(SPOT|SMOKE|TEST)$/.test(original)) return null;
  if (PROVENANCE_SHAPE.test(original)) return null;
  if (original.length > 16 || !/^[A-Z0-9]+$/.test(original)) return null;
  return original;
}
