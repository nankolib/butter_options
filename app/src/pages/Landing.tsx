import type { CSSProperties, FC, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
// Imports use full subpaths into ./landing/* rather than the directory's
// barrel because Windows' case-insensitive filesystem makes `./landing`
// (the directory) collide with `./Landing.tsx` (this file). With a path
// segment after `landing/`, TS resolves the directory traversal cleanly.
import { Logo } from "./landing/Logo";
import { ModeToggle } from "./landing/ModeToggle";
import { useLandingMode } from "../hooks/useLandingMode";

/**
 * Landing — one-viewport, dual-mode, dot signature (design lock 2026-07-08).
 *
 * Fills a single viewport: logo + mode toggle on top, headline centered,
 * routes + copyright pinned to the bottom hairline. Palette is driven
 * entirely by html[data-mode] (useLandingMode) — every color here is a
 * --color-l-* token that swaps light↔dark from that one attribute.
 *
 * Motion: a single opacity/transform entrance sequence, staggered, capped
 * at ~600ms. No IntersectionObserver / scroll-reveal — everything is
 * above the fold. prefers-reduced-motion is honored globally (index.css)
 * which collapses the transitions so nothing is ever stuck hidden.
 */

/** Bottom route row. Real routes reuse the current LAUNCH-APP target. */
type Route = { label: string; to: string; external?: boolean };
const ROUTES: Route[] = [
  { label: "App", to: "/markets" },
  { label: "Docs", to: "/docs" },
  { label: "X", to: "https://x.com/optafinance", external: true },
];

/** Staggered entrance — index → transition-delay (ms). Sequence ≤ 600ms. */
const stagger = (i: number): CSSProperties => ({ transitionDelay: `${i * 40}ms` });

const RouteLink: FC<{ route: Route }> = ({ route }) => {
  const classes =
    "group/route flex min-h-[52px] items-center justify-between gap-2 border-t border-l-hair " +
    "font-mono-plex text-[12px] font-medium uppercase tracking-[0.18em] text-l-muted " +
    "transition-colors duration-300 ease-opta hover:text-l-text " +
    "sm:min-h-[44px] sm:border-t-0 sm:justify-start";
  const inner: ReactNode = (
    <>
      <span>{route.label}</span>
      <span
        aria-hidden="true"
        className="text-l-dot transition-transform duration-300 ease-opta group-hover/route:-translate-y-[2px] group-hover/route:translate-x-[2px]"
      >
        ↗
      </span>
    </>
  );

  if (route.external) {
    return (
      <a href={route.to} target="_blank" rel="noopener noreferrer" className={classes}>
        {inner}
      </a>
    );
  }
  return (
    <Link to={route.to} className={classes}>
      {inner}
    </Link>
  );
};

export const Landing: FC = () => {
  const { mode, toggle } = useLandingMode();
  const [entered, setEntered] = useState(false);

  // Flip after mount so the entrance transition has an initial → final
  // pair to animate. Under prefers-reduced-motion the global CSS collapses
  // the transition, so this snaps straight to visible.
  useEffect(() => setEntered(true), []);

  const rise = () =>
    `transition-[opacity,transform] duration-[400ms] ease-opta ${
      entered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-[10px]"
    }`;

  return (
    <div className="flex min-h-screen flex-col bg-l-bg px-6 py-7 text-l-text sm:px-12 sm:py-9 lg:px-16">
      {/* Top bar — logo + mode toggle */}
      <header className="flex items-center justify-between">
        <Logo />
        <ModeToggle mode={mode} onToggle={toggle} />
      </header>

      {/* Center — eyebrow + headline */}
      <main className="flex flex-1 flex-col justify-center py-14">
        <p
          className={`mb-8 inline-flex items-center gap-[10px] font-mono-plex text-[11px] font-medium uppercase tracking-[0.24em] text-l-muted ${rise()}`}
          style={stagger(0)}
        >
          <span aria-hidden="true" className="inline-block h-[7px] w-[7px] rounded-full bg-l-dot animate-l-pulse" />
          SOLANA DEVNET · V0.2
        </p>

        {/* Progressive right-indent staircase (design lock frames): each line
            steps further right. em-based so the step scales with the clamped
            headline size across breakpoints. */}
        <h1 className="font-serif text-l-text leading-[0.94] tracking-[-0.02em] text-[clamp(52px,11vw,120px)]">
          <span className={`block font-fraunces-display ${rise()}`} style={stagger(1)}>
            The options
          </span>
          <span
            className={`block italic font-fraunces-display-em pl-[0.5em] sm:pl-[0.6em] ${rise()}`}
            style={stagger(2)}
          >
            primitive
          </span>
          <span
            className={`block font-fraunces-display pl-[1em] sm:pl-[1.2em] ${rise()}`}
            style={stagger(3)}
          >
            for Solana
            <span aria-hidden="true" className="text-l-dot">.</span>
          </span>
        </h1>
      </main>

      {/* Bottom — routes + copyright */}
      <footer className={`${rise()}`} style={stagger(4)}>
        <div className="border-t border-l-hair pt-6 sm:pt-7">
          <nav className="flex flex-col sm:flex-row sm:items-center sm:gap-10" aria-label="Primary">
            {ROUTES.map((route) => (
              <RouteLink key={route.label} route={route} />
            ))}
          </nav>
          <p className="mt-6 font-mono-plex text-[11px] font-medium uppercase tracking-[0.2em] text-l-faint sm:mt-7">
            © 2026 OPTA
          </p>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
