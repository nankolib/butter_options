import type { FC } from "react";

/**
 * Flat brand marks for the faucet buttons — inlined SVG (no remote assets, CSP-safe).
 * Official-style Solana tri-bar and USDC coin, sized to sit in a 27px control.
 */
export const SolMark: FC<{ size?: number }> = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <g transform="skewX(-16) translate(3 0)">
      <rect x="0" y="4" width="15" height="3.2" rx="1" fill="#9945FF" />
      <rect x="0" y="10.4" width="15" height="3.2" rx="1" fill="#14F195" />
      <rect x="0" y="16.8" width="15" height="3.2" rx="1" fill="#19FB9B" />
    </g>
  </svg>
);

export const UsdcMark: FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="#2775CA" />
    <text
      x="12"
      y="16.6"
      textAnchor="middle"
      fontFamily="IBM Plex Mono, monospace"
      fontSize="13"
      fontWeight="600"
      fill="#fff"
    >
      $
    </text>
  </svg>
);
