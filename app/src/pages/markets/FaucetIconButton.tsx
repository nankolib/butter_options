import type { FC, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { inferClusterFromUrl } from "../../utils/env";
import { SolMark, UsdcMark } from "../../assets/BrandMarks";

/**
 * FaucetIconButton — terminal-surface faucet control (SOL or USDC).
 *
 * Same server-side flow as DevnetSolButton / DevnetFaucetButton (POST
 * /api/faucet, durable per-wallet cooldown, browser holds no key). The endpoint
 * returns (verified against the live faucet):
 *   • 200 SOL  → { signature, kind:"sol", sol:0.05 }
 *   • 200 USDC → { signature, kind:"usdc", balance:10000 }  (resulting balance)
 *   • 429      → { error:"Faucet cooldown — try again in 3h 59m", retryAfter:14355 }
 *   • 503      → { error } (faucet not configured)
 *
 * Every outcome is made VISIBLE: the logo flips (teal check / crimson cross /
 * pulsing while in-flight) AND a small inline mono flyout drops below the button
 * ("+0.05 SOL" / "Cooldown · 3h 59m" / error reason) that fades after ~2.5s. No
 * toasts (per the brief's no-toast-spam rule). Self-gates: connected AND devnet.
 */
type Kind = "sol" | "usdc";
type Phase = "idle" | "loading" | "success" | "error";

const SHOW_MS = 2200; // hold fully-visible before the fade
const CLEAR_MS = 2500; // fully reset (logo back to idle) after the fade

/** retryAfter seconds → compact "2d 3h" / "3h 59m" / "12m" / "45s". */
function fmtCooldown(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "soon";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(secs)}s`;
}

export const FaucetIconButton: FC<{ kind: Kind }> = ({ kind }) => {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState("");
  const [show, setShow] = useState(false);
  const timers = useRef<number[]>([]);
  const isDevnet = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint) === "devnet",
    [connection.rpcEndpoint],
  );

  if (!connected || !isDevnet) return null;

  const label = kind === "sol" ? "Get devnet SOL" : "Get devnet USDC";

  const flash = (nextPhase: Phase, text: string) => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setPhase(nextPhase);
    setMsg(text);
    setShow(true);
    timers.current.push(window.setTimeout(() => setShow(false), SHOW_MS));
    timers.current.push(
      window.setTimeout(() => {
        setPhase("idle");
        setMsg("");
      }, CLEAR_MS),
    );
  };

  const claim = async () => {
    if (!publicKey || phase === "loading") return;
    setShow(false);
    setMsg("");
    setPhase("loading");
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "sol" ? { wallet: publicKey.toBase58(), kind: "sol" } : { wallet: publicKey.toBase58() }),
      });
      const data = await res.json().catch(() => ({}) as any);
      if (res.ok) {
        flash(
          "success",
          kind === "sol"
            ? `+${typeof data.sol === "number" ? data.sol : 0.05} SOL`
            : `${typeof data.balance === "number" ? data.balance.toLocaleString() : "10,000"} USDC`,
        );
      } else if (res.status === 429) {
        flash("error", `Cooldown · ${fmtCooldown(Number(data.retryAfter))}`);
      } else if (res.status === 503) {
        flash("error", "Faucet offline");
      } else {
        flash("error", data.error ? String(data.error).replace(/^Faucet[:\s-]*/i, "") : "Faucet failed");
      }
    } catch (err: any) {
      flash("error", err?.message ? "Network error" : "Faucet failed");
    }
  };

  let inner: ReactNode;
  if (phase === "success") {
    inner = (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-l-up)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  } else if (phase === "error") {
    inner = (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-l-down)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  } else {
    inner = (
      <span className={phase === "loading" ? "flex animate-l-pulse" : "flex"}>
        {kind === "sol" ? <SolMark /> : <UsdcMark />}
      </span>
    );
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={claim}
        disabled={phase === "loading"}
        title={msg || label}
        aria-label={label}
        className="inline-flex h-[27px] w-[27px] items-center justify-center rounded-full border border-l-hair bg-l-surface p-0 transition-colors duration-300 ease-opta hover:border-l-muted disabled:cursor-wait"
      >
        {inner}
      </button>
      {msg && (
        <span
          role="status"
          className={`pointer-events-none absolute right-0 top-[calc(100%+6px)] z-[80] whitespace-nowrap rounded-[5px] border bg-l-surface-2 px-[8px] py-[4px] font-mono-plex text-[10px] tabular-nums shadow-sm transition-opacity duration-300 ${
            show ? "opacity-100" : "opacity-0"
          } ${phase === "error" ? "border-l-down text-l-down" : "border-l-up text-l-up"}`}
        >
          {msg}
        </span>
      )}
    </span>
  );
};

export default FaucetIconButton;
