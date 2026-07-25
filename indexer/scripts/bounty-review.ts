// =============================================================================
// scripts/bounty-review.ts — manual bounty review CLI
// =============================================================================
//
// Review stays a HUMAN step with no HTTP surface. There is deliberately no
// admin endpoint in this phase: an authenticated admin route is a much larger
// attack surface than a root-only CLI, and bounty volume does not justify it.
//
//   node dist/scripts/bounty-review.js list [pending|approved|rejected]
//   node dist/scripts/bounty-review.js approve <id> <points>
//   node dist/scripts/bounty-review.js reject  <id>
//
// Points land in bounty_submissions.points and are picked up by the NEXT
// recompute (hourly, or run scripts/recompute.js to see it immediately).
// =============================================================================

import { loadConfig } from "../src/env";
import { openDb } from "../src/db";

interface Row {
  id: string;
  wallet: string;
  kind: string;
  proof_url: string | null;
  status: string;
  points: number | null;
}

function main(): void {
  const [, , cmd, arg1, arg2] = process.argv;
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);

  if (!cmd || cmd === "list") {
    const status = arg1 ?? "pending";
    const rows = db
      .prepare("SELECT id, wallet, kind, proof_url, status, points FROM bounty_submissions WHERE status = ? ORDER BY id")
      .all(status) as Row[];
    if (rows.length === 0) {
      console.log(`no ${status} submissions`);
    } else {
      for (const r of rows) {
        console.log(`${r.id}  ${r.wallet.slice(0, 8)}…  ${r.kind.padEnd(14)}  pts=${r.points ?? 0}  ${r.proof_url ?? ""}`);
      }
      console.log(`\n${rows.length} ${status}`);
    }
    db.close();
    return;
  }

  if (cmd === "approve" || cmd === "reject") {
    if (!arg1) {
      console.error("usage: bounty-review approve <id> <points> | reject <id>");
      process.exit(1);
    }
    const row = db.prepare("SELECT id, status FROM bounty_submissions WHERE id = ?").get(arg1) as
      | { id: string; status: string }
      | undefined;
    if (!row) {
      console.error(`no submission ${arg1}`);
      process.exit(1);
    }
    if (row.status !== "pending") {
      console.error(`submission ${arg1} is already ${row.status} — refusing to change a decided review`);
      process.exit(1);
    }
    if (cmd === "approve") {
      const pts = Number(arg2);
      if (!Number.isFinite(pts) || pts <= 0) {
        console.error("approve needs a positive points value");
        process.exit(1);
      }
      db.prepare("UPDATE bounty_submissions SET status = 'approved', points = ? WHERE id = ?").run(pts, arg1);
      console.log(`approved ${arg1} for ${pts} points — visible after the next recompute`);
    } else {
      db.prepare("UPDATE bounty_submissions SET status = 'rejected', points = 0 WHERE id = ?").run(arg1);
      console.log(`rejected ${arg1}`);
    }
    db.close();
    return;
  }

  console.error("usage: bounty-review [list <status> | approve <id> <points> | reject <id>]");
  process.exit(1);
}

main();
