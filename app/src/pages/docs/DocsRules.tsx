// =============================================================================
// DocsRules — the public EPOCH 0 scoring rules page, rendered LIVE from the API.
// =============================================================================
//
// ⛔ DO NOT HARDCODE A SINGLE SCORING NUMBER IN THIS FILE.
//
// Every weight, cap, multiplier bound and referral rate is read from
// `/api/points/rules`, which the indexer serves straight out of the FROZEN
// modules (`DEFAULT_RULES`, `multiplier.ts`, `DEFAULT_QUESTS.referral`). The
// quest catalog is read from `/api/points/quests`. That is the whole point of
// the page: it CANNOT drift from the weights wallets are actually scored under,
// because it does not hold a copy of them. If a value moves in a future
// re-freeze this page moves with it on the next request, with no deploy.
//
// The published hashes are shown so any reader can verify the weights against
// the tag independently — that is the difference between "trust us" and "check".
// =============================================================================

import { useEffect, useState, type FC, type ReactNode } from "react";
import { EPOCH0_UI, fetchRules, fetchQuests, type RulesResponse, type QuestsResponse, type QuestCatalogEntry } from "../../utils/epoch0";

/** Quests with no user-facing surface yet — listed, but honestly labelled. */
const COMING_SOON = new Set(["O5", "O5b"]);

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(n));

export const DocsRules: FC = () => {
  const [rules, setRules] = useState<RulesResponse | null>(null);
  const [quests, setQuests] = useState<QuestsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [r, q] = await Promise.all([fetchRules(), fetchQuests()]);
      if (!live) return;
      if (r.ok) setRules(r.data); else setFailed(true);
      if (q.ok) setQuests(q.data); else setFailed(true);
    })();
    return () => { live = false; };
  }, []);

  if (!EPOCH0_UI) {
    return <Prose>The points campaign is not running.</Prose>;
  }

  if (failed && !rules) {
    // Honest-empty rather than a stale copy: showing remembered numbers is the
    // exact failure this page exists to prevent.
    return (
      <Prose>
        Scoring rules are served live from the points API, which is unreachable
        right now. Nothing is shown rather than showing numbers that might be out
        of date. Try again shortly.
      </Prose>
    );
  }

  if (!rules || !quests) return <Prose>Loading the live rules…</Prose>;

  const b = rules.base;
  const m = rules.multiplier;
  const ref = rules.referral;
  const fz = rules.rules_frozen;

  return (
    <div data-testid="docs-rules" className="max-w-[68ch]">
      <H1>Points — how scoring works</H1>
      <Prose>
        Every number on this page is read live from the scoring service, which
        serves them straight out of the frozen weights. This page holds no copy of
        them, so it cannot drift from what your wallet is actually scored under.
      </Prose>

      {/* ---- base rules ---- */}
      <H2>Base points</H2>
      <Prose>
        Earned continuously from what you do on-chain. Base points are subject to
        the daily cap below, and are the only component the streak multiplier
        applies to.
      </Prose>
      <Table
        head={["Action", "Points"]}
        rows={[
          ["Taking (buying) — per USDC of premium", num(b.taker_pts_per_usdc)],
          ["Making (your resting order gets filled) — per USDC", num(b.maker_pts_per_usdc)],
          ["Exercising an option", num(b.exercise_pts)],
          ["Holding a position to settlement", num(b.held_to_settle_pts)],
          ["A trigger you armed actually firing", num(b.trigger_executed_pts)],
          ["Settling an expiry", num(b.settle_expiry_pts)],
        ]}
      />

      <H2>Creating markets</H2>
      <Prose>
        The first market you create pays {num(b.create_market_first_pts)}. Each
        further market pays less on a decay curve, with a floor of{" "}
        {num(b.create_market_floor_pts)} — and a lifetime total of{" "}
        {num(b.create_market_lifetime_cap_pts)} points from market creation. The
        curve is a function of how many markets you have made, so pausing and
        resuming does not reset it.
      </Prose>

      <H2>The daily cap</H2>
      <Prose>
        Base points are capped at {num(b.daily_cap_points)} per UTC day. Anything
        above the cap still counts, at {pct(b.over_cap_multiplier)} of its value —
        so a very large day is never wasted, just heavily damped.
      </Prose>

      {/* ---- multiplier ---- */}
      <H2>Streak multiplier and shields</H2>
      <Prose>
        Each consecutive active UTC day adds {pct(m.step)} to your multiplier, up
        to {m.cap.toFixed(1)}×. It applies to base points and dailies only — never
        to one-time quests, social, bounty or referral points.
      </Prose>
      <Prose>
        Every {m.shield_streak_length} consecutive active days banks one shield,
        up to {m.shield_bank_max} at a time. A shield is spent automatically to
        cover a single missed day so your streak survives it.
      </Prose>

      {/* ---- quests ---- */}
      <H2>Quests</H2>
      <Prose>
        The chain is sequential — each step only counts from an event at or after
        the previous step completed. Standalone bonuses, dailies and weeklies run
        independently of it.
      </Prose>
      <QuestTable title="Chain" rows={quests.chain} />
      {quests.chain_complete_bonus && (
        <QuestTable title="Chain complete" rows={[quests.chain_complete_bonus]} />
      )}
      <QuestTable title="Bonuses" rows={quests.bonuses ?? []} />
      <QuestTable title="Daily" rows={quests.dailies ?? []} />
      <QuestTable title="Weekly" rows={quests.weeklies ?? []} />
      <Note>
        Weekly quests that span several underlyings are easiest to complete on a
        crypto day: the equity and metal feeds only price during their market
        hours, so those markets are quiet outside them.
      </Note>

      {/* ---- referrals ---- */}
      <H2>Referrals</H2>
      <Prose>
        Binding a referral code pays the person who was referred{" "}
        {num(ref.referee_bond_points)} points, once. The referrer then earns{" "}
        {pct(ref.referrer_rate)} of what their referees earn, capped at{" "}
        {pct(ref.referrer_cap_fraction_of_self)} of the referrer's own points — so
        referrals amplify real activity rather than replacing it. A code must be
        bound before the referee's first fill, and internal wallets cannot be
        referrers.
      </Prose>

      {/* ---- boards ---- */}
      <H2>Leaderboards</H2>
      <Prose>There are {rules.boards.length} boards: {rules.boards.join(", ")}.</Prose>
      {rules.profit_board_requires_faucet_provenance && (
        <Note>
          The profit board is restricted to wallets whose capital came from the
          devnet faucet. It is a like-for-like comparison of trading on a level
          starting stack, not a measure of who deposited the most.
        </Note>
      )}
      <Note>
        Wallets we operate — the market maker, the crank, the faucet, the treasury
        taker and our own wallets — are scored for sanity but excluded from every
        board.
      </Note>

      {/* ---- freeze ---- */}
      <H2>Frozen weights</H2>
      <Prose>
        Scoring rules are frozen and version-tagged. The service verifies the
        weights it loads against the published hashes at boot and refuses to start
        if they do not match, so the numbers above cannot be changed quietly.
      </Prose>
      {fz && (
        <Table
          head={["Field", "Value"]}
          rows={[
            ["Tag", fz.tag],
            ["Frozen at", fz.frozen_at],
            ["Rules version", fz.rules_version],
            ["Quests version", fz.quests_version],
            ["rules sha256", fz.rules_sha256],
            ["quests sha256", fz.quests_sha256],
          ]}
          mono
        />
      )}
      <Note>
        <strong>Amendment, {rules.rules_version === "v1.1" ? "v1.1" : rules.rules_version}.</strong>{" "}
        From rules v1.1, W2 (Settle an expiry) credits <code>settle_vault</code> —
        the permissionless settle step a user performs — in addition to{" "}
        <code>settle_expiry</code>. One expiry counts once however many vaults it
        finalises. No wallet's points changed retroactively.
      </Note>
      <Note>
        Scoring is forward-only. A rules change never re-scores history: points
        already awarded stay awarded, and a new rule earns from the moment it
        ships.
      </Note>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Paper-surface primitives — match the surrounding docs register.
// ---------------------------------------------------------------------------

const H1: FC<{ children: ReactNode }> = ({ children }) => (
  <h1 className="m-0 mb-6 font-fraunces-mid text-[30px] font-light leading-tight tracking-[-0.01em] text-ink">
    {children}
  </h1>
);

const H2: FC<{ children: ReactNode }> = ({ children }) => (
  <h2 className="m-0 mb-3 mt-10 font-mono text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-muted">
    {children}
  </h2>
);

const Prose: FC<{ children: ReactNode }> = ({ children }) => (
  <p className="m-0 mb-4 font-sans text-[14.5px] leading-[1.65] text-ink-body">{children}</p>
);

const Note: FC<{ children: ReactNode }> = ({ children }) => (
  <p className="m-0 mb-4 border-l-2 border-rule pl-4 font-sans text-[13.5px] italic leading-[1.6] text-ink-body">
    {children}
  </p>
);

const Table: FC<{ head: string[]; rows: (string | number)[][]; mono?: boolean }> = ({ head, rows, mono }) => (
  <div className="mb-5 overflow-x-auto">
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-rule">
          {head.map((h) => (
            <th key={h} className="whitespace-nowrap py-2 pr-4 text-left font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-muted">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-rule-soft">
            {r.map((c, j) => (
              <td
                key={j}
                className={`py-[7px] pr-4 align-top text-[13px] text-ink ${
                  j === 0 ? "font-sans" : `font-mono tabular-nums ${mono ? "break-all text-[11px]" : ""}`
                }`}
              >
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const QuestTable: FC<{ title: string; rows: QuestCatalogEntry[] }> = ({ title, rows }) => {
  if (!rows.length) return null;
  return (
    <>
      <p className="m-0 mb-2 mt-5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-muted">{title}</p>
      <div className="mb-4 overflow-x-auto">
        <table className="w-full border-collapse">
          <tbody>
            {rows.map((q) => (
              <tr key={q.id} className="border-b border-rule-soft">
                <td className="w-[46px] py-[7px] pr-3 align-top font-mono text-[11px] text-ink-muted">{q.id}</td>
                <td className="py-[7px] pr-3 align-top font-sans text-[13px] text-ink">
                  {q.name}
                  {COMING_SOON.has(q.id) && (
                    <span className="ml-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-muted">
                      coming soon
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap py-[7px] text-right align-top font-mono text-[12px] tabular-nums text-ink">
                  {q.points}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

export default DocsRules;
