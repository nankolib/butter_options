// =============================================================================
// UtilitiesSection — collapsed, de-emphasized utility area below ACTIVITY.
// =============================================================================
// Preserves two low-prominence flows from the legacy page at ZERO prominence:
//   • SettleExpiriesSection — public-good settle crank UI (anyone)
//   • MigrateFeedSection    — admin migrate (self-gates via useIsAdmin → null)
// Both are the existing components verbatim (flows untouched). They carry the
// legacy PAPER palette — acceptable debt inside a collapsed disclosure that is
// closed by default; a terminal reskin of these two is a later slice.
// =============================================================================

import type { FC } from "react";
import { PublicKey } from "@solana/web3.js";
import { SettleExpiriesSection } from "../SettleExpiriesSection";
import { MigrateFeedSection } from "../MigrateFeedSection";

interface AccountWrapper {
  publicKey: PublicKey;
  account: any;
}

export const UtilitiesSection: FC<{
  vaults: AccountWrapper[];
  markets: AccountWrapper[];
  settlementRecords: AccountWrapper[];
  onRefetch: () => void;
  collapsed: boolean;
  onToggle: () => void;
}> = ({ vaults, markets, settlementRecords, onRefetch, collapsed, onToggle }) => {
  const open = !collapsed;
  return (
    <section className="mb-6 border-t border-l-hair pt-4" data-testid="utilities-band" data-collapsed={collapsed ? "true" : "false"}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="utilities-toggle"
        className="flex w-full items-center justify-between font-mono-plex text-[10px] uppercase tracking-[0.16em] text-l-faint transition-colors hover:text-l-muted"
      >
        <span>Utilities · settle · migrate</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        // The two legacy sections render their own (paper) chrome; scope them in a
        // light panel so the paper palette reads intentionally, not as a bug.
        <div className="mt-4 rounded-[10px] border border-l-hair bg-paper p-4 text-ink" data-testid="utilities-body">
          <SettleExpiriesSection
            vaults={vaults}
            markets={markets}
            settlementRecords={settlementRecords}
            onRefetch={onRefetch}
          />
          <MigrateFeedSection markets={markets} onRefetch={onRefetch} />
        </div>
      )}
    </section>
  );
};

export default UtilitiesSection;
