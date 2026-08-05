// =============================================================================
// server.ts — in-process HTTP listener, LOOPBACK ONLY
// =============================================================================
//
// Binds 127.0.0.1 by default and is never exposed directly. Public access is
// nginx's job, and that conf ships STAGED (deploy/nginx/points-api.conf.staged)
// rather than applied — see GO-LIVE.md. Nothing about this listener is reachable
// from the internet until that step is taken deliberately.
//
// In-process by design: no second service, no second RPC client, no second copy
// of the DB handle, and no extra resident memory beyond the request buffers.
// =============================================================================

import * as http from "node:http";

import type { Config } from "../env";
import type { DB } from "../db";
import { log } from "../log";
import {
  getLeaderboard,
  getQuests,
  getRules,
  getStats,
  getWallet,
  postBountySubmit,
  postReferralBind,
  postReferralCode,
  postSocialSubmit,
  type ApiDeps,
  type ApiResponse,
} from "./handlers";

const MAX_BODY_BYTES = 4096;

function send(res: http.ServerResponse, r: ApiResponse): void {
  const payload = JSON.stringify(r.body);
  res.writeHead(r.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const ctype = String(req.headers["content-type"] ?? "");
  if (!ctype.toLowerCase().includes("application/json")) {
    return { ok: false, status: 415, error: "expected_application_json" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: "body_too_large" };
    chunks.push(c as Buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

export function createApiServer(db: DB, cfg: Config): http.Server {
  const deps: ApiDeps = {
    db,
    x: { bearer: cfg.xBearer, mentionHandle: cfg.xMention, maxAgeSecs: cfg.xMaxAgeSecs },
    cooldownSecs: cfg.writeCooldownSecs,
    socialPointsPerPost: cfg.socialPointsPerPost,
    socialMaxPerDay: cfg.socialMaxPerDay,
    now: () => Math.floor(Date.now() / 1000),
  };

  return http.createServer(async (req, res) => {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(res, { status: 400, body: { error: "bad_url" } });
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      // ---- reads --------------------------------------------------------
      if (req.method === "GET") {
        if (path === "/api/points/leaderboard") {
          return send(res, getLeaderboard(db, url.searchParams.get("board") ?? "profit", Number(url.searchParams.get("limit") ?? 50)));
        }
        if (path === "/api/points/quests") return send(res, getQuests(db));
        if (path === "/api/points/rules") return send(res, getRules(db));
        if (path === "/api/points/stats") return send(res, getStats(db));
        if (path.startsWith("/api/points/wallet/")) {
          return send(res, getWallet(db, decodeURIComponent(path.slice("/api/points/wallet/".length))));
        }
        return send(res, { status: 404, body: { error: "not_found" } });
      }

      // ---- writes -------------------------------------------------------
      if (req.method === "POST") {
        const routes: Record<string, ((env: never) => ApiResponse | Promise<ApiResponse>) | undefined> = {
          "/api/points/referral/code": (env) => postReferralCode(deps, env),
          "/api/points/referral/bind": (env) => postReferralBind(deps, env),
          "/api/points/social/submit": (env) => postSocialSubmit(deps, env),
          "/api/points/bounty/submit": (env) => postBountySubmit(deps, env),
        };
        const handler = routes[path];
        if (!handler) return send(res, { status: 404, body: { error: "not_found" } });

        const body = await readJsonBody(req);
        if (!body.ok) return send(res, { status: body.status, body: { error: body.error } });
        return send(res, await handler(body.value as never));
      }

      return send(res, { status: 405, body: { error: "method_not_allowed" } });
    } catch (e) {
      // Never leak an internal message to the caller.
      log.error("api handler threw", { path, err: (e as Error).message });
      return send(res, { status: 500, body: { error: "internal" } });
    } finally {
      log.info("api", { method: req.method, path, ms: Date.now() - started });
    }
  });
}

export function startApiServer(db: DB, cfg: Config): http.Server | null {
  if (!cfg.apiEnabled) {
    log.info("api disabled", {});
    return null;
  }
  const server = createApiServer(db, cfg);
  server.listen(cfg.apiPort, cfg.apiHost, () => {
    log.info("api listening", { host: cfg.apiHost, port: cfg.apiPort, note: "loopback only; nginx conf is STAGED, not applied" });
  });
  server.on("error", (e) => log.error("api server error", { err: (e as Error).message }));
  return server;
}
