// =============================================================================
// xVerify.ts — X (Twitter) tweet verification
// =============================================================================
//
// The bearer token is READ-ONLY and lives in /etc/opta/x-read.env (root:opta
// 0640), loaded by systemd EnvironmentFile. Verified capability at build time:
// GET /2/tweets/:id returns 200 with author expansion; rate limit 450 / 15 min.
//
// The token is NEVER logged and NEVER appears in a response. An upstream failure
// surfaces as a generic 502 and the submission is NOT recorded, so the user can
// retry without having burned their nonce or their daily cap.
// =============================================================================

import { log } from "../log";

const X_API = "https://api.twitter.com/2/tweets";

export interface TweetFacts {
  tweetId: string;
  authorHandle: string;
  createdAt: number;
  text: string;
}

export type XVerifyOutcome =
  | { ok: true; tweet: TweetFacts }
  | { ok: false; reason: "not_found" | "no_mention" | "too_old" | "upstream" };

/** Extract a tweet id from any of the URL shapes X has used. */
export function extractTweetId(url: string): string | null {
  const m = /(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d{5,25})/i.exec(url);
  return m ? m[1] : null;
}

export interface XConfig {
  bearer: string | null;
  mentionHandle: string;
  maxAgeSecs: number;
}

/**
 * Fetch and validate a tweet.
 * `now` injected so the age check is testable.
 */
export async function verifyTweet(url: string, cfg: XConfig, now: number): Promise<XVerifyOutcome> {
  const id = extractTweetId(url);
  if (!id) return { ok: false, reason: "not_found" };
  if (!cfg.bearer) {
    log.warn("x verify attempted with no bearer configured");
    return { ok: false, reason: "upstream" };
  }

  let body: {
    data?: { id: string; text: string; created_at: string; author_id: string };
    includes?: { users?: { id: string; username: string }[] };
  };
  try {
    const res = await fetch(
      `${X_API}/${id}?tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`,
      { headers: { Authorization: `Bearer ${cfg.bearer}` } },
    );
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (!res.ok) {
      // Log the STATUS only — never the URL (it is fine) and never the token.
      log.warn("x api non-2xx", { status: res.status, remaining: res.headers.get("x-rate-limit-remaining") });
      return { ok: false, reason: "upstream" };
    }
    body = (await res.json()) as typeof body;
  } catch (e) {
    log.warn("x api fetch failed", { err: (e as Error).message });
    return { ok: false, reason: "upstream" };
  }

  const data = body.data;
  const user = body.includes?.users?.find((u) => u.id === data?.author_id);
  if (!data || !user) return { ok: false, reason: "not_found" };

  const createdAt = Math.floor(Date.parse(data.created_at) / 1000);
  if (!Number.isFinite(createdAt)) return { ok: false, reason: "not_found" };
  if (now - createdAt > cfg.maxAgeSecs) return { ok: false, reason: "too_old" };

  if (!data.text.toLowerCase().includes(cfg.mentionHandle.toLowerCase())) {
    return { ok: false, reason: "no_mention" };
  }

  return {
    ok: true,
    tweet: { tweetId: data.id, authorHandle: user.username, createdAt, text: data.text },
  };
}
