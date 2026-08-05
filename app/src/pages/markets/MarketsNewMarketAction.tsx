import type { FC } from "react";
import { useState } from "react";
import { NewMarketModal } from "./NewMarketModal";

/**
 * MarketsNewMarketAction — the Markets-only "New market" control, passed to the
 * shared TerminalAppBar as its `pageAction` slot. Owns the modal state (moved
 * off the bar so the bar stays page-agnostic).
 *
 * The terminal modal opens regardless of connection — it owns its own "Wallet
 * not connected." + Connect-wallet state (locked design 1a). So the entry no
 * longer connect-gates (that gate belonged to the paper era). AppNav's separate
 * entry is parked and unchanged.
 *
 * onMarketCreated (from MarketsPage) refetches the terminal body on a landed
 * create — it does NOT close the modal, so the terminal variant's in-modal
 * success moment (Write-first-option deep link) stays visible.
 */
export const MarketsNewMarketAction: FC<{ onMarketCreated?: () => void }> = ({
  onMarketCreated,
}) => {
  const [showNewMarket, setShowNewMarket] = useState(false);

  return (
    <>
      {/* BLK-5 (audit 2026-08-04): this was `hidden … sm:inline-flex`, so the ONLY
          create-market entry on the terminal surface vanished below 640px and
          quest O3 "Make a Market" was unreachable on a phone. The bar is tight at
          390px, so mobile gets a compact "+ New" (shorter label + tighter padding);
          at sm+ every value resolves to the original, so the desktop control is
          pixel-identical. */}
      <button
        type="button"
        onClick={() => setShowNewMarket(true)}
        data-testid="new-market-open"
        data-tour="new-market-open"
        className="inline-flex flex-none items-center whitespace-nowrap rounded-[6px] border border-l-muted px-[9px] py-[6px] font-sans text-[12px] font-medium text-l-text transition-colors duration-300 ease-opta hover:border-l-text sm:px-[13px] sm:py-[7px] sm:text-[13px]"
      >
        <span className="sm:hidden">+ New</span>
        <span className="hidden sm:inline">New market</span>
      </button>
      {showNewMarket && (
        <NewMarketModal
          onClose={() => setShowNewMarket(false)}
          onCreated={() => onMarketCreated?.()}
        />
      )}
    </>
  );
};

export default MarketsNewMarketAction;
