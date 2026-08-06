#!/usr/bin/env node
// =============================================================================
// _rpc_burn_report.mjs — RPC credit-burn heartbeat. READ-ONLY.
// =============================================================================
//
// Why this exists: on 2026-08-06 the Helius key ran out of credits and every
// billable RPC method started returning 503. Nothing warned us — the first
// signal was /markets and /trade going dark, ~40 minutes in. Helius exposes no
// balance API we can poll, so we count OUR side instead and alert on OUR budget.
//
// It reads journalctl only. It makes no RPC calls of its own (a monitor that
// burns the resource it is monitoring is a bad monitor), touches no service, and
// changes nothing.
//
//   node _rpc_burn_report.mjs                # last 24h, human table
//   node _rpc_burn_report.mjs --json         # machine-readable
//   OPTA_RPC_DAILY_BUDGET=1000000 node ...   # set the plan budget
//
// CALLS-PER-EVENT is derived from reading each consumer's tick path. Where a
// consumer branches, the cheap branch is assumed and flagged, so the estimate is
// a FLOOR, not a guess dressed as a measurement.
// =============================================================================

import { execFileSync } from 'node:child_process';

const HOURS = Number(process.env.OPTA_BURN_WINDOW_H ?? 24);
const BUDGET = Number(process.env.OPTA_RPC_DAILY_BUDGET ?? 0); // 0 = unknown
const WARN_AT = 0.8;

/**
 * Per-consumer cost model.
 *
 * `match` counts tick events in the journal; `perTick` is how many RPC calls one
 * tick makes, and `gpaPerTick` how many of those are getProgramAccounts — broken
 * out because gPA is by far the most credit-expensive method and a program-wide
 * scan over thousands of accounts is not comparable to a getBalance.
 */
const CONSUMERS = [
  {
    unit: 'opta-trigger',
    match: /"msg":"trigger tick/,
    perTick: 1,
    gpaPerTick: 1,
    note: 'FLOOR. Early-exits after 1 gPA when triggersFound===0 (the current state, every tick). With ANY live trigger it fetches markets + vaults too => 3 gPA/tick.',
  },
  {
    unit: 'opta-taker',
    match: /"ev":"tick/,
    perTick: 2,
    gpaPerTick: 1,
    note: 'book scan per tick.',
  },
  {
    unit: 'opta-crank',
    match: /"subsystem":"sb-oracle"/,
    perTick: 1,
    gpaPerTick: 0,
    note: 'sb-oracle is the dominant crank subsystem by log volume.',
  },
  {
    unit: 'opta-writer',
    match: /"ev":"(tick|bid-pass)/,
    perTick: 2,
    gpaPerTick: 1,
    note: 'board reconcile per pass.',
  },
  {
    unit: 'opta-indexer',
    match: /"msg":"tick"/,
    perTick: 1,
    gpaPerTick: 0,
    note: 'getSignaturesForAddress + one getTransaction per new tx; see txsSeen below. Markets refresh adds a gPA.',
  },
];

function journal(unit, since) {
  try {
    return execFileSync('journalctl', ['-u', unit, '--since', since, '--no-pager', '-o', 'cat'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

const since = `-${HOURS}h`;
const rows = [];
let totalCalls = 0;
let totalGpa = 0;
let errors503 = 0;

for (const c of CONSUMERS) {
  const out = journal(c.unit, since);
  const lines = out.split('\n');
  const ticks = lines.filter((l) => c.match.test(l)).length;
  errors503 += lines.filter((l) => l.includes('-32603') || l.includes('503')).length;

  // The indexer's real call count scales with txsSeen, not with ticks.
  let extra = 0;
  if (c.unit === 'opta-indexer') {
    for (const l of lines) {
      const m = l.match(/"txsSeen":(\d+)/);
      if (m) extra += Number(m[1]);
    }
  }

  const perDay = (n) => Math.round((n / HOURS) * 24);
  const calls = ticks * c.perTick + extra;
  const gpa = ticks * c.gpaPerTick;
  totalCalls += perDay(calls);
  totalGpa += perDay(gpa);
  rows.push({ unit: c.unit, ticks, ticksPerDay: perDay(ticks), callsPerDay: perDay(calls), gpaPerDay: perDay(gpa), note: c.note });
}

rows.sort((a, b) => b.gpaPerDay - a.gpaPerDay || b.callsPerDay - a.callsPerDay);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ windowHours: HOURS, rows, totalCalls, totalGpa, errors503, budget: BUDGET }, null, 2));
} else {
  console.log(`RPC burn, last ${HOURS}h (projected to 24h). READ-ONLY, no RPC calls made.\n`);
  console.log('consumer        ticks/day   calls/day    gPA/day');
  for (const r of rows) {
    console.log(
      `${r.unit.padEnd(15)} ${String(r.ticksPerDay).padStart(9)} ${String(r.callsPerDay).padStart(11)} ${String(r.gpaPerDay).padStart(10)}`,
    );
  }
  console.log(`${''.padEnd(15)} ${''.padStart(9)} ${String(totalCalls).padStart(11)} ${String(totalGpa).padStart(10)}   <= TOTAL`);
  console.log(`\n503/-32603 lines in window: ${errors503}`);
  console.log('\nnotes:');
  for (const r of rows) console.log(`  ${r.unit}: ${r.note}`);

  if (BUDGET > 0) {
    const pct = totalCalls / BUDGET;
    console.log(`\nbudget: ${totalCalls} / ${BUDGET} calls/day (${(pct * 100).toFixed(1)}%)`);
    if (pct >= WARN_AT) {
      console.log(`WARN: at or above ${WARN_AT * 100}% of the daily budget.`);
      process.exitCode = 2;
    }
  } else {
    console.log('\nbudget: NOT SET. Export OPTA_RPC_DAILY_BUDGET=<calls/day> to enable the 80% alert.');
    console.log('Helius publishes no balance API, so this counts OUR side against OUR plan number.');
  }
}
