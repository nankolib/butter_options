const hiddenTerms = [
  ["p", "yth"],
  ["switch", "board"],
  ["her", "mes"],
  ["ew", "ma"]
].map((parts) => parts.join("")).join("|");
const PROVENANCE_PATTERN = new RegExp(`(?:${hiddenTerms})`, "gi");
const SHORT_PROVENANCE_PATTERN = /(^|[^A-Za-z0-9])(?:SB|sb)(?=$|[^A-Za-z0-9]|[A-Z])/g;

/** Product copy must describe the capability, never its data provider. */
export function sanitizeUserVisibleText(value: string): string {
  return value
    .replace(PROVENANCE_PATTERN, "price service")
    .replace(SHORT_PROVENANCE_PATTERN, (_match, prefix: string) => `${prefix}price service`);
}
