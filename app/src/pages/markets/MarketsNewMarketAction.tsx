import type { FC } from "react";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { NewMarketModal } from "./NewMarketModal";

/**
 * MarketsNewMarketAction — the Markets-only "New market" control, passed to the
 * shared TerminalAppBar as its `pageAction` slot. Owns the modal state (moved
 * off the bar so the bar stays page-agnostic). Button markup is byte-identical
 * to the pre-extraction MarketsAppBar so /markets renders pixel-identical.
 *
 * SECONDARY outlined button (Connect wallet stays the only primary). Mirrors
 * AppNav's connect-first gate. The reused NewMarketModal keeps its paper palette
 * for now — its terminal reskin is a later slice (tracked in HANDOFF).
 */
export const MarketsNewMarketAction: FC = () => {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [showNewMarket, setShowNewMarket] = useState(false);

  const handleNewMarket = () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    setShowNewMarket(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleNewMarket}
        className="hidden items-center rounded-[6px] border border-l-muted px-[13px] py-[7px] font-sans text-[13px] font-medium text-l-text transition-colors duration-300 ease-opta hover:border-l-text sm:inline-flex"
      >
        New market
      </button>
      {showNewMarket && (
        <NewMarketModal
          onClose={() => setShowNewMarket(false)}
          onCreated={() => setShowNewMarket(false)}
        />
      )}
    </>
  );
};

export default MarketsNewMarketAction;
