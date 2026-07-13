import type { FC } from "react";
import { Link } from "react-router-dom";
import { usePaperPalette } from "../hooks";
import { PaperGrain } from "../components/layout";
import { AppNav } from "../components/AppNav";

/**
 * Terms — static paper-surface legal page (dApp Store prerequisite).
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

export const Terms: FC = () => {
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
          Terms of <em className="italic font-fraunces-display-em">Use</em>
        </h1>
        <p className="font-fraunces-text italic text-[19px] leading-snug text-ink mb-12">
          Opta is devnet beta. By using it, you accept the terms below.
        </p>

        <Section label="Beta software, provided as is">
          <p>
            Opta is early beta software running on Solana <strong className="font-medium text-ink">devnet</strong>.
            It is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of any kind. It
            may contain bugs, change, or become unavailable at any time.
          </p>
        </Section>

        <Section label="Protocol software, not a service">
          <p>
            Opta is permissionless protocol software. It is <strong className="font-medium text-ink">not</strong> a
            broker, exchange operator, custodian, or financial advisor, and it does not intermediate your
            transactions. Nothing in the app or these terms is investment, financial, legal, or tax advice.
          </p>
        </Section>

        <Section label="Your wallet, your responsibility">
          <p>
            You are solely responsible for your wallet, your keys, and every transaction you sign. Opta never
            takes custody of your funds and cannot act, recover, or reverse anything on your behalf.
          </p>
        </Section>

        <Section label="On-chain actions are irreversible">
          <p>
            Transactions submitted to the blockchain are final and cannot be undone. Review every action before
            you sign it.
          </p>
        </Section>

        <Section label="Test tokens only">
          <p>
            This release uses <strong className="font-medium text-ink">devnet test tokens</strong> with no monetary
            value. It does not involve real funds.
          </p>
        </Section>

        <Section label="Changes">
          <p>
            The app and these terms may be updated as the software evolves. Continued use after an update means you
            accept the revised terms. Questions? See the{" "}
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

export default Terms;
