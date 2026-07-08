import type { FC, ReactNode } from "react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { FaucetIconButton } from "./FaucetIconButton";
import { NewMarketModal } from "./NewMarketModal";

/**
 * MarketsAppBar — route-scoped terminal header for the redesigned /markets.
 *
 * Deliberately NOT the shared AppNav (paper palette, parked, used by the other
 * trader pages): this is the dark-default terminal chrome per the design lock —
 * logo · center nav · faucet icons · DEVNET badge · mode toggle · New market ·
 * wallet. Other pages keep AppNav until their own redesign slice. Sits as a
 * flex-none row at the top of the terminal's flex column (the whole surface is a
 * fixed-height column with an internally-scrolling body), so no fixed offset.
 *
 * "New market" is a SECONDARY outlined button (Connect wallet stays the only
 * primary). It reuses the existing NewMarketModal as-is — that modal's paper
 * palette clashes with the terminal chrome; its terminal reskin is a later slice
 * (tracked in HANDOFF). Mirrors AppNav's connect-first gate.
 */
export const MarketsAppBar: FC<{ mode: "light" | "dark"; onToggleMode: () => void }> = ({
  mode,
  onToggleMode,
}) => {
  const { publicKey, connected, disconnect } = useWallet();
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
    <header className="flex h-[52px] flex-none items-center gap-4 border-b border-l-hair px-5">
      {/* Logo — italic Fraunces "opta" + mode-aware dot (flat, no glow) */}
      <span
        aria-label="opta"
        className="inline-flex items-baseline font-serif font-medium italic leading-none text-l-text text-[22px] tracking-[-0.01em] font-fraunces-text normal-case"
      >
        opta
        <span aria-hidden="true" className="ml-[3px] inline-block h-[6px] w-[6px] rounded-full bg-l-dot" />
      </span>

      {/* Center nav */}
      <nav className="hidden flex-1 items-center justify-center gap-6 md:flex" aria-label="Primary">
        <BarLink to="/markets">Markets</BarLink>
        <BarLink to="/trade">Trade</BarLink>
        <BarLink to="/write">Write</BarLink>
        <BarLink to="/portfolio">Portfolio</BarLink>
        <BarLink to="/docs">Docs</BarLink>
      </nav>

      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-[10px] md:ml-0">
        <FaucetIconButton kind="sol" />
        <FaucetIconButton kind="usdc" />
        <span className="hidden items-center rounded-[4px] border border-l-faint px-[7px] py-[3px] font-mono-plex text-[10px] tracking-[0.14em] text-l-muted sm:inline-flex">
          DEVNET
        </span>
        <button
          type="button"
          onClick={onToggleMode}
          aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
          className="inline-flex h-[27px] w-[27px] items-center justify-center rounded-full border border-l-hair bg-l-surface transition-colors duration-300 ease-opta hover:border-l-muted"
        >
          <span aria-hidden="true" className="h-[9px] w-[9px] rounded-full bg-l-dot" />
        </button>
        <button
          type="button"
          onClick={handleNewMarket}
          className="hidden items-center rounded-[6px] border border-l-muted px-[13px] py-[7px] font-sans text-[13px] font-medium text-l-text transition-colors duration-300 ease-opta hover:border-l-text sm:inline-flex"
        >
          New market
        </button>
        {connected && publicKey ? (
          <>
            <span data-ph-mask className="hidden items-center gap-2 font-mono-plex text-[11px] text-l-muted sm:inline-flex">
              <span aria-hidden="true" className="inline-block h-[6px] w-[6px] rounded-full bg-l-dot" />
              {truncate(publicKey.toBase58())}
            </span>
            <button
              type="button"
              onClick={() => disconnect()}
              className="inline-flex items-center rounded-[6px] border border-l-muted px-[13px] py-[7px] font-sans text-[13px] font-medium text-l-text transition-colors duration-300 ease-opta hover:border-l-text"
            >
              Disconnect
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setVisible(true)}
            className="inline-flex items-center rounded-[6px] bg-l-up px-[14px] py-[8px] font-sans text-[13px] font-medium text-l-on-up transition-opacity duration-300 ease-opta hover:opacity-90"
          >
            Connect wallet
          </button>
        )}
      </div>
    </header>
    {showNewMarket && (
      <NewMarketModal
        onClose={() => setShowNewMarket(false)}
        onCreated={() => setShowNewMarket(false)}
      />
    )}
    </>
  );
};

const BarLink: FC<{ to: string; children: ReactNode }> = ({ to, children }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `inline-flex items-center gap-[6px] font-sans text-[13px] no-underline transition-colors duration-200 ease-opta ${
        isActive ? "text-l-text" : "text-l-muted hover:text-l-text"
      }`
    }
  >
    {({ isActive }) => (
      <>
        {isActive && <span aria-hidden="true" className="h-[5px] w-[5px] rounded-full bg-l-dot" />}
        {children}
      </>
    )}
  </NavLink>
);

function truncate(pk: string): string {
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export default MarketsAppBar;
