import type { FC } from "react";
import { Link } from "react-router-dom";
import { usePaperPalette } from "../hooks";
import { PaperGrain } from "../components/layout";
import { AppNav } from "../components/AppNav";

/**
 * Privacy — static paper-surface legal page (dApp Store prerequisite).
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

export const Privacy: FC = () => {
  usePaperPalette();
  return (
    <div className="relative min-h-screen bg-paper text-ink overflow-x-hidden">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[720px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.2em] text-ink-muted mb-4">
          Legal
        </div>
        <h1 className="m-0 mb-6 font-fraunces-display font-light text-ink leading-[0.98] tracking-[-0.025em] text-[clamp(40px,5.6vw,72px)]">
          Privacy <em className="italic font-fraunces-display-em">Policy</em>
        </h1>
        <p className="font-fraunces-text italic text-[19px] leading-snug text-ink mb-12">
          Opta is built to need as little of you as possible. It collects no personal data.
        </p>

        <Section label="No accounts, no personal data">
          <p>
            Opta&rsquo;s application and website do not collect personal data. There are no accounts,
            no logins, no emails, and no profiles. You use the product without telling us who you are.
          </p>
        </Section>

        <Section label="Your wallet stays yours">
          <p>
            Wallet connections are handled locally on your own device by your wallet software. Opta
            never receives your private keys or recovery phrase, and never takes custody of your funds.
            Connecting a wallet exposes only its public address, which you choose to share when you sign.
          </p>
        </Section>

        <Section label="On-chain activity is public">
          <p>
            Trading, writing, and settlement happen on the Solana blockchain, which is public by design.
            On-chain transactions are visible to anyone. This is an inherent property of the blockchain
            &mdash; not something Opta collects, controls, or can make private.
          </p>
        </Section>

        <Section label="Analytics">
          <p>
            We use self-hosted, aggregate product analytics to understand how the app is used and to
            improve it. This data is anonymous and aggregate; it contains no personally identifiable
            information. We do not sell or share it.
          </p>
        </Section>

        <Section label="Questions">
          <p>
            For any privacy question, reach us through the{" "}
            <Link to="/support" className="text-ink underline underline-offset-4 decoration-ink-muted hover:decoration-ink">
              Support
            </Link>{" "}
            page.
          </p>
        </Section>

        <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-muted mt-16">
          Last updated July 2026
        </p>
      </main>
    </div>
  );
};

export default Privacy;
