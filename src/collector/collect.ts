/**
 * The collector: fetch, store raw, derive normalized rows (plan section 5).
 *
 * Kept separate from the CLI so the API's POST /api/sync can run exactly the
 * same code path.
 */
import type { DatabaseSync } from "node:sqlite";
import type { PortfolioSource } from "../sources/PortfolioSource.ts";
import { resolveSource } from "../sources/index.ts";
import { selectPortfolioAccounts, totalValue } from "./select-accounts.ts";
import { todayNz } from "../db/client.ts";
import {
  finishSyncRun,
  insertRawFetch,
  replaceHoldings,
  scopedAccountIds,
  stampReachedMilestones,
  startSyncRun,
  upsertAccount,
  upsertSnapshot,
} from "../db/repo.ts";

/** Data older than this is flagged for the sync-health strip. */
export const STALE_AFTER_HOURS = 48;

export interface CollectResult {
  status: "ok" | "error" | "partial";
  snapshotDate: string;
  accountsSeen: number;
  snapshotsWritten: number;
  value: number | null;
  stale: boolean;
  staleReason: string | null;
  milestonesStamped: number;
  syncRunId: number;
  error: string | null;
  warnings: string[];
}

export interface CollectOptions {
  source?: PortfolioSource;
  now?: Date;
  /** Override the snapshot date (tests, or seeding a historical point). */
  snapshotDate?: string;
}

function hoursSince(iso: string, now: Date): number | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (now.getTime() - then) / 3_600_000;
}

/**
 * Run one collection pass. Never throws for upstream failures: the outcome is
 * reported through `status`/`error` and recorded in `sync_runs`, so an
 * unattended daily job leaves a trail instead of a silent crash.
 */
export async function collectOnce(
  db: DatabaseSync,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const snapshotDate = options.snapshotDate ?? todayNz(now);
  const warnings: string[] = [];

  const syncRunId = startSyncRun(db);

  let source: PortfolioSource;
  try {
    source = options.source ?? resolveSource(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishSyncRun(db, syncRunId, { status: "error", error: message, accountsSeen: 0, snapshotsWritten: 0, stale: true });
    return {
      status: "error",
      snapshotDate,
      accountsSeen: 0,
      snapshotsWritten: 0,
      value: null,
      stale: true,
      staleReason: message,
      milestonesStamped: 0,
      syncRunId,
      error: message,
      warnings,
    };
  }

  try {
    const fetchResult = await source.fetchAccounts();

    // 2. Raw first, always, before anything is derived from it.
    insertRawFetch(db, {
      fetchedAt: nowIso,
      endpoint: fetchResult.endpoint,
      accountId: null,
      payload: fetchResult.raw,
    });

    // 3. Register every account seen, then snapshot the ones in scope.
    //
    // The collector's filter decides the *initial* scope of a newly seen
    // account. After that the dashboard owns the choice, which is how KiwiSaver
    // or another Akahu account can be added to the goal without touching a
    // filter (plan section 14.1 and Phase 4).
    const defaultScope = selectPortfolioAccounts(fetchResult.accounts);
    const defaultScopeIds = new Set(defaultScope.map((account) => account.accountId));

    for (const account of fetchResult.accounts) {
      upsertAccount(db, {
        accountId: account.accountId,
        accountName: account.accountName,
        connectionName: account.connectionName,
        accountType: account.accountType,
        currency: account.currency,
        status: account.status,
        defaultInScope: defaultScopeIds.has(account.accountId),
      });
    }

    const scope = new Set(scopedAccountIds(db));
    const scoped = fetchResult.accounts.filter((account) => scope.has(account.accountId));

    if (scoped.length === 0) {
      const seen = fetchResult.accounts
        .map((account) => `${account.connectionName ?? "?"}/${account.accountType ?? "?"}`)
        .join(", ");
      warnings.push(
        `No accounts are inside the goal scope (${fetchResult.accounts.length} seen` +
          (seen ? `: ${seen}` : "") +
          "). Snapshots are still recorded; include one on the Accounts card to count it toward the goal.",
      );
    }

    const totals = totalValue(scoped);
    if (totals.mixedCurrency) {
      warnings.push(
        `Scoped accounts mix currencies (${scoped.map((a) => a.currency).join(", ")}). ` +
          "No FX conversion is applied, so the total is not meaningful.",
      );
    }

    // 4. One snapshot row per account seen, plus holdings when meta exposes them.
    //
    // Every account is snapshotted, not just the ones in scope: the scope only
    // decides what the goal total sums. Collecting the rest costs a few rows and
    // means widening the goal later does not leave a hole in the history, which
    // is the trap the plan warns about for history generally (section 13).
    let snapshotsWritten = 0;
    for (const account of fetchResult.accounts) {
      insertRawFetch(db, {
        fetchedAt: nowIso,
        endpoint: `${fetchResult.endpoint}#${account.accountId}`,
        accountId: account.accountId,
        payload: account.raw,
      });

      const snapshotId = upsertSnapshot(db, {
        snapshotDate,
        accountId: account.accountId,
        accountName: account.accountName,
        valueNzd: account.valueNzd,
        currency: account.currency,
        sourceRefreshedAt: account.sourceRefreshedAt,
        status: account.status,
        source: source.name,
        createdAt: nowIso,
      });
      snapshotsWritten += 1;

      // 5. Holdings if present, quietly skipped if not.
      replaceHoldings(db, snapshotId, account.holdings);
    }

    // 6. Stamp any newly reached milestones.
    const milestonesStamped = stampReachedMilestones(db);

    // 7. Sync health, judged on the accounts that feed the goal.
    const refreshTimes = scoped
      .map((account) => account.sourceRefreshedAt)
      .filter((value): value is string => Boolean(value));
    const oldest = refreshTimes.sort()[0] ?? null;
    const ageHours = oldest ? hoursSince(oldest, now) : null;

    let stale = false;
    let staleReason: string | null = null;

    if (scoped.length === 0) {
      stale = true;
      staleReason = "No accounts are inside the goal scope.";
    } else if (totals.hasInactive) {
      stale = true;
      staleReason = "An account is INACTIVE. Reconnect at my.akahu.nz/connections.";
    } else if (ageHours === null) {
      stale = true;
      staleReason = "No refresh timestamp was returned, so freshness cannot be confirmed.";
    } else if (ageHours > STALE_AFTER_HOURS) {
      stale = true;
      staleReason = `Cached balance is about ${Math.round(ageHours)} hours old.`;
    }

    finishSyncRun(db, syncRunId, {
      status: warnings.length > 0 ? "partial" : "ok",
      error: warnings.length > 0 ? warnings.join(" ") : null,
      accountsSeen: fetchResult.accounts.length,
      snapshotsWritten,
      stale,
    });

    return {
      status: warnings.length > 0 ? "partial" : "ok",
      snapshotDate,
      accountsSeen: fetchResult.accounts.length,
      snapshotsWritten,
      value: scoped.length > 0 ? Math.round(totals.value * 100) / 100 : null,
      stale,
      staleReason,
      milestonesStamped,
      syncRunId,
      error: null,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishSyncRun(db, syncRunId, { status: "error", error: message, accountsSeen: 0, snapshotsWritten: 0, stale: true });
    return {
      status: "error",
      snapshotDate,
      accountsSeen: 0,
      snapshotsWritten: 0,
      value: null,
      stale: true,
      staleReason: message,
      milestonesStamped: 0,
      syncRunId,
      error: message,
      warnings,
    };
  }
}
