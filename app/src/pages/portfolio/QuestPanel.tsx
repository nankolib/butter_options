// =============================================================================
// QuestPanel — campaign section for PortfolioTerminalPage. Flag-gated.
// =============================================================================
// Placement (approved): below the summary band, above open positions.
//
// A trading league, not a game — brief §8. Terse verb-first labels, no
// celebration, no illustrations. Numbers mono/tabular/right-aligned (§4).
// Signed actions follow §6: idle -> confirm in wallet -> pending -> result.
//
// Thin by design: every string and state derivation lives in the unit-tested
// utils/epoch0Format.ts + utils/epoch0Sign.ts.
// =============================================================================

import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import {
  EPOCH0_UI,
  fetchWallet,
  postBountySubmit,
  postReferralBind,
  postReferralCode,
  postSocialSubmit,
  type WalletResponse,
} from "../../utils/epoch0";
import {
  CHAIN_STEPS,
  UNAVAILABLE_LINE,
  chainStates,
  multiplier as fmtMultiplier,
  points as fmtPoints,
  usd,
  type StepState,
} from "../../utils/epoch0Format";
import { buildEnvelope, writeErrorCopy, type Epoch0Action, type SignState } from "../../utils/epoch0Sign";
import { resumeTour } from "../../components/tour/TourOverlay";

export const QuestPanel: FC = () => {
  const { publicKey, connected, signMessage } = useWallet();
  const [data, setData] = useState<WalletResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    if (!publicKey) return;
    const res = await fetchWallet(publicKey.toBase58());
    if (res.ok) {
      setData(res.data);
      setFailed(false);
    } else {
      setData(null);
      setFailed(res.reason !== "unconfigured" ? true : true);
    }
  }, [publicKey]);

  useEffect(() => {
    if (!EPOCH0_UI || !connected) return;
    void reload();
  }, [EPOCH0_UI, connected, reload]);

  if (!EPOCH0_UI) return null;

  return (
    <Section title="Campaign">
      {/* data-tour wraps the REAL panel body: an empty marker div measures 0x0
          and the overlay treats a zero-size anchor as unresolved, which would
          silently downgrade this step to a centred card. */}
      <div data-tour="quest-panel">
      {!connected && <Muted>Connect a wallet to see your rank.</Muted>}
      {connected && failed && <Muted>{UNAVAILABLE_LINE}</Muted>}
      {connected && !failed && !data && <SkeletonBlock />}
      {connected && data && (
        <div className="flex flex-col gap-5">
          <Totals data={data} />
          <Chain stage={data.chain_stage} />
          <Referral data={data} onDone={reload} sign={signMessage} wallet={publicKey?.toBase58() ?? ""} />
          <Social onDone={reload} sign={signMessage} wallet={publicKey?.toBase58() ?? ""} handle={data.x_handle} />
          <Bounty sign={signMessage} wallet={publicKey?.toBase58() ?? ""} />
        </div>
      )}
      {connected && (
        <button
          type="button"
          onClick={resumeTour}
          data-testid="tour-resume"
          className="mt-4 font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-faint underline-offset-4 transition-colors hover:text-l-muted hover:underline"
        >
          resume walkthrough
        </button>
      )}
      </div>
    </Section>
  );
};

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const Totals: FC<{ data: WalletResponse }> = ({ data }) => {
  // THE number, straight from the engine. Reassembling it here dropped the
  // multiplier on base, bounty points, and all referral income.
  const total = data.points?.total ?? 0;
  const s = data.streak;
  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
      <Stat label="Points" value={fmtPoints(total)} />
      <Stat label="Multiplier" value={fmtMultiplier(data.multiplier)} />
      <Stat label="Streak" value={s ? `${s.current} ${s.current === 1 ? "day" : "days"}` : "0 days"} />
      <Stat label="Shields" value={String(s?.shields_banked ?? 0)} />
      {data.provenance && <Stat label="Faucet in" value={usd(data.provenance.faucet_in)} />}
    </div>
  );
};

const Chain: FC<{ stage: number }> = ({ stage }) => {
  const states = chainStates(stage);
  return (
    <div>
      <Label>Onboarding</Label>
      <ol className="mt-2 flex flex-col gap-0 border-t border-l-hair">
        {CHAIN_STEPS.map((step, i) => (
          <li
            key={step.id}
            className={`flex h-[30px] items-center gap-3 border-b border-l-hair px-1 ${
              states[i] === "next" ? "border-l-2 border-l-up pl-2" : ""
            }`}
          >
            <span className="w-[24px] font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-muted">{step.id}</span>
            <span className={`text-[12.5px] ${stepTextClass(states[i])}`}>{step.label}</span>
            <span className="ml-auto font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-muted">
              {states[i] === "done" ? "Done" : states[i] === "next" ? "Next" : ""}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
};

// §3: --text-3 (l-faint) is permitted here — locked steps are de-emphasised
// CONTENT, not labels.
const stepTextClass = (s: StepState) =>
  s === "done" ? "text-l-text" : s === "next" ? "text-l-text" : "text-l-faint";

const Referral: FC<{
  data: WalletResponse;
  wallet: string;
  onDone: () => void;
  sign?: (m: Uint8Array) => Promise<Uint8Array>;
}> = ({ data, wallet, onDone, sign }) => {
  const [code, setCode] = useState(data.referral?.my_code ?? null);
  const [copied, setCopied] = useState(false);
  const [bindCode, setBindCode] = useState("");
  const act = useSignedAction(wallet, sign);

  const generate = () =>
    act.run("referral.code", {}, async (env) => {
      const res = await postReferralCode(env);
      if (res.ok) setCode(res.data.code);
      return res;
    });

  const bind = () =>
    act.run("referral.bind", { code: bindCode.trim().toUpperCase() }, async (env) => {
      const res = await postReferralBind(env);
      if (res.ok) onDone();
      return res;
    });

  return (
    <div>
      <Label>Referral</Label>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {code ? (
          <>
            <span className="rounded-[4px] border border-l-hair px-[9px] py-[4px] font-mono-plex text-[12px] tracking-[0.1em] text-l-text">
              {code}
            </span>
            <Ghost
              onClick={() => {
                void navigator.clipboard?.writeText(code).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Ghost>
          </>
        ) : (
          <Ghost onClick={generate} disabled={act.busy}>
            Get your code
          </Ghost>
        )}
        <span className="font-mono-plex text-[11px] tabular-nums text-l-muted">
          Referees {data.referral?.referee_count ?? 0}
        </span>
      </div>

      {!data.referral?.referred_by && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={bindCode}
            onChange={(e) => setBindCode(e.target.value)}
            placeholder="Enter a code"
            maxLength={6}
            className="w-[130px] rounded-[6px] border border-l-hair bg-transparent px-[9px] py-[5px] font-mono-plex text-[12px] uppercase tracking-[0.1em] text-l-text outline-none focus:border-l-muted"
          />
          <Ghost onClick={bind} disabled={act.busy || bindCode.trim().length === 0}>
            Bind
          </Ghost>
          <span className="font-mono-plex text-[10.5px] text-l-muted">Bind before your first fill.</span>
        </div>
      )}
      <ActionNote state={act.state} error={act.error} />
    </div>
  );
};

const Social: FC<{
  wallet: string;
  handle: string | null;
  onDone: () => void;
  sign?: (m: Uint8Array) => Promise<Uint8Array>;
}> = ({ wallet, handle, onDone, sign }) => {
  const [url, setUrl] = useState("");
  const act = useSignedAction(wallet, sign);
  const submit = () =>
    act.run("social.submit", { tweet_url: url.trim() }, async (env) => {
      const res = await postSocialSubmit(env);
      if (res.ok) {
        setUrl("");
        onDone();
      }
      return res;
    });

  return (
    <div>
      <Label>Social</Label>
      <p className="mt-1 font-mono-plex text-[10.5px] text-l-muted">Paste a post that mentions @optafinance.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://x.com/…/status/…"
          className="w-full max-w-[320px] rounded-[6px] border border-l-hair bg-transparent px-[9px] py-[5px] font-mono-plex text-[11.5px] text-l-text outline-none focus:border-l-muted"
        />
        <Ghost onClick={submit} disabled={act.busy || url.trim().length === 0}>
          Submit
        </Ghost>
        {handle && <span className="font-mono-plex text-[10.5px] text-l-muted">@{handle}</span>}
      </div>
      <ActionNote state={act.state} error={act.error} />
    </div>
  );
};

const BOUNTY_KINDS = ["bug", "content", "integration", "other"] as const;

const Bounty: FC<{ wallet: string; sign?: (m: Uint8Array) => Promise<Uint8Array> }> = ({ wallet, sign }) => {
  const [kind, setKind] = useState<string>(BOUNTY_KINDS[0]);
  const [proof, setProof] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const act = useSignedAction(wallet, sign);
  const submit = () =>
    act.run("bounty.submit", { kind, proof_url: proof.trim() }, async (env) => {
      const res = await postBountySubmit(env);
      if (res.ok) {
        setProof("");
        setSubmitted(true);
      }
      return res;
    });

  return (
    <div>
      <Label>Bounty</Label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-[6px] border border-l-hair bg-transparent px-[8px] py-[5px] font-mono-plex text-[11.5px] text-l-text outline-none focus:border-l-muted"
        >
          {BOUNTY_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          value={proof}
          onChange={(e) => setProof(e.target.value)}
          placeholder="https://…"
          className="w-full max-w-[280px] rounded-[6px] border border-l-hair bg-transparent px-[9px] py-[5px] font-mono-plex text-[11.5px] text-l-text outline-none focus:border-l-muted"
        />
        <Ghost onClick={submit} disabled={act.busy || proof.trim().length === 0}>
          Submit
        </Ghost>
        {submitted && <span className="font-mono-plex text-[10.5px] text-l-muted">Pending review</span>}
      </div>
      <ActionNote state={act.state} error={act.error} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Signed-action state machine (brief §6)
// ---------------------------------------------------------------------------

function useSignedAction(wallet: string, sign?: (m: Uint8Array) => Promise<Uint8Array>) {
  const [state, setState] = useState<SignState>("idle");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (
      action: Epoch0Action,
      params: Record<string, unknown>,
      send: (env: unknown) => Promise<{ ok: boolean; data?: unknown; status?: number }>,
    ) => {
      if (!sign || !wallet) {
        setState("error");
        setError("Connect a wallet.");
        return;
      }
      setError(null);
      setState("confirm");
      let env;
      try {
        env = await buildEnvelope({ action, wallet, params, nowUnix: Math.floor(Date.now() / 1000), sign });
      } catch {
        setState("error");
        setError("Signature declined.");
        return;
      }
      setState("pending");
      const res = await send(env);
      if (res.ok) {
        setState("success");
        return;
      }
      const body = (res as { data?: { error?: string } }).data;
      setState("error");
      setError(writeErrorCopy(body?.error, res.status));
    },
    [sign, wallet],
  );

  return { state, error, busy: state === "confirm" || state === "pending", run };
}

const ActionNote: FC<{ state: SignState; error: string | null }> = ({ state, error }) => {
  if (state === "confirm") return <Note>Confirm in wallet</Note>;
  if (state === "pending") return <Note>Submitting</Note>;
  if (state === "error" && error) return <Note>{error}</Note>;
  return null;
};

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <section className="rounded-[10px] border border-l-hair p-4">
    <h2 className="font-mono-plex text-[10px] uppercase tracking-[0.16em] text-l-muted">{title}</h2>
    <div className="mt-3">{children}</div>
  </section>
);

const Label: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="font-mono-plex text-[10px] uppercase tracking-[0.16em] text-l-muted">{children}</span>
);

const Muted: FC<{ children: ReactNode }> = ({ children }) => (
  <p className="font-mono-plex text-[11px] text-l-muted">{children}</p>
);

const Note: FC<{ children: ReactNode }> = ({ children }) => (
  <p className="mt-2 font-mono-plex text-[10.5px] text-l-muted">{children}</p>
);

const Stat: FC<{ label: string; value: string }> = ({ label, value }) => (
  <span className="flex flex-col gap-[2px]">
    <span className="font-mono-plex text-[10px] uppercase tracking-[0.16em] text-l-muted">{label}</span>
    <span className="font-mono-plex text-[14px] tabular-nums text-l-text">{value}</span>
  </span>
);

const Ghost: FC<{ children: ReactNode; onClick: () => void; disabled?: boolean }> = ({ children, onClick, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="rounded-[6px] border border-l-muted px-[11px] py-[5px] font-sans text-[12px] font-medium text-l-text transition-colors duration-150 hover:border-l-text disabled:opacity-40"
  >
    {children}
  </button>
);

const SkeletonBlock: FC = () => (
  <div aria-hidden="true" className="flex flex-col gap-2">
    {Array.from({ length: 4 }, (_, i) => (
      <span key={i} className="h-[10px] w-full max-w-[280px] rounded-[2px] bg-l-surface" />
    ))}
  </div>
);

export default QuestPanel;
