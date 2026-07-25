// =============================================================================
// rpc.ts — raw JSON-RPC client (batched), no web3.js on the hot path
// =============================================================================
//
// Using raw JSON-RPC rather than web3.js gives us:
//   - ONE code path for legacy and v0 transactions (encoding "json" always
//     returns the same shape; ALT keys arrive in meta.loadedAddresses),
//   - native request BATCHING, which is what makes the backfill tractable
//     (D6: 10 txs/request at 5 req/s = 50 tx/s, ~35 min instead of ~5.7 h).
//
// The RPC URL is a private Helius endpoint and is NEVER logged.
// =============================================================================

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

interface RpcRequest {
  method: string;
  params: unknown[];
}

export class RpcClient {
  private id = 0;
  private lastCallMs = 0;

  constructor(
    private readonly url: string,
    private readonly minIntervalMs: number,
  ) {}

  /** Simple leading-edge throttle so we never exceed the configured rps. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.lastCallMs + this.minIntervalMs - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallMs = Date.now();
  }

  private async post(body: unknown): Promise<unknown> {
    await this.throttle();
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Do not include the URL in the message — it carries the api key.
      throw new Error(`RPC HTTP ${res.status}`);
    }
    return res.json();
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const out = (await this.post({ jsonrpc: "2.0", id: ++this.id, method, params })) as {
      result?: T;
      error?: { message?: string; code?: number };
    };
    if (out.error) throw new Error(`RPC ${method}: ${out.error.message ?? out.error.code}`);
    return out.result as T;
  }

  /** Batched call. Returns results positionally; a per-item error yields null. */
  async batch<T>(reqs: RpcRequest[]): Promise<(T | null)[]> {
    if (reqs.length === 0) return [];
    const payload = reqs.map((r) => ({ jsonrpc: "2.0", id: ++this.id, method: r.method, params: r.params }));
    const out = (await this.post(payload)) as { id: number; result?: T; error?: unknown }[];
    if (!Array.isArray(out)) throw new Error("RPC batch: non-array response");
    const byId = new Map(out.map((o) => [o.id, o]));
    return payload.map((p) => {
      const r = byId.get(p.id);
      if (!r || r.error) return null;
      return (r.result ?? null) as T | null;
    });
  }

  async getSignaturesForAddress(
    address: string,
    opts: { limit?: number; before?: string; until?: string },
  ): Promise<SignatureInfo[]> {
    const cfg: Record<string, unknown> = { limit: opts.limit ?? 1000, commitment: "confirmed" };
    if (opts.before) cfg.before = opts.before;
    if (opts.until) cfg.until = opts.until;
    return (await this.call<SignatureInfo[]>("getSignaturesForAddress", [address, cfg])) ?? [];
  }

  getTransactionBatch(sigs: string[]): Promise<(unknown | null)[]> {
    return this.batch(
      sigs.map((s) => ({
        method: "getTransaction",
        params: [s, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      })),
    );
  }
}
