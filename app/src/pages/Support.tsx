import type { FC } from "react";
import { Link } from "react-router-dom";
import { usePaperPalette } from "../hooks";
import { PaperGrain } from "../components/layout";
import { AppNav } from "../components/AppNav";

/**
 * Support — static paper-surface help page (dApp Store prerequisite).
 * No scroll reveals: content renders immediately at full opacity.
 */
const Section: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <section className="mb-12">
    <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.2em] text-ink-muted mb-3">
      {label}
    </div>
    <div className="font-sans text-[15.5px] leading-[1.7] text-ink-body space-y-4">{children}</div>
  </section>
);

export const Support: FC = () => {
  usePaperPalette();
  return (
    <div className="relative min-h-screen bg-paper text-ink overflow-x-hidden">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[720px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.2em] text-ink-muted mb-4">
          Help
        </div>
        <h1 className="m-0 mb-6 font-fraunces-display font-light text-ink leading-[0.98] tracking-[-0.025em] text-[clamp(40px,5.6vw,72px)]">
          Support
        </h1>
        <p className="font-fraunces-text italic text-[19px] leading-snug text-ink mb-12">
          Opta is in devnet beta &mdash; expect rapid iteration, and reach us any time.
        </p>

        <Section label="Beta status">
          <p>
            Opta currently runs on Solana <strong className="font-medium text-ink">devnet</strong>.
            Markets, balances, premiums, and settlements use test assets &mdash; nothing here is real
            value. The product is under active development and changes frequently.
          </p>
        </Section>

        <Section label="Documentation">
          <p>
            For how Opta works &mdash; options, vaults, settlement, and the exchange &mdash; read the{" "}
            <Link to="/docs" className="text-ink underline underline-offset-4 decoration-ink-muted hover:decoration-ink">
              documentation
            </Link>
            .
          </p>
        </Section>

        <Section label="Contact">
          <p>
            Questions, issues, or feedback? Reach the team on{" "}
            <a
              href="https://x.com/optafinance"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink underline underline-offset-4 decoration-ink-muted hover:decoration-ink"
            >
              X @optafinance
            </a>
            .
          </p>
        </Section>
      </main>
    </div>
  );
};

export default Support;
