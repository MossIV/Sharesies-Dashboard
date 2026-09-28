/**
 * Development seeder: fills the database with plausible history so the UI can be
 * built and reviewed before the Akahu tokens exist (Phase 0 spike).
 *
 *   node scripts/seed-demo.ts            # add demo rows
 *   node scripts/seed-demo.ts --reset    # remove every demo row and exit
 *
 * Demo rows are marked source='demo' and the dashboard labels them as such, so
 * they can never be mistaken for Akahu data. The series is deterministic, so a
 * screenshot or a chart shape is reproducible.
 */
import { openDb, todayNz } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  createGoal,
  createMilestone,
  getActiveGoal,
  importContribution,
  upsertAccount,
} from "../src/db/repo.ts";
import { percentMilestones } from "../src/domain/milestones.ts";

const DAYS = 240;
const START_VALUE = 9200;
const ACCOUNT_ID = "demo:sharesies";

/** mulberry32: tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reset(db: ReturnType<typeof openDb>): number {
  const snapshots = db.prepare("DELETE FROM snapshots WHERE source = 'demo'").run();
  // Demo contributions carry a `demo:` reference so this can never delete a real
  // bank or CSV import (those use the provider id or a `csv:` hash). The note
  // match catches rows written before references existed, which would otherwise
  // linger and inflate the contribution total after a reset.
  const contributions = db.prepare(
    "DELETE FROM contributions WHERE external_ref LIKE 'demo:%' OR note = 'Monthly deposit (demo)'",
  ).run();
  const accounts = db.prepare("DELETE FROM accounts WHERE account_id = ?").run(ACCOUNT_ID);
  return Number(snapshots.changes ?? 0) + Number(contributions.changes ?? 0) + Number(accounts.changes ?? 0);
}

function main(): void {
  const db = openDb();
  migrate(db);

  if (process.argv.includes("--reset")) {
    const removed = reset(db);
    console.log(`Removed ${removed} demo row(s).`);
    db.close();
    return;
  }

  reset(db);

  const random = rng(20260928);
  const today = todayNz();
  const nowIso = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO snapshots (
       snapshot_date, account_id, account_name, value_nzd, currency,
       source_refreshed_at, status, source, created_at
     ) VALUES (?, ?, 'Sharesies (demo)', ?, 'NZD', ?, 'ACTIVE', 'demo', ?)`,
  );

  // A drifting upward trend with a monthly deposit, plus a little noise.
  let value = START_VALUE;
  const rows: { date: string; value: number }[] = [];
  for (let offset = DAYS; offset >= 0; offset--) {
    const date = new Date(Date.parse(`${today}T00:00:00.000Z`) - offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    value *= 1 + (0.00035 + (random() - 0.5) * 0.004);
    if (date.endsWith("-01")) value += 400;
    rows.push({ date, value: Math.round(value * 100) / 100 });
  }

  for (const row of rows) {
    insert.run(row.date, ACCOUNT_ID, row.value, nowIso, nowIso);
  }

  // Register the account so the scoped total includes it (the totals join the
  // accounts registry).
  upsertAccount(db, {
    accountId: ACCOUNT_ID,
    accountName: "Sharesies (demo)",
    connectionName: "Sharesies (demo)",
    accountType: "INVESTMENT",
    currency: "NZD",
    status: "ACTIVE",
    defaultInScope: true,
  });

  let goal = getActiveGoal(db);
  if (!goal) {
    goal = createGoal(db, {
      name: "First $100k",
      targetAmountNzd: 100000,
      targetDate: new Date(Date.parse(`${today}T00:00:00.000Z`) + 730 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      progressBasis: "value",
    });
    for (const milestone of percentMilestones(100000)) {
      createMilestone(db, { goalId: goal.id, ...milestone });
    }
    createMilestone(db, { goalId: goal.id, label: "Emergency buffer", amountNzd: 25000, notes: "6 months of costs" });
  }

  // Monthly deposits across the seeded window.
  const existingContributions = db.prepare("SELECT COUNT(*) AS count FROM contributions WHERE external_ref LIKE 'demo:%'")
    .get() as { count: number };
  if (existingContributions.count === 0) {
    for (let monthsAgo = 7; monthsAgo >= 0; monthsAgo--) {
      const date = new Date(Date.parse(`${today}T00:00:00.000Z`) - monthsAgo * 30 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      importContribution(db, {
        contributionDate: date,
        amountNzd: 400,
        note: "Monthly deposit (demo)",
        source: "bank",
        externalRef: `demo:${date}`,
      });
    }
  }

  console.log(
    `Seeded ${rows.length} demo snapshots (${rows[0]?.date} to ${rows.at(-1)?.date}), ` +
      `final value ${rows.at(-1)?.value}. Goal #${goal.id} "${goal.name}".`,
  );
  console.log("Remove it all again with: node scripts/seed-demo.ts --reset");
  db.close();
}

main();