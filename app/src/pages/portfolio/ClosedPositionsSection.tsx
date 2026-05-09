import type { FC } from "react";
import { useState } from "react";
import { SectionNumber } from "../../components/layout";
import { PositionsTable } from "./PositionsTable";
import type { Position, PositionAction } from "./positions";

type ClosedPositionsSectionProps = {
  /** Positions already pre-filtered to "closed" (settled-otm) by the parent. */
  positions: Position[];
  onAction: (p: Position, action: PositionAction) => void;
  busyId: string | null;
};

/**
 * § 03 · Closed positions section.
 *
 * Closed = settled-otm — settled with $0 payout, user still holds
 * worthless dust until they burn it. Renders the same PositionsTable
 * with `muted` styling so the visual weight is lower than open.
 *
 * Default expanded state: open if there are any closed positions,
 * collapsed otherwise. Header click toggles regardless. The toggle
 * doesn't unmount the table — just hides it via conditional render —
 * so re-expanding doesn't re-fetch or re-paint.
 */
export const ClosedPositionsSection: FC<ClosedPositionsSectionProps> = ({
  positions,
  onAction,
  busyId,
}) => {
  const [expanded, setExpanded] = useState(positions.length > 0);
  const count = positions.length;

  return (
    <section className="mt-16">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group flex items-baseline gap-4 mb-6"
      >
        <SectionNumber number="03" label="Closed positions" />
        <span className="font-mono font-medium text-[11.5px] uppercase tracking-[0.18em] text-ink-muted group-hover:text-ink transition-colors duration-300 ease-opta">
          {count} {count === 1 ? "contract" : "contracts"} {expanded ? "—" : "+"}
        </span>
      </button>

      {expanded && (
        <PositionsTable
          positions={positions}
          onAction={onAction}
          busyId={busyId}
          muted
          emptyState={
            <div className="border border-rule rounded-md p-8 text-center">
              <p className="font-sans italic font-medium leading-[1.55] text-ink-body text-[14px] m-0">
                No closed positions.
              </p>
            </div>
          }
        />
      )}
    </section>
  );
};

export default ClosedPositionsSection;
