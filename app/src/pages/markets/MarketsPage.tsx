import type { FC } from "react";
import { useSurfaceMode } from "../../hooks/useSurfaceMode";
import { MarketsAppBar } from "./MarketsAppBar";
import { MarketsTerminal } from "./MarketsTerminal";

/**
 * MarketsPage — the terminal discovery surface (design lock 2026-07-08).
 *
 * Replaces the paper/statement browser with a dark-default terminal: a
 * route-scoped MarketsAppBar over a fixed-height flex column whose body (protocol
 * strip · pulse tiles · two-level table · inspector) scrolls internally. Dark is
 * the default for /markets only (useSurfaceMode); the other trader pages keep
 * their paper palette + shared AppNav (which still owns "+ New Market").
 *
 * All numbers bind to real chain/derived state — see marketsView's honesty note:
 * no 24h tape (none is derivable), IV is the vol model, premia is cumulative.
 * Oracle provenance is never named in the rendered surface.
 */
export const MarketsPage: FC = () => {
  const { mode, toggle } = useSurfaceMode("dark");

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-l-bg font-sans text-l-text">
      <MarketsAppBar mode={mode} onToggleMode={toggle} />
      <MarketsTerminal />
    </div>
  );
};

export default MarketsPage;
