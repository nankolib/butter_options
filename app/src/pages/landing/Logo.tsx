import type { FC } from "react";

/**
 * Landing logo — italic Fraunces "opta" plus a flat, mode-aware dot.
 *
 * Landing-local (not the shared brand/Wordmark) on purpose: the design
 * lock bans glows, and Wordmark's dark-context dot carries a box-shadow
 * glow. Here the dot is a flat `bg-l-dot` that swaps teal (light) →
 * crimson (dark) purely by the html[data-mode] token flip. Static text,
 * not a link — the landing is already at "/".
 */
export const Logo: FC = () => (
  <span
    aria-label="opta"
    className="inline-flex items-baseline font-serif font-medium italic leading-none text-l-text text-[26px] tracking-[-0.01em] font-fraunces-text normal-case"
  >
    opta
    <span
      aria-hidden="true"
      className="ml-[5px] inline-block h-[7px] w-[7px] rounded-full bg-l-dot transition-colors duration-500 ease-opta"
    />
  </span>
);

export default Logo;
