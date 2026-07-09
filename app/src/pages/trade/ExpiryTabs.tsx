import type { FC } from "react";

type ExpiryTabsProps = {
  expiries: number[];
  selected: number;
  onSelect: (expiry: number) => void;
};

/**
 * Horizontal terminal chip row of available expiries. Selected = leading
 * teal dot + surface fill + emphasized text; others muted with hairline
 * border. Dates + countdowns render mono/tabular.
 *
 * Chip label: short date + countdown, e.g. "03 MAY 5D 21H". When
 * countdown is < 1 day it falls back to hours; < 1 hour to minutes.
 */
export const ExpiryTabs: FC<ExpiryTabsProps> = ({ expiries, selected, onSelect }) => {
  if (expiries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-[6px] mb-8">
      {expiries.map((ts) => {
        const active = ts === selected;
        return (
          <button
            key={ts}
            type="button"
            onClick={() => onSelect(ts)}
            aria-pressed={active}
            className={`inline-flex items-center gap-[7px] rounded-[6px] border px-[11px] py-[6px] font-mono-plex text-[12px] tabular-nums transition-colors ${
              active
                ? "border-l-hair bg-l-surface text-l-text"
                : "border-l-hair text-l-muted hover:text-l-text hover:bg-l-surface"
            }`}
          >
            {active && (
              <span
                aria-hidden="true"
                className="h-[6px] w-[6px] flex-none rounded-full"
                style={{ background: "var(--color-l-up)" }}
              />
            )}
            <span className={active ? "text-l-text" : ""}>{formatShortDate(ts)}</span>
            <span className={active ? "text-l-muted" : "text-l-faint"}>
              {formatCountdown(ts)}
            </span>
          </button>
        );
      })}
    </div>
  );
};

function formatShortDate(unix: number): string {
  return new Date(unix * 1000)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })
    .toUpperCase();
}

function formatCountdown(unix: number): string {
  const diff = unix - Date.now() / 1000;
  if (diff <= 0) return "Expired";
  if (diff < 3600) return `${Math.floor(diff / 60)}M`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}H ${Math.floor((diff % 3600) / 60)}M`;
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  return `${days}D ${hours}H`;
}

export default ExpiryTabs;
