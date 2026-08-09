// =============================================================================
// PointsChip — nav chip: points total + multiplier. Flag-gated, mono.
// =============================================================================
// Renders NOTHING when: the flag is off, no wallet is connected, or the API is
// unreachable. The nav bar's flex layout is therefore untouched in every off
// state.
//
// A wallet with ZERO points DOES render, as "0 · 1.0x" (founder call,
// 2026-08-09, reversing the earlier "an empty chip is noise" call). The earlier
// rule was written when zero was indistinguishable from unreachable: a new
// wallet 404'd, the chip degraded silently, and blank meant both "you have no
// points" and "we cannot tell you". fetchWallet now resolves that 404 into a
// real zero, so a rendered 0 is a fact about the wallet and blank is reserved
// for "we could not ask".
// =============================================================================

import { useEffect, useState, type FC } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";

import { EPOCH0_UI, fetchWallet } from "../utils/epoch0";
import { multiplier as fmtMultiplier, points as fmtPoints } from "../utils/epoch0Format";

export const PointsChip: FC = () => {
  const { publicKey, connected } = useWallet();
  const [data, setData] = useState<{ total: number; mult: number } | null>(null);

  useEffect(() => {
    let live = true;
    if (!EPOCH0_UI || !connected || !publicKey) {
      setData(null);
      return;
    }
    void (async () => {
      const res = await fetchWallet(publicKey.toBase58());
      if (!live) return;
      if (!res.ok) {
        setData(null); // degrade silently — the chip is not worth an error state
        return;
      }
      // Serve-side total, never a client-side sum of the components.
      setData({ total: res.data.points?.total ?? 0, mult: res.data.multiplier ?? 1 });
    })();
    return () => {
      live = false;
    };
  }, [connected, publicKey]);

  if (!EPOCH0_UI || !connected || !data) return null;

  return (
    <Link
      to="/leaderboard"
      title="Leaderboard"
      className="hidden items-center gap-[6px] rounded-[4px] border border-l-faint px-[7px] py-[3px] font-mono-plex text-[10px] tabular-nums tracking-[0.08em] text-l-muted transition-colors duration-150 hover:border-l-muted hover:text-l-text sm:inline-flex"
    >
      <span>{fmtPoints(data.total)}</span>
      <span aria-hidden="true" className="text-l-faint">·</span>
      <span>{fmtMultiplier(data.mult)}</span>
    </Link>
  );
};
