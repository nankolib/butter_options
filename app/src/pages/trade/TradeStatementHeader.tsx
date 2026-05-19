import type { FC } from "react";
import { useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { inferClusterFromUrl, getClusterDisplayLabel } from "../../utils/env";

type TradeStatementHeaderProps = {
  monthLabel: string;
  timestampLabel: string;
  assets: string[];
  selectedAsset: string;
  onAssetChange: (asset: string) => void;
};

/**
 * Statement header for the Trade page. Right cluster carries the
 * timestamp + asset chips (mono uppercase pills, single-select,
 * crimson-outlined-and-dark-filled when active).
 *
 * Stage Secondary 7.5: cluster label is derived at render time from
 * the active connection RPC URL via inferClusterFromUrl.
 */
export const TradeStatementHeader: FC<TradeStatementHeaderProps> = ({
  monthLabel,
  timestampLabel,
  assets,
  selectedAsset,
  onAssetChange,
}) => {
  const { connection } = useConnection();
  const clusterLabel = useMemo(
    () => getClusterDisplayLabel(inferClusterFromUrl(connection.rpcEndpoint)),
    [connection.rpcEndpoint],
  );
  return (
    <header className="border-b border-rule pb-12 mb-8">
      <div className="flex items-center flex-wrap gap-x-[14px] gap-y-2 font-mono font-medium text-[11.5px] uppercase tracking-[0.22em] text-ink-body mb-8">
        <span className="font-serif italic font-normal text-ink-muted normal-case tracking-normal">§</span>
        <span className="text-ink">
          Trade<em className="font-serif italic text-crimson px-[1px]">·</em>
        </span>
        <span className="text-ink-body">{monthLabel}</span>
        <span className="opacity-30">·</span>
        <span className="text-ink-body">{clusterLabel}</span>
        <span className="opacity-30">·</span>
        <span className="text-ink-body">v0.1.4</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-8">
        <h1 className="m-0 font-fraunces-display font-light text-ink leading-[0.92] tracking-[-0.04em] text-[clamp(48px,10vw,144px)]">
          Trade<span className="italic font-fraunces-display-em text-crimson">.</span>
        </h1>

        <div className="flex flex-wrap items-center gap-5">
          <span className="font-mono font-medium text-[11px] uppercase tracking-[0.2em] text-ink-muted">
            As of {timestampLabel}
          </span>

          {assets.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {assets.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => onAssetChange(a)}
                  aria-pressed={selectedAsset === a}
                  className={`rounded-full border px-[14px] py-[6px] font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                    selectedAsset === a
                      ? "border-crimson bg-ink text-paper"
                      : "border-rule text-ink-muted hover:text-ink hover:border-ink"
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default TradeStatementHeader;
