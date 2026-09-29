/**
 * A portable dump of everything the dashboard knows (plan section 13).
 *
 * This is deliberately *not* the backup mechanism — copying the SQLite file is
 * (see `src/db/backup.ts`). The dump exists so the history can leave this machine
 * as plain JSON or CSV, which is the difference between "backed up" and "not lost
 * when this app stops working".
 */
import type { DatabaseSync } from "node:sqlite";
import {
  latestHoldings,
  listAccounts,
  listContributions,
  listGoals,
  listImports,
  listMilestones,
  listSnapshots,
  recentSyncRuns,
  netContributions,
} from "../db/repo.ts";
import { getSetting } from "../db/client.ts";
import { toCsv } from "./csv-write.ts";

export const DUMP_VERSION = 2;

export interface Dump {
  app: "sharesies-dashboard";
  dumpVersion: number;
  exportedAt: string;
  /** Row counts, so a truncated dump is obvious at a glance. */
  counts: Record<string, number>;
  goals: unknown[];
  milestones: unknown[];
  /** Every account, including the ones outside the goal scope. */
  accounts: unknown[];
  snapshots: unknown[];
  holdings: unknown[];
  contributions: unknown[];
  imports: unknown[];
  syncRuns: unknown[];
  settings: Record<string, string>;
}

const SETTING_KEYS = [
  "annual_return",
  "monthly_contribution",
  "manual_value_nzd",
  "data_source_mode",
  "stale_after_hours",
];

export function buildDump(db: DatabaseSync): Dump {
  const goals = listGoals(db);
  const snapshots = listSnapshots(db, { scope: "all" });

  const dump: Dump = {
    app: "sharesies-dashboard",
    dumpVersion: DUMP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {},
    goals,
    milestones: goals.flatMap((goal) =>
      listMilestones(db, goal.id).map((milestone) => ({ ...milestone, goalName: goal.name }))
    ),
    accounts: listAccounts(db),
    snapshots,
    // Holdings are only stored for the latest snapshot per account, so this is
    // what exists rather than a full holding history.
    holdings: latestHoldings(db),
    // Every contribution, including the ones attributed to an account outside the
    // goal: a dump is the whole history, not the dashboard's view of it.
    contributions: listContributions(db, { scope: "all" }),
    imports: listImports(db, 200),
    syncRuns: recentSyncRuns(db, 200),
    settings: Object.fromEntries(
      SETTING_KEYS
        .map((key) => [key, getSetting(db, key)] as const)
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  };

  dump.counts = {
    goals: dump.goals.length,
    milestones: dump.milestones.length,
    accounts: dump.accounts.length,
    snapshots: dump.snapshots.length,
    holdings: dump.holdings.length,
    contributions: dump.contributions.length,
    netContributions: netContributions(db),
    // Everything, including what sits outside the goal, so the two can be told apart.
    netContributionsAll: netContributions(db, { scope: "all" }),
  };

  return dump;
}

/** Just the row counts, for the backup card: no need to build a whole dump. */
export function storageCounts(db: DatabaseSync): Dump["counts"] {
  const one = (sql: string): number => {
    const row = db.prepare(sql).get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  };

  return {
    goals: one("SELECT COUNT(*) AS count FROM goals"),
    milestones: one("SELECT COUNT(*) AS count FROM milestones"),
    accounts: one("SELECT COUNT(*) AS count FROM accounts"),
    snapshots: one("SELECT COUNT(*) AS count FROM snapshots"),
    holdings: one("SELECT COUNT(*) AS count FROM holding_snapshots"),
    contributions: one("SELECT COUNT(*) AS count FROM contributions"),
    netContributions: netContributions(db),
    netContributionsAll: netContributions(db, { scope: "all" }),
  };
}

export const SNAPSHOT_COLUMNS = [
  "snapshot_date", "account_id", "account_name", "value_nzd", "currency", "status", "source", "source_refreshed_at",
] as const;

export function snapshotsCsv(db: DatabaseSync): string {
  const snapshots = listSnapshots(db, { scope: "all" });
  return toCsv([...SNAPSHOT_COLUMNS], snapshots.map((snapshot) => [
    snapshot.snapshotDate,
    snapshot.accountId,
    snapshot.accountName,
    snapshot.valueNzd,
    snapshot.currency,
    snapshot.status,
    snapshot.source,
    snapshot.sourceRefreshedAt,
  ]));
}

export const CONTRIBUTION_COLUMNS = [
  "contribution_date", "amount_nzd", "source", "category", "account_id",
  "currency", "amount_original", "fx_rate", "note", "external_ref", "created_at",
] as const;

export function contributionsCsv(db: DatabaseSync): string {
  const contributions = listContributions(db, { scope: "all" });
  return toCsv([...CONTRIBUTION_COLUMNS], contributions.map((contribution) => [
    contribution.contributionDate,
    contribution.amountNzd,
    contribution.source,
    contribution.category ?? "",
    contribution.accountId ?? "",
    contribution.currency,
    contribution.amountOriginal ?? "",
    contribution.fxRate ?? "",
    contribution.note,
    contribution.externalRef ?? "",
    contribution.createdAt,
  ]));
}
