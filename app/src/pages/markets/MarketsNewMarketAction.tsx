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
      <button
        type="button"
        onClick={() => setShowNewMarket(true)}
        data-testid="new-market-open"
        className="hidden items-center rounded-[6px] border border-l-muted px-[13px] py-[7px] font-sans text-[13px] font-medium text-l-text transition-colors duration-300 ease-opta hover:border-l-text sm:inline-flex"
      >
        New market
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
