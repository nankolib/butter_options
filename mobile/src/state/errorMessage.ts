/**
 * Error panel message resolution.
 *
 * Every error panel hardcoded its `message`, so a dead network, an RPC 500, a
 * genesis-hash mismatch and a decode failure all rendered identically in the
 * field — which cost a full diagnostic cycle on 2026-08-24, where the app showed
 * "Couldn't load offers. Your positions are unaffected." while the proxy logged
 * zero requests.
 *
 * `useMarketState` already computes the real cause and runs it through
 * `sanitizeUserVisibleText`, so surfacing it here leaks no provenance. The
 * hardcoded copy stays as the fallback for when there is no message to show.
 *
 * Pure so it is unit-testable without a renderer.
 */
export function errorPanelMessage(
  dataError: string | null | undefined,
  fallback: string
): string {
  if (typeof dataError !== "string") return fallback;
  const trimmed = dataError.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
