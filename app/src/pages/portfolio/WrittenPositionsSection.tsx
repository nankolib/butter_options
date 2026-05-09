// =============================================================================
// WrittenPositionsSection.tsx — § 02 · Vaults Written
// =============================================================================
//
// Section wrapper for the writer-side rows. Mirrors OpenPositionsSection
// structurally: SectionNumber eyebrow + count + filter pills + table.
// Reuses FilterPills (already supports the four filter ids the spec calls
// for: ALL / CALLS / PUTS / EXPIRING < 7D).
//
// Empty state per D9: when the wallet has no WriterPositions, render a
// soft empty card without table headers. Settled-and-zeroed rows are
// kept in the section per D9 (they remain in myPositions until
// withdraw_post_settlement closes the WriterPosition account).
// =============================================================================

import type { FC } from "react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { SectionNumber } from "../../components/layout";
import { FilterPills, type FilterId } from "./FilterPills";
import { WriterPositionsTable } from "./WriterPositionsTable";
import type { WriterRow, WriterRowAction } from "./writerRows";

type WrittenPositionsSectionProps = {
  rows: WriterRow[];
  onAction: (row: WriterRow, action: WriterRowAction) => void;
  busyId: string | null;
  busyLabel: string | null;
};

export const WrittenPositionsSection: FC<WrittenPositionsSectionProps> = ({
  rows,
  onAction,
  busyId,
  busyLabel,
}) => {
  const [filter, setFilter] = useState<FilterId>("all");

  const filtered = useMemo(
    () => rows.filter((r) => matchesFilter(r, filter)),
    [rows, filter],
  );

  const count = rows.length;

  // Empty state per D9 — no headers, no filters, just a nudge to /write.
  if (count === 0) {
    return (
      <section className="mt-16">
        <div className="flex items-baseline gap-4 mb-6">
          <SectionNumber number="02" label="Vaults written" />
          <span className="font-mono text-[11.5px] uppercase tracking-[0.18em] opacity-55">
            0 vaults
          </span>
        </div>
        <div className="border border-rule rounded-md p-12 text-center">
          <p className="font-sans italic font-normal leading-[1.55] opacity-65 text-[15px] m-0 mb-4">
            No vaults written yet.
          </p>
          <Link
            to="/write"
            className="inline-flex items-center gap-2 rounded-full border border-ink bg-ink text-paper px-[18px] py-[10px] font-mono text-[11px] uppercase tracking-[0.2em] no-underline transition-[background-color,color] duration-500 ease-opta hover:bg-transparent hover:text-ink"
          >
            Write a vault
            <span aria-hidden="true">→</span>
          </Link>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-50 mt-4 m-0">
            Sell options · Earn premium · USDC
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="flex items-baseline gap-4">
          <SectionNumber number="02" label="Vaults written" />
          <span className="font-mono text-[11.5px] uppercase tracking-[0.18em] opacity-55">
            {count} {count === 1 ? "vault" : "vaults"}
          </span>
        </div>
        <FilterPills active={filter} onChange={setFilter} />
      </div>

      <WriterPositionsTable
        rows={filtered}
        onAction={onAction}
        busyId={busyId}
        busyLabel={busyLabel}
        emptyState={
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-sans italic font-normal leading-[1.55] opacity-65 text-[15px] m-0">
              No vaults match "{filterLabel(filter)}".
            </p>
          </div>
        }
      />
    </section>
  );
};

function matchesFilter(r: WriterRow, filter: FilterId): boolean {
  if (filter === "all") return true;
  if (filter === "calls") return r.side === "call";
  if (filter === "puts") return r.side === "put";
  if (filter === "expiring-7d") {
    if (r.state !== "live") return false;
    const days = (r.expiry - Date.now() / 1000) / 86400;
    return days < 7;
  }
  return true;
}

function filterLabel(id: FilterId): string {
  switch (id) {
    case "calls":
      return "Calls";
    case "puts":
      return "Puts";
    case "expiring-7d":
      return "Expiring < 7d";
    default:
      return "All";
  }
}

export default WrittenPositionsSection;
