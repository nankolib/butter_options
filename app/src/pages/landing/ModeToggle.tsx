import type { FC } from "react";

type ModeToggleProps = {
  mode: "light" | "dark";
  onToggle: () => void;
};

/**
 * Top-right light/dark control for the Landing.
 *
 * Renders the CURRENT mode word (IBM Plex Mono, tracked uppercase) beside
 * a hairline ring holding a small dot. Clicking flips the mode. The button
 * carries ≥44px of interactive height for mobile tap targets; the visible
 * chrome sits inside that.
 */
export const ModeToggle: FC<ModeToggleProps> = ({ mode, onToggle }) => (
  <button
    type="button"
    onClick={onToggle}
    aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
    className="group inline-flex min-h-[44px] items-center gap-[10px] px-1 font-mono-plex text-[11px] font-medium uppercase tracking-[0.18em] text-l-muted transition-colors duration-300 ease-opta hover:text-l-text"
  >
    <span>{mode}</span>
    <span
      aria-hidden="true"
      className="relative inline-flex h-[16px] w-[16px] items-center justify-center rounded-full border border-l-hair transition-colors duration-500 ease-opta"
    >
      <span className="h-[6px] w-[6px] rounded-full bg-l-dot transition-colors duration-500 ease-opta" />
    </span>
  </button>
);

export default ModeToggle;
