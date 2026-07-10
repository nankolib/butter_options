// =============================================================================
// portfolioUi — shared terminal primitives for the Portfolio ledgers.
// =============================================================================
// Badges, status pills, the outlined row-action button (with the pending 2px
// teal progress bar per the states appendix), section accent bands, and number
// formatters. Presentation only.
// =============================================================================

import type { FC, ReactNode } from "react";

export const fmtUsd = (v: number, dp = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export const fmtStrike = (v: number) =>
  v.toLocaleString(undefined, { maximumFractionDigits: v < 1 ? 4 : 2 });

export const fmtExpiry = (ts: number) =>
  new Date(ts * 1000)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" })
    .toUpperCase();

/** Compact "14h" / "3d 2h" / "45m" countdown from now to `unlockTs` (unix secs). */
export function fmtCountdown(unlockTs: number, nowSecs: number): string {
  const s = Math.max(0, unlockTs - nowSecs);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** `SOL 185 C` contract identity. */
export const contractLabel = (asset: string, strike: number, side: "call" | "put") =>
  `${asset} ${fmtStrike(strike)} ${side === "call" ? "C" : "P"}`;

// ---- badges ----------------------------------------------------------------

export const StyleBadge: FC<{ style: "european" | "american" }> = ({ style }) => (
  <span className="inline-flex items-center rounded-[4px] border border-l-hair px-[6px] py-[2px] font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">
    {style === "american" ? "AMER" : "EUR"}
  </span>
);

export const OriginBadge: FC<{ origin: "epoch" | "custom" }> = ({ origin }) => (
  <span className="inline-flex items-center rounded-[4px] border border-l-hair px-[6px] py-[2px] font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">
    {origin === "epoch" ? "EPOCH" : "CUSTOM"}
  </span>
);

export type StatusTone = "up" | "muted" | "faint" | "text";
export const StatusPill: FC<{ tone: StatusTone; children: ReactNode }> = ({ tone, children }) => {
  const cls =
    tone === "up"
      ? "text-l-up-text"
      : tone === "faint"
        ? "text-l-faint"
        : tone === "text"
          ? "text-l-text"
          : "text-l-muted";
  return <span className={`font-mono-plex text-[10px] uppercase tracking-[0.12em] ${cls}`}>{children}</span>;
};

// ---- row action ------------------------------------------------------------

/**
 * Outlined verb-first row action. `busy` renders the pending state: a
 * progressive label + a 2px teal progress bar along the button's bottom edge.
 * `destructive` swaps the outline to crimson (Burn unsold). `disabled` (LOCKED)
 * dims + blocks clicks.
 */
export const RowAction: FC<{
  onClick: () => void;
  busy?: boolean;
  busyLabel?: string | null;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
  children: ReactNode;
}> = ({ onClick, busy = false, busyLabel, disabled = false, destructive = false, title, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled || busy}
    title={title}
    className={`relative inline-flex items-center overflow-hidden rounded-[6px] border px-[10px] py-[5px] font-sans text-[11.5px] font-medium transition-colors duration-200 disabled:cursor-not-allowed ${
      destructive
        ? "border-l-down/60 text-l-down hover:border-l-down"
        : "border-l-muted text-l-text hover:border-l-text"
    } ${disabled && !busy ? "opacity-40" : ""}`}
  >
    {busy ? busyLabel ?? "Working…" : children}
    {busy && (
      <span
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-[2px] animate-l-pulse"
        style={{ background: "var(--color-l-up)" }}
      />
    )}
  </button>
);

// ---- section band ----------------------------------------------------------

/**
 * Accent header band for a ledger. `accent` drives the dot + 2px left border
 * (teal for holdings/long, crimson for written/short). Renders the eyebrow
 * label · count and an optional honest footnote.
 */
export const SectionBand: FC<{
  accent: "up" | "down";
  label: string;
  sublabel?: string;
  count: number;
  footnote?: string;
  right?: ReactNode;
  testid?: string;
}> = ({ accent, label, sublabel, count, footnote, right, testid }) => {
  const color = accent === "up" ? "var(--color-l-up)" : "var(--color-l-down)";
  return (
    <div className="mb-2" data-testid={testid} data-accent={accent}>
      <div
        className="flex items-center gap-[10px] border-l-2 bg-l-surface px-3 py-[9px]"
        style={{ borderColor: color }}
      >
        <span aria-hidden="true" className="h-[6px] w-[6px] rounded-full" style={{ background: color }} data-testid="band-dot" />
        <span className="font-mono-plex text-[11px] uppercase tracking-[0.16em] text-l-text">{label}</span>
        {sublabel && <span className="font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-faint">{sublabel}</span>}
        <span className="font-mono-plex text-[11px] tabular-nums text-l-muted">· {count}</span>
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {footnote && (
        <p className="mt-1.5 px-1 font-sans text-[11px] leading-[1.45] text-l-faint">{footnote}</p>
      )}
    </div>
  );
};

// ---- table shell -----------------------------------------------------------

export const Th: FC<{ align?: "left" | "right"; children?: ReactNode }> = ({ align = "left", children }) => (
  <th
    className={`sticky top-0 z-[1] bg-l-bg py-2 font-mono-plex text-[9px] font-normal uppercase tracking-[0.14em] text-l-faint ${
      align === "right" ? "text-right" : "text-left"
    }`}
  >
    {children}
  </th>
);

export const Td: FC<{
  align?: "left" | "right";
  tone?: "text" | "muted" | "faint" | "up" | "down";
  children?: ReactNode;
}> = ({ align = "left", tone = "muted", children }) => {
  const cls =
    tone === "text"
      ? "text-l-text"
      : tone === "faint"
        ? "text-l-faint"
        : tone === "up"
          ? "text-l-up-text"
          : tone === "down"
            ? "text-l-down"
            : "text-l-muted";
  return (
    <td className={`py-[7px] font-mono-plex text-[12px] tabular-nums ${align === "right" ? "text-right" : "text-left"} ${cls}`}>
      {children}
    </td>
  );
};

/** Signed number → tone for direction coloring (up teal / down crimson / neutral). */
export const signTone = (v: number | null): "up" | "down" | "muted" =>
  v == null || v === 0 ? "muted" : v > 0 ? "up" : "down";

export const EmptyLine: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="px-1 py-6 font-sans text-[13px] text-l-muted">{children}</div>
);

export const SkeletonRows: FC<{ cols: number; rows?: number }> = ({ cols, rows = 3 }) => (
  <>
    {Array.from({ length: rows }).map((_, r) => (
      <tr key={r} className="h-[30px] border-b border-l-hair/50">
        {Array.from({ length: cols }).map((_, c) => (
          <td key={c} className="py-[7px]">
            <span className="block h-[10px] w-[70%] animate-l-pulse rounded-[3px] bg-l-surface-2" />
          </td>
        ))}
      </tr>
    ))}
  </>
);
