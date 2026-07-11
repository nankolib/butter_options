import type { FC } from "react";
import { useSurfaceMode } from "../../hooks/useSurfaceMode";
import { TerminalAppBar } from "../../components/TerminalAppBar";
import { MarketsNewMarketAction } from "./MarketsNewMarketAction";
import { MarketsTerminal } from "./MarketsTerminal";
import { useMarketsData } from "./useMarketsData";

/**
 * MarketsPage — the terminal discovery surface (design lock 2026-07-08).
 *
 * Replaces the paper/statement browser with a dark-default terminal: the shared
 * TerminalAppBar over a fixed-height flex column whose body (protocol strip ·
 * pulse tiles · two-level table · inspector) scrolls internally. Dark is the
 * default for /markets only (useSurfaceMode); the other trader pages keep their
 * paper palette + shared AppNav. Markets passes its "New market" control as the
 * bar's pageAction slot; other pages pass none.
 *
 * All numbers bind to real chain/derived state — see marketsView's honesty note:
 * no 24h tape (none is derivable), IV is the vol model, premia is cumulative.
 * Oracle provenance is never named in the rendered surface.
 */
export const MarketsPage: FC = () => {
  const { mode, toggle } = useSurfaceMode("dark");
  // Lifted so a create from the bar's pageAction can refetch the terminal body
  // (both consume this one instance) — closes the AppNav-era cross-owner gap.
  const marketsData = useMarketsData();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-l-bg font-sans text-l-text">
      <TerminalAppBar
        mode={mode}
        onToggleMode={toggle}
        pageAction={<MarketsNewMarketAction onMarketCreated={marketsData.refetch} />}
      />
      <MarketsTerminal data={marketsData} />
    </div>
  );
};

export default MarketsPage;
