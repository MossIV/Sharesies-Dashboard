/**
 * Assembles the payload behind GET /api/summary (plan section 8).
 *
 * Kept out of the route so it can be unit-tested and reused by the sync
 * response.
 */
import type { DatabaseSync } from "node:sqlite";
import { todayNz } from "../db/client.ts";
import {
  getActiveGoal,
  latestSnapshots,
  latestSyncRun,
  listMilestones,
  listSnapshots,
  netContributions,
  totalSeries,
} from "../db/repo.ts";
import { computeGoalProgress } from "../domain/goals.ts";
import type { Goal, GoalProgress, Pace } from "../domain/goals.ts";
import { daysBetween } from "../domain/dates.ts";
import { evaluateMilestones, nextMilestone } from "../domain/milestones.ts";
import type { EvaluatedMilestone } from "../domain/milestones.ts";
import { STALE_AFTER_HOURS } from "../collector/collect.ts";
import { getAssumptions } from "./settings.ts";

export interface AccountHealth {
  accountId: string;
  accountName: string;
  valueNzd: number;
  status: "ACTIVE" | "INACTIVE";
  sourceRefreshedAt: string | null;
  ageHours: number | null;
}

export interface SyncHealth {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastSuccessAt: string | null;
  lastSnapshotDate: string | null;
  firstSnapshotDate: string | null;
  daysCollected: number;
  daysSinceLastSnapshot: number | null;
  accounts: AccountHealth[];
  hasInactive: boolean;
  stale: boolean;
  staleReason: string | null;
  /** Shown in the sync-health strip so the UI never implies live data. */
  staleAfterHours: number;
}

export interface SummaryGoal extends Goal {
  currentValue: number;
  progressValue: number;
  progressPct: number;
  remaining: number;
  pace: Pace;
  requiredMonthly: number | null;
  targetPassed: boolean;
}

export interface Summary {
  asOf: string;
  currentValue: number;
  currency: string;
  netContributions: number;
  change7d: number | null;
  change30d: number | null;
  goal: SummaryGoal | null;
  milestones: EvaluatedMilestone[];
  nextMilestone: EvaluatedMilestone | null;
  syncHealth: SyncHealth;
  dataMode: "akahu" | "manual" | "unknown";
}

function ageHours(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(((now.getTime() - parsed) / 3_600_000) * 10) / 10;
}

/** Change in total value over the trailing `days`, or null without enough history. */
export function trailingChange(series: { date: string; value: number }[], today: string, days: number): number | null {
  const latest = series.at(-1);
  if (!latest) return null;
  const cutoff = new Date(Date.parse(`${today}T00:00:00.000Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const baseline = series.find((point) => point.date <= cutoff);
  if (!baseline || baseline.date === latest.date) return null;
  return Math.round((latest.value - baseline.value) * 100) / 100;
}

export function buildSyncHealth(db: DatabaseSync, now: Date, today: string): SyncHealth {
  const latest = latestSnapshots(db);
  const run = latestSyncRun(db);
  const history = listSnapshots(db);

  const accounts: AccountHealth[] = latest.map((snapshot) => ({
    accountId: snapshot.accountId,
    accountName: snapshot.accountName,
    valueNzd: snapshot.valueNzd,
    status: snapshot.status,
    sourceRefreshedAt: snapshot.sourceRefreshedAt,
    ageHours: ageHours(snapshot.sourceRefreshedAt, now),
  }));

  const hasInactive = accounts.some((account) => account.status === "INACTIVE");
  const staleAges = accounts.map((account) => account.ageHours).filter((age): age is number => age !== null);
  const oldestAge = staleAges.length > 0 ? Math.max(...staleAges) : null;
  const lastSnapshotDate = history.at(-1)?.snapshotDate ?? null;
  const daysSince = lastSnapshotDate === null ? null : daysBetween(lastSnapshotDate, today);

  let stale = false;
  let staleReason: string | null = null;

  if (accounts.length === 0) {
    stale = true;
    staleReason = "No snapshots yet. Run the collector to start building history.";
  } else if (hasInactive) {
    stale = true;
    staleReason = "An account is INACTIVE. Reconnect at my.akahu.nz/connections.";
  } else if (oldestAge !== null && oldestAge > STALE_AFTER_HOURS) {
    stale = true;
    staleReason = `Akahu's cached balance is about ${Math.round(oldestAge)} hours old.`;
  } else if (daysSince !== null && daysSince > 1) {
    stale = true;
    staleReason = `The last snapshot is ${daysSince} days old. Check the daily job.`;
  } else if (run?.status === "error") {
    stale = true;
    staleReason = `The last collection failed: ${run.error ?? "unknown error"}`;
  }

  return {
    lastRunAt: run?.startedAt ?? null,
    lastRunStatus: run?.status ?? null,
    lastRunError: run?.error ?? null,
    lastSuccessAt: run?.status === "ok" || run?.status === "partial" ? (run.finishedAt ?? null) : null,
    lastSnapshotDate,
    firstSnapshotDate: history[0]?.snapshotDate ?? null,
    daysCollected: new Set(history.map((snapshot) => snapshot.snapshotDate)).size,
    daysSinceLastSnapshot: daysSince,
    accounts,
    hasInactive,
    stale,
    staleReason,
    staleAfterHours: STALE_AFTER_HOURS,
  };
}

export function buildSummary(
  db: DatabaseSync,
  options: { now?: Date; today?: string } = {},
): Summary {
  const now = options.now ?? new Date();
  const today = options.today ?? todayNz(now);
  const series = totalSeries(db);
  const snapshots = latestSnapshots(db);
  const currentValue = snapshots.reduce((sum, snapshot) => sum + snapshot.valueNzd, 0);
  const contributions = netContributions(db);
  const assumptions = getAssumptions(db);

  const goal = getActiveGoal(db);
  let goalSummary: SummaryGoal | null = null;
  let milestones: EvaluatedMilestone[] = [];

  if (goal) {
    const progress = computeGoalProgress({
      goal,
      currentValue,
      series,
      netContributions: contributions,
      today,
      annualReturn: assumptions.annualReturn,
    });
    // Flatten: the UI reads goal.name, goal.progressPct, goal.pace.
    const { goal: goalMeta, ...rest } = progress;
    goalSummary = { ...goalMeta, ...rest };
    milestones = evaluateMilestones(listMilestones(db, goal.id), series, currentValue);
  }

  const syncHealth = buildSyncHealth(db, now, today);

  return {
    asOf: today,
    currentValue: Math.round(currentValue * 100) / 100,
    currency: snapshots[0]?.currency ?? "NZD",
    netContributions: contributions,
    change7d: trailingChange(series, today, 7),
    change30d: trailingChange(series, today, 30),
    goal: goalSummary,
    milestones,
    nextMilestone: nextMilestone(milestones),
    syncHealth,
    dataMode: snapshots[0]?.source === "akahu" || snapshots[0]?.source === "manual"
      ? snapshots[0].source
      : "unknown",
  };
}
