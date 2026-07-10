// =============================================================================
// ActivitySection — ACTIVITY · RECENT. Bounded order-tape scan (honest footnote).
// =============================================================================
// TIME · ACTION · CONTRACT · QTY · AMOUNT (direction-colored) · SIG (mono + link).
// Order-tape verbs only (Wrote/Listed/Bid/Bought/Sold/Cancelled/Swept) — the
// footnote states the bound. Skeleton while scanning; one-line empty state.
// =============================================================================

import type { FC } from "react";
import { getSolscanTxUrl, type Cluster } from "../../../utils/env";
import { SectionBand, Th, Td, EmptyLine, SkeletonRows, fmtUsd, signTone } from "./portfolioUi";
import type { ActivityRow } from "./portfolioActivity";

const fmtTime = (ts: number) =>
  ts > 0
    ? new Date(ts * 1000)
        .toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
        .toUpperCase()
    : "—";

export const ActivitySection: FC<{
  rows: ActivityRow[];
  loading: boolean;
  cluster: Cluster;
}> = ({ rows, loading, cluster }) => (
  <section className="mb-10">
    <SectionBand
      accent="up"
      label="Activity"
      sublabel="Recent"
      count={rows.length}
      footnote="Recent on-chain activity — full history pending indexer."
      testid="activity-band"
    />
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr className="border-b border-l-hair">
            <Th>Time</Th><Th>Action</Th><Th>Contract</Th>
            <Th align="right">Qty</Th><Th align="right">Amount</Th><Th align="right">Sig</Th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            <SkeletonRows cols={6} />
          ) : rows.length === 0 ? (
            <tr><td colSpan={6}><EmptyLine>No recent activity.</EmptyLine></td></tr>
          ) : (
            rows.map((r, i) => (
              <tr key={`${r.sig}-${i}`} data-testid="activity-row" className="h-[28px] border-b border-l-hair/50">
                <Td tone="faint">{fmtTime(r.ts)}</Td>
                <Td tone="text">{r.verb}</Td>
                <Td tone="muted">{r.contract}</Td>
                <Td align="right">{r.qty ?? "—"}</Td>
                <Td align="right" tone={signTone(r.amount)}>
                  {r.amount == null ? "—" : `${r.amount > 0 ? "+" : r.amount < 0 ? "−" : ""}${fmtUsd(Math.abs(r.amount))}`}
                </Td>
                <td className="py-[7px] text-right">
                  <a
                    href={getSolscanTxUrl(r.sig, cluster)}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="activity-sig"
                    className="font-mono-plex text-[11px] text-l-muted no-underline transition-colors hover:text-l-text"
                  >
                    {r.sig.slice(0, 6)}…{r.sig.slice(-4)} ↗
                  </a>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  </section>
);

export default ActivitySection;
