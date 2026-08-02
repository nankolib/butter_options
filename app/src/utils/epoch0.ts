// =============================================================================
// epoch0.ts — campaign feature flag + points API client
// =============================================================================
//
// SANDBOX CONTRACT. `VITE_EPOCH0_UI` defaults OFF. With the flag off:
//   - /leaderboard is never registered (falls through exactly as today)
//   - the nav chip is never rendered
//   - none of this module's network code runs
// A Vercel production deploy with the flag unset is therefore byte-identical in
// behaviour to today. That is the whole point: the campaign ships dark.
//
// GRACEFUL DEGRADATION. `VITE_POINTS_API_BASE` is empty by default, which this
// module treats as "unavailable" — every call resolves to a typed
// `{ ok: false }` rather than throwing. The app must remain fully usable with
// the points service down; a leaderboard is never worth breaking a trading page.
// =============================================================================

/** Campaign UI master switch. OFF unless explicitly enabled. */
export const EPOCH0_UI: boolean = import.meta.env.VITE_EPOCH0_UI === "1";

/**
 * Points API origin.
 *
 * Dev: an SSH tunnel to the VPS loopback listener —
 *   ssh -N -L 8791:127.0.0.1:8791 root@144.202.58.6
 *   VITE_POINTS_API_BASE=http://127.0.0.1:8791/api/points
 * Prod: https://opta.fyi/api/points, set only at the GO-LIVE nginx flip.
 */
export const POINTS_API_BASE: string = (import.meta.env.VITE_POINTS_API_BASE ?? "").trim();

export const pointsApiConfigured = (): boolean => POINTS_API_BASE.length > 0;

// ---------------------------------------------------------------------------
// Result type — no throwing across the boundary
// ---------------------------------------------------------------------------

export type ApiResult<T> = { ok: true; data: T } | { ok: false; reason: "unconfigured" | "unreachable" | "error"; status?: number };

const TIMEOUT_MS = 8000;

async function get<T>(path: string): Promise<ApiResult<T>> {
  if (!pointsApiConfigured()) return { ok: false, reason: "unconfigured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${POINTS_API_BASE}${path}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, reason: "error", status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  if (!pointsApiConfigured()) return { ok: false, reason: "unconfigured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${POINTS_API_BASE}${path}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) return { ok: false, reason: "error", status: res.status };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Response shapes (mirror indexer/src/api/handlers.ts)
// ---------------------------------------------------------------------------

export interface BoardRow {
  wallet: string;
  realized_pnl?: number;
  deployed?: number;
  faucet_in?: number;
  roi?: number;
  volume_usdc?: number;
  writer_premium?: number;
  referees?: number;
  posts?: number;
  points?: number;
}

export interface LeaderboardResponse {
  board: string;
  limit: number;
  computed_at: number | null;
  rows: BoardRow[];
}

export interface WalletResponse {
  computed_at: number | null;
  wallet: string;
  is_internal: boolean;
  on_tape: boolean;
  /**
   * `total` is THE number — the engine's finalPoints, served from
   * `wallet_points`. Never re-add the components to derive it: the parts do not
   * sum the way they look (base is pre-multiplier, base_multiplied is the
   * component that actually counts), and a client-side sum is a second scoring
   * implementation that will drift from the engine.
   */
  points: {
    total: number;
    base: number;
    base_raw: number;
    base_breakdown: Record<string, number>;
    base_multiplied: number;
    quests: number;
    social: number;
    bounty: number;
    referral_bond: number;
    referral_commission: number;
  };
  multiplier: number;
  streak: { current: number; longest: number; shields_banked: number; shields_consumed: number; last_active_day: string | null } | null;
  chain_stage: number;
  quests: { quest_id: string; period_key: string; completed_at: number; points: number }[];
  provenance: { faucet_in: number; external_in: number; external_out: number; pct_faucet: number | null; profit_eligible: boolean; ineligible_reason: string | null } | null;
  pnl: { realized_pnl: number; deployed: number; roi: number | null; volume_usdc: number; writer_premium: number } | null;
  referral: { my_code: string | null; referred_by: { referrer_wallet: string; code: string; bound_at: number } | null; referee_count: number };
  x_handle: string | null;
  ranks: { profit: number | null; volume: number | null; writer: number | null };
}

export interface QuestCatalogEntry {
  id: string;
  name: string;
  points: number;
  wallets: number;
  completions: number;
}

export interface QuestsResponse {
  computed_at: number | null;
  version: string;
  chain: QuestCatalogEntry[];
  chain_complete_bonus: QuestCatalogEntry;
  dailies: QuestCatalogEntry[];
  weeklies: QuestCatalogEntry[];
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const fetchLeaderboard = (board: string, limit = 50) =>
  get<LeaderboardResponse>(`/leaderboard?board=${encodeURIComponent(board)}&limit=${limit}`);

export const fetchWallet = (pubkey: string) => get<WalletResponse>(`/wallet/${encodeURIComponent(pubkey)}`);

export const fetchQuests = () => get<QuestsResponse>("/quests");

export const postReferralCode = (env: unknown) => post<{ code: string; created: boolean }>("/referral/code", env);
export const postReferralBind = (env: unknown) => post<{ bound: boolean; referrer: string; code: string }>("/referral/bind", env);
export const postSocialSubmit = (env: unknown) =>
  post<{ tweet_id: string; x_handle: string; points: number; posts_today: number }>("/social/submit", env);
export const postBountySubmit = (env: unknown) => post<{ id: string; status: string }>("/bounty/submit", env);
