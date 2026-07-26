// =============================================================================
// PointsChip — nav chip: points total + multiplier. Flag-gated, mono.
// =============================================================================
// Renders NOTHING when: the flag is off, no wallet is connected, the API is
// unreachable, or the wallet has zero points (founder call — an empty chip is
// noise). The nav bar's flex layout is therefore untouched in every off state.
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
      const p = res.data.points;
      setData({ total: (p?.base ?? 0) + (p?.quests ?? 0) + (p?.social ?? 0), mult: res.data.multiplier ?? 1 });
    })();
    return () => {
      live = false;
    };
  }, [connected, publicKey]);

  if (!EPOCH0_UI || !connected || !data || data.total <= 0) return null;

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
