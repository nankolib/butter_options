import type { FC } from "react";

type SectionNumberProps = {
  number: string;
  label: string;
  /**
   * "default" — number renders in ink (cream surfaces).
   * "paper"   — number renders in paper-cream (dark surfaces).
   *
   * Mirrors MetaLabel's tone API. The pilcrow and label inherit text
   * color from their parent, so they adapt automatically; only the
   * number span needs an explicit color rule, and the previous
   * hardcoded text-ink rendered the "03" invisible on bg-ink.
   */
  tone?: "default" | "paper";
  className?: string;
};

/**
 * The "§ 01 · The Market Thesis" mono section marker.
 *
 * Three parts: italic-serif pilcrow, mono numeral with crimson italic
 * interpoint, and a lowered-opacity mono section title. Used at the
 * top of every numbered section on Landing; will be reused on Docs.
 */
export const SectionNumber: FC<SectionNumberProps> = ({
  number,
  label,
  tone = "default",
  className = "",
}) => {
  const numColorClass = tone === "paper" ? "text-paper" : "text-ink";
  return (
    <div
      className={`flex items-center gap-[14px] font-mono font-medium text-[11.5px] uppercase tracking-[0.22em] ${tone === "paper" ? "text-paper/85" : "text-ink-body"} ${className}`.trim()}
    >
      <span className={`font-serif italic font-normal normal-case tracking-normal ${tone === "paper" ? "opacity-65" : "text-ink-muted"}`}>§</span>
      <span className={numColorClass}>
        {number}
        <em className="font-serif italic text-crimson px-[1px]">·</em>
      </span>
      <span className={tone === "paper" ? "opacity-75" : "text-ink-body"}>{label}</span>
    </div>
  );
};

export default SectionNumber;
