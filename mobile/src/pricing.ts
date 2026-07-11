function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

function defaultVolatility(asset: string): number {
  const lower = asset.toLowerCase();
  if (lower === "btc" || lower === "bitcoin") return 0.65;
  if (lower === "eth" || lower === "ethereum") return 0.75;
  if (lower === "sol" || lower === "solana") return 0.85;
  if (lower === "aapl") return 0.35;
  if (lower === "tsla") return 0.6;
  if (lower === "nvda") return 0.55;
  if (["googl", "msft", "amzn", "meta"].some((item) => lower.includes(item))) return 0.4;
  if (["xau", "gold"].some((item) => lower.includes(item))) return 0.25;
  if (["xag", "silver"].some((item) => lower.includes(item))) return 0.35;
  if (["wti", "oil", "crude"].some((item) => lower.includes(item))) return 0.55;
  if (["eur", "gbp", "jpy", "usd"].some((item) => lower.includes(item))) return 0.1;
  return 0.8;
}

function applySmile(baseVol: number, spot: number, strike: number, asset: string): number {
  if (spot <= 0 || strike <= 0) return baseVol;
  const lower = asset.toLowerCase();
  const logMoneyness = Math.log(strike / spot);
  let curvature = 0.8;
  let tilt = -0.15;
  if (["aapl", "tsla", "nvda", "googl", "msft", "amzn", "meta"].some((item) => lower.includes(item))) {
    curvature = 0.5;
    tilt = -0.25;
  } else if (["xau", "gold", "xag", "silver", "wti", "oil", "crude"].some((item) => lower.includes(item))) {
    curvature = 0.6;
    tilt = -0.1;
  } else if (["eur", "gbp", "jpy", "usd"].some((item) => lower.includes(item))) {
    curvature = 0.3;
    tilt = -0.05;
  }
  const smile = 1 + curvature * logMoneyness ** 2 + tilt * logMoneyness;
  return Math.min(5, baseVol * Math.max(0.5, smile));
}

export function estimatePremium(params: {
  asset: string;
  side: "call" | "put";
  spot: number | null | undefined;
  strike: number;
  expiry: number;
}): number {
  const { asset, side, spot, strike, expiry } = params;
  if (!spot || spot <= 0 || strike <= 0 || expiry <= Date.now() / 1000) return 0;
  const t = Math.max(0, (expiry - Date.now() / 1000) / 31_536_000);
  if (t <= 0) return 0;
  const vol = applySmile(defaultVolatility(asset), spot, strike, asset);
  const rate = 0.05;
  const d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * t) / (vol * Math.sqrt(t));
  const d2 = d1 - vol * Math.sqrt(t);
  if (side === "call") {
    return Math.max(0, spot * normalCdf(d1) - strike * Math.exp(-rate * t) * normalCdf(d2));
  }
  return Math.max(0, strike * Math.exp(-rate * t) * normalCdf(-d2) - spot * normalCdf(-d1));
}

export function collateralRequired(strike: number, contracts: number): number {
  return Math.max(0, strike) * Math.max(0, Math.floor(contracts));
}

export function nextFridayUtc8(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0, 0));
  const daysUntilFriday = (5 - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + daysUntilFriday);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 7);
  }
  return Math.floor(next.getTime() / 1000);
}
