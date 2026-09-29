/**
 * Typed data access. Everything SQL lives here so routes and the collector stay
 * free of it, and so the pure domain layer never sees a database handle.
 */
import type { DatabaseSync } from "node:sqlite";
import { tx } from "./client.ts";
import type { Goal, ProgressBasis } from "../domain/goals.ts";
import type { Milestone, MilestoneKind, ValuePoint } from "../domain/milestones.ts";

export interface SnapshotRow {
  id: number;
  snapshotDate: string;
  accountId: string;
  accountName: string;
  valueNzd: number;
  currency: string;
  sourceRefreshedAt: string | null;
  status: "ACTIVE" | "INACTIVE";
  source: string;
  createdAt: string;
}

export interface HoldingRow {
  id: number;
  snapshotId: number;
  name: string | null;
  symbol: string | null;
  units: number | null;
  value: number | null;
  rawJson: string | null;
}

export interface ContributionRow {
  id: number;
  contributionDate: string;
  amountNzd: number;
  note: string | null;
  source: "manual" | "csv" | "bank";
  /** The provider's id or a content hash; null for a hand-entered row. */
  externalRef: string | null;
  createdAt: string;
}

export interface SyncRunRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  error: string | null;
  accountsSeen: number;
  snapshotsWritten: number;
  stale: number;
}

type Row = Record<string, unknown>;

const n = (value: unknown): number => Number(value ?? 0);
const s = (value: unknown): string => String(value ?? "");
const sn = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

// ---------------------------------------------------------------- raw fetches

export function insertRawFetch(
  db: DatabaseSync,
  entry: { fetchedAt: string; endpoint: string; accountId?: string | null; payload: unknown },
): void {
  db.prepare(
    "INSERT INTO raw_fetches (fetched_at, endpoint, account_id, payload_json) VALUES (?, ?, ?, ?)",
  ).run(entry.fetchedAt, entry.endpoint, entry.accountId ?? null, JSON.stringify(entry.payload));
}

/** Keep the raw table from growing without bound; it is an insurance policy, not a log. */
export function pruneRawFetches(db: DatabaseSync, keepPerAccount = 60): number {
  const result = db.prepare(
    `DELETE FROM raw_fetches
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(account_id, endpoint) ORDER BY fetched_at DESC) AS rn
          FROM raw_fetches
        ) WHERE rn <= ?
      )`,
  ).run(keepPerAccount);
  return Number(result.changes ?? 0);
}

// ------------------------------------------------------------------ snapshots

export interface SnapshotInput {
  snapshotDate: string;
  accountId: string;
  accountName: string;
  valueNzd: number;
  currency: string;
  sourceRefreshedAt: string | null;
  status: "ACTIVE" | "INACTIVE";
  source: string;
  createdAt: string;
}

/** Insert or overwrite the row for (date, account). Returns the snapshot id. */
export function upsertSnapshot(db: DatabaseSync, input: SnapshotInput): number {
  db.prepare(
    `INSERT INTO snapshots (
       snapshot_date, account_id, account_name, value_nzd, currency,
       source_refreshed_at, status, source, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (snapshot_date, account_id) DO UPDATE SET
       account_name        = excluded.account_name,
       value_nzd           = excluded.value_nzd,
       currency            = excluded.currency,
       source_refreshed_at = excluded.source_refreshed_at,
       status              = excluded.status,
       source              = excluded.source`,
  ).run(
    input.snapshotDate,
    input.accountId,
    input.accountName,
    input.valueNzd,
    input.currency,
    input.sourceRefreshedAt,
    input.status,
    input.source,
    input.createdAt,
  );

  const row = db.prepare("SELECT id FROM snapshots WHERE snapshot_date = ? AND account_id = ?")
    .get(input.snapshotDate, input.accountId) as Row | undefined;
  return n(row?.["id"]);
}

export function replaceHoldings(db: DatabaseSync, snapshotId: number, holdings: unknown[]): void {
  db.prepare("DELETE FROM holding_snapshots WHERE snapshot_id = ?").run(snapshotId);
  const insert = db.prepare(
    "INSERT INTO holding_snapshots (snapshot_id, name, symbol, units, value, raw_json) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const holding of holdings) {
    const entry = (holding ?? {}) as Row;
    insert.run(
      snapshotId,
      sn(entry["name"]),
      sn(entry["symbol"]),
      typeof entry["units"] === "number" ? entry["units"] : null,
      typeof entry["value"] === "number" ? entry["value"] : null,
      JSON.stringify(entry["raw"] ?? entry),
    );
  }
}

export interface SnapshotQuery {
  from?: string | undefined;
  to?: string | undefined;
  accountId?: string | undefined;
  /**
   * "in" (default) counts only accounts inside the goal scope; "all" ignores the
   * scope, which is what the sync-health strip wants, because an excluded
   * account is still worth seeing.
   */
  scope?: "in" | "all";
}

/** Shared WHERE builder: every snapshot query filters on the same rules. */
function snapshotFilter(options: SnapshotQuery, alias = "s"): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.from) {
    clauses.push(`${alias}.snapshot_date >= ?`);
    params.push(options.from);
  }
  if (options.to) {
    clauses.push(`${alias}.snapshot_date <= ?`);
    params.push(options.to);
  }
  if (options.accountId) {
    clauses.push(`${alias}.account_id = ?`);
    params.push(options.accountId);
  }
  if ((options.scope ?? "in") === "in") {
    clauses.push("EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = s.account_id AND a.in_scope = 1)");
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listSnapshots(db: DatabaseSync, options: SnapshotQuery = {}): SnapshotRow[] {
  const { where, params } = snapshotFilter(options);
  const rows = db.prepare(
    `SELECT * FROM snapshots s ${where} ORDER BY snapshot_date ASC, account_id ASC`,
  ).all(...params) as Row[];

  return rows.map((row) => ({
    id: n(row["id"]),
    snapshotDate: s(row["snapshot_date"]),
    accountId: s(row["account_id"]),
    accountName: s(row["account_name"]),
    valueNzd: n(row["value_nzd"]),
    currency: s(row["currency"]),
    sourceRefreshedAt: sn(row["source_refreshed_at"]),
    status: s(row["status"]) === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    source: s(row["source"]),
    createdAt: s(row["created_at"]),
  }));
}

/** One point per date, summed across the accounts in scope: the series the charts plot. */
export function totalSeries(db: DatabaseSync, options: SnapshotQuery = {}): ValuePoint[] {
  const { where, params } = snapshotFilter(options);
  const rows = db.prepare(
    `SELECT s.snapshot_date AS date, ROUND(SUM(s.value_nzd), 2) AS value
       FROM snapshots s ${where}
      GROUP BY s.snapshot_date
      ORDER BY s.snapshot_date ASC`,
  ).all(...params) as Row[];

  return rows.map((row) => ({ date: s(row["date"]), value: n(row["value"]) }));
}

/**
 * The newest date that has a snapshot *in the requested scope*.
 *
 * The scope matters: taking the global maximum would let a snapshot from an
 * excluded account set the date, and then a scoped query for that date returns
 * nothing — so the goal value would read as zero because of an account that is
 * not part of the goal.
 */
export function latestSnapshotDate(db: DatabaseSync, options: { scope?: "in" | "all" } = {}): string | null {
  if ((options.scope ?? "all") === "all") {
    const row = db.prepare("SELECT MAX(snapshot_date) AS d FROM snapshots").get() as Row | undefined;
    return sn(row?.["d"]);
  }

  const row = db.prepare(
    `SELECT MAX(s.snapshot_date) AS d FROM snapshots s
      WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = s.account_id AND a.in_scope = 1)`,
  ).get() as Row | undefined;
  return sn(row?.["d"]);
}

export function latestSnapshots(db: DatabaseSync, options: { scope?: "in" | "all" } = {}): SnapshotRow[] {
  const scope = options.scope ?? "in";
  const latest = latestSnapshotDate(db, { scope });
  if (!latest) return [];
  return listSnapshots(db, { from: latest, to: latest, scope });
}

/**
 * The most recent snapshot for each account, regardless of date. Used by the
 * Accounts card, because an account that has not been collected today (an
 * excluded KiwiSaver account, say) still has a last known value.
 */
export function latestSnapshotPerAccount(db: DatabaseSync): SnapshotRow[] {
  const rows = db.prepare(
    `SELECT * FROM snapshots s
      WHERE s.snapshot_date = (
        SELECT MAX(snapshot_date) FROM snapshots WHERE account_id = s.account_id
      )
      ORDER BY s.account_id`,
  ).all() as Row[];
  return rows.map((row) => ({
    id: n(row["id"]),
    snapshotDate: s(row["snapshot_date"]),
    accountId: s(row["account_id"]),
    accountName: s(row["account_name"]),
    valueNzd: n(row["value_nzd"]),
    currency: s(row["currency"]),
    sourceRefreshedAt: sn(row["source_refreshed_at"]),
    status: s(row["status"]) === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    source: s(row["source"]),
    createdAt: s(row["created_at"]),
  }));
}

export function latestHoldings(db: DatabaseSync): HoldingRow[] {
  const rows = db.prepare(
    `SELECT h.* FROM holding_snapshots h
       JOIN snapshots s ON s.id = h.snapshot_id
      WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM snapshots)
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = s.account_id AND a.in_scope = 1)
      ORDER BY h.value DESC`,
  ).all() as Row[];
  return rows.map((row) => ({
    id: n(row["id"]),
    snapshotId: n(row["snapshot_id"]),
    name: sn(row["name"]),
    symbol: sn(row["symbol"]),
    units: row["units"] === null || row["units"] === undefined ? null : n(row["units"]),
    value: row["value"] === null || row["value"] === undefined ? null : n(row["value"]),
    rawJson: sn(row["raw_json"]),
  }));
}

// ---------------------------------------------------------------------- goals

function toGoal(row: Row): Goal {
  return {
    id: n(row["id"]),
    name: s(row["name"]),
    targetAmountNzd: n(row["target_amount_nzd"]),
    targetDate: sn(row["target_date"]),
    progressBasis: (s(row["progress_basis"]) === "contributions" ? "contributions" : "value") as ProgressBasis,
    isActive: n(row["is_active"]) === 1,
    createdAt: s(row["created_at"]),
    source: (s(row["source"]) === "demo" ? "demo" : "manual") as Goal["source"],
  };
}

export function listGoals(db: DatabaseSync): Goal[] {
  return (db.prepare("SELECT * FROM goals ORDER BY is_active DESC, id ASC").all() as Row[]).map(toGoal);
}

export function getGoal(db: DatabaseSync, id: number): Goal | null {
  const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Row | undefined;
  return row ? toGoal(row) : null;
}

export function getActiveGoal(db: DatabaseSync): Goal | null {
  // Newest first. Activation is meant to be single-valued (createGoal and
  // updateGoal both enforce that), but if a database somehow holds two active
  // goals, the most recently created one is the user's intent; picking the
  // lowest id silently measured an old goal instead.
  const row = db.prepare("SELECT * FROM goals WHERE is_active = 1 ORDER BY id DESC LIMIT 1").get() as
    | Row
    | undefined;
  return row ? toGoal(row) : null;
}

export interface GoalInput {
  name: string;
  targetAmountNzd: number;
  targetDate?: string | null;
  progressBasis?: ProgressBasis;
  isActive?: boolean;
  /** "demo" marks a goal created by the seeder, so `--reset` can remove it. */
  source?: GoalSource;
}

export type GoalSource = "manual" | "demo";

export function createGoal(db: DatabaseSync, input: GoalInput): Goal {
  const isActive = input.isActive !== false;

  const result = tx(db, () => {
    const inserted = db.prepare(
      `INSERT INTO goals (name, target_amount_nzd, target_date, progress_basis, is_active, created_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.name,
      input.targetAmountNzd,
      input.targetDate ?? null,
      input.progressBasis ?? "value",
      isActive ? 1 : 0,
      new Date().toISOString(),
      input.source ?? "manual",
    );

    // The dashboard has one progress bar, so a new active goal replaces the
    // previous one instead of quietly losing to it on id order.
    if (isActive) {
      db.prepare("UPDATE goals SET is_active = 0 WHERE id <> ?").run(Number(inserted.lastInsertRowid));
    }
    return Number(inserted.lastInsertRowid);
  });

  const goal = getGoal(db, result);
  if (!goal) throw new Error("Failed to create goal");
  return goal;
}

export function updateGoal(db: DatabaseSync, id: number, patch: Partial<GoalInput>): Goal | null {
  const current = getGoal(db, id);
  if (!current) return null;

  tx(db, () => {
    db.prepare(
      `UPDATE goals SET name = ?, target_amount_nzd = ?, target_date = ?, progress_basis = ?, is_active = ?
        WHERE id = ?`,
    ).run(
      patch.name ?? current.name,
      patch.targetAmountNzd ?? current.targetAmountNzd,
      patch.targetDate === undefined ? current.targetDate : patch.targetDate,
      patch.progressBasis ?? current.progressBasis,
      (patch.isActive ?? current.isActive) ? 1 : 0,
      id,
    );

    // Reactivating a goal makes it the one the dashboard measures.
    if (patch.isActive === true) {
      db.prepare("UPDATE goals SET is_active = 0 WHERE id <> ?").run(id);
    }
  });

  return getGoal(db, id);
}

export function deleteGoal(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM goals WHERE id = ?").run(id).changes ?? 0) > 0;
}

// ----------------------------------------------------------------- milestones

function toMilestone(row: Row): Milestone {
  return {
    id: n(row["id"]),
    goalId: n(row["goal_id"]),
    label: s(row["label"]),
    amountNzd: n(row["amount_nzd"]),
    kind: (s(row["kind"]) === "percent" ? "percent" : "custom") as MilestoneKind,
    percent: row["percent"] === null || row["percent"] === undefined ? null : n(row["percent"]),
    firstReachedOn: sn(row["first_reached_on"]),
    notes: sn(row["notes"]),
  };
}

export function listMilestones(db: DatabaseSync, goalId: number): Milestone[] {
  const rows = db.prepare("SELECT * FROM milestones WHERE goal_id = ? ORDER BY amount_nzd ASC")
    .all(goalId) as Row[];
  return rows.map(toMilestone);
}

export function getMilestone(db: DatabaseSync, id: number): Milestone | null {
  const row = db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as Row | undefined;
  return row ? toMilestone(row) : null;
}

export interface MilestoneRowInput {
  goalId: number;
  label: string;
  amountNzd: number;
  kind?: MilestoneKind;
  percent?: number | null;
  notes?: string | null;
  firstReachedOn?: string | null;
}

export function createMilestone(db: DatabaseSync, input: MilestoneRowInput): Milestone {
  const result = db.prepare(
    `INSERT INTO milestones (goal_id, label, amount_nzd, kind, percent, first_reached_on, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.goalId,
    input.label,
    input.amountNzd,
    input.kind ?? "custom",
    input.percent ?? null,
    input.firstReachedOn ?? null,
    input.notes ?? null,
  );
  const milestone = getMilestone(db, Number(result.lastInsertRowid));
  if (!milestone) throw new Error("Failed to create milestone");
  return milestone;
}

export function updateMilestone(
  db: DatabaseSync,
  id: number,
  patch: Partial<MilestoneRowInput>,
): Milestone | null {
  const current = getMilestone(db, id);
  if (!current) return null;

  db.prepare(
    `UPDATE milestones SET label = ?, amount_nzd = ?, kind = ?, percent = ?, first_reached_on = ?, notes = ?
      WHERE id = ?`,
  ).run(
    patch.label ?? current.label,
    patch.amountNzd ?? current.amountNzd,
    patch.kind ?? current.kind,
    patch.percent === undefined ? current.percent : patch.percent,
    patch.firstReachedOn === undefined ? current.firstReachedOn : patch.firstReachedOn,
    patch.notes === undefined ? current.notes : patch.notes,
    id,
  );
  return getMilestone(db, id);
}

export function deleteMilestone(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM milestones WHERE id = ?").run(id).changes ?? 0) > 0;
}

/**
 * Stamp `first_reached_on` for any milestone the series has now reached.
 * Only ever sets it once; a later dip must not clear it.
 *
 * "The series" is the same one the dashboard draws: the in-scope accounts summed
 * per day. Comparing each snapshot row on its own — which is what this did — let
 * an account *outside* the goal scope reach a milestone, so a lower milestone was
 * stamped the day an excluded account many times its size was collected while the
 * goal itself read a low single-digit percentage. It also fired the notification,
 * which then consumed the once-per-channel send for a milestone that had not
 * actually been reached.
 */
export function stampReachedMilestones(db: DatabaseSync): number {
  const rows = db.prepare(
    `SELECT m.id, m.amount_nzd,
            (SELECT MIN(d.day) FROM (
                SELECT s.snapshot_date AS day, SUM(s.value_nzd) AS total
                  FROM snapshots s
                 WHERE EXISTS (SELECT 1 FROM accounts a
                                WHERE a.account_id = s.account_id AND a.in_scope = 1)
                 GROUP BY s.snapshot_date
             ) d
             WHERE d.total >= m.amount_nzd) AS reached_on
       FROM milestones m
      WHERE m.first_reached_on IS NULL`,
  ).all() as Row[];

  const update = db.prepare("UPDATE milestones SET first_reached_on = ? WHERE id = ?");
  let stamped = 0;
  for (const row of rows) {
    const reachedOn = sn(row["reached_on"]);
    if (reachedOn) {
      update.run(reachedOn, n(row["id"]));
      stamped += 1;
    }
  }
  return stamped;
}

// --------------------------------------------------------------- contributions

function toContribution(row: Row): ContributionRow {
  return {
    id: n(row["id"]),
    contributionDate: s(row["contribution_date"]),
    amountNzd: n(row["amount_nzd"]),
    note: sn(row["note"]),
    source: s(row["source"]) as ContributionRow["source"],
    externalRef: sn(row["external_ref"]),
    createdAt: s(row["created_at"]),
  };
}

export function listContributions(
  db: DatabaseSync,
  options: { from?: string | undefined; to?: string | undefined } = {},
): ContributionRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.from) {
    clauses.push("contribution_date >= ?");
    params.push(options.from);
  }
  if (options.to) {
    clauses.push("contribution_date <= ?");
    params.push(options.to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM contributions ${where} ORDER BY contribution_date ASC, id ASC`,
  ).all(...params) as Row[];
  return rows.map(toContribution);
}

export function createContribution(
  db: DatabaseSync,
  input: { contributionDate: string; amountNzd: number; note?: string | null; source?: ContributionRow["source"] },
): ContributionRow {
  const result = db.prepare(
    "INSERT INTO contributions (contribution_date, amount_nzd, note, source, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    input.contributionDate,
    input.amountNzd,
    input.note ?? null,
    input.source ?? "manual",
    new Date().toISOString(),
  );
  const row = db.prepare("SELECT * FROM contributions WHERE id = ?").get(Number(result.lastInsertRowid)) as Row;
  return toContribution(row);
}

export function deleteContribution(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM contributions WHERE id = ?").run(id).changes ?? 0) > 0;
}

export function netContributions(
  db: DatabaseSync,
  options: { from?: string | undefined; to?: string | undefined } = {},
): number {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.from) {
    clauses.push("contribution_date >= ?");
    params.push(options.from);
  }
  if (options.to) {
    clauses.push("contribution_date <= ?");
    params.push(options.to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db.prepare(`SELECT COALESCE(SUM(amount_nzd), 0) AS total FROM contributions ${where}`)
    .get(...params) as Row | undefined;
  return Math.round(n(row?.["total"]) * 100) / 100;
}

// ------------------------------------------------------------------ sync runs

export function startSyncRun(db: DatabaseSync): number {
  const result = db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'ok')")
    .run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishSyncRun(
  db: DatabaseSync,
  id: number,
  result: { status: string; error?: string | null; accountsSeen: number; snapshotsWritten: number; stale: boolean },
): void {
  db.prepare(
    `UPDATE sync_runs SET finished_at = ?, status = ?, error = ?, accounts_seen = ?, snapshots_written = ?, stale = ?
      WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    result.status,
    result.error ?? null,
    result.accountsSeen,
    result.snapshotsWritten,
    result.stale ? 1 : 0,
    id,
  );
}

export function latestSyncRun(db: DatabaseSync): SyncRunRow | null {
  const row = db.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT 1").get() as
    | Row
    | undefined;
  if (!row) return null;
  return {
    id: n(row["id"]),
    startedAt: s(row["started_at"]),
    finishedAt: sn(row["finished_at"]),
    status: s(row["status"]),
    error: sn(row["error"]),
    accountsSeen: n(row["accounts_seen"]),
    snapshotsWritten: n(row["snapshots_written"]),
    stale: n(row["stale"]),
  };
}

export function recentSyncRuns(db: DatabaseSync, limit = 10): SyncRunRow[] {
  const rows = db.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC, id DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map((row) => ({
    id: n(row["id"]),
    startedAt: s(row["started_at"]),
    finishedAt: sn(row["finished_at"]),
    status: s(row["status"]),
    error: sn(row["error"]),
    accountsSeen: n(row["accounts_seen"]),
    snapshotsWritten: n(row["snapshots_written"]),
    stale: n(row["stale"]),
  }));
}

// -------------------------------------------------------------------- accounts

export interface AccountRow {
  accountId: string;
  accountName: string;
  connectionName: string | null;
  accountType: string | null;
  currency: string;
  status: "ACTIVE" | "INACTIVE";
  inScope: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

function toAccount(row: Row): AccountRow {
  return {
    accountId: s(row["account_id"]),
    accountName: s(row["account_name"]),
    connectionName: sn(row["connection_name"]),
    accountType: sn(row["account_type"]),
    currency: s(row["currency"]),
    status: s(row["status"]) === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    inScope: n(row["in_scope"]) === 1,
    firstSeenAt: s(row["first_seen_at"]),
    lastSeenAt: s(row["last_seen_at"]),
  };
}

export interface AccountInput {
  accountId: string;
  accountName: string;
  connectionName: string | null;
  accountType: string | null;
  currency: string;
  status: "ACTIVE" | "INACTIVE";
  /** Applied only on first insert; afterwards the user owns this field. */
  defaultInScope: boolean;
}

export function upsertAccount(db: DatabaseSync, input: AccountInput): void {
  // in_scope is deliberately absent from the update list: an account the user
  // excluded must stay excluded across collections.
  db.prepare(
    `INSERT INTO accounts (
       account_id, account_name, connection_name, account_type, currency, status,
       in_scope, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       account_name    = excluded.account_name,
       connection_name = excluded.connection_name,
       account_type    = excluded.account_type,
       currency        = excluded.currency,
       status          = excluded.status,
       last_seen_at    = excluded.last_seen_at`,
  ).run(
    input.accountId,
    input.accountName,
    input.connectionName,
    input.accountType,
    input.currency,
    input.status,
    input.defaultInScope ? 1 : 0,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

export function listAccounts(db: DatabaseSync): AccountRow[] {
  const rows = db.prepare(
    `SELECT * FROM accounts ORDER BY in_scope DESC, connection_name ASC, account_name ASC`,
  ).all() as Row[];
  return rows.map(toAccount);
}

export function getAccount(db: DatabaseSync, accountId: string): AccountRow | null {
  const row = db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId) as Row | undefined;
  return row ? toAccount(row) : null;
}

export function setAccountScope(db: DatabaseSync, accountId: string, inScope: boolean): AccountRow | null {
  const result = db.prepare("UPDATE accounts SET in_scope = ? WHERE account_id = ?")
    .run(inScope ? 1 : 0, accountId);
  if (Number(result.changes ?? 0) === 0) return null;
  return getAccount(db, accountId);
}

/** Account ids currently counted toward the goal. */
export function scopedAccountIds(db: DatabaseSync): string[] {
  return (db.prepare("SELECT account_id FROM accounts WHERE in_scope = 1 ORDER BY account_id").all() as Row[])
    .map((row) => s(row["account_id"]));
}

// --------------------------------------------------------------------- imports

export interface ImportRow {
  id: number;
  kind: string;
  filename: string | null;
  importedAt: string;
  rowsSeen: number;
  rowsImported: number;
  rowsSkipped: number;
  report: unknown;
}

export function recordImport(
  db: DatabaseSync,
  entry: {
    kind: string;
    filename?: string | null;
    rowsSeen: number;
    rowsImported: number;
    rowsSkipped: number;
    report?: unknown;
  },
): number {
  const result = db.prepare(
    `INSERT INTO imports (kind, filename, imported_at, rows_seen, rows_imported, rows_skipped, report_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.kind,
    entry.filename ?? null,
    new Date().toISOString(),
    entry.rowsSeen,
    entry.rowsImported,
    entry.rowsSkipped,
    entry.report === undefined ? null : JSON.stringify(entry.report),
  );
  return Number(result.lastInsertRowid);
}

export function listImports(db: DatabaseSync, limit = 20): ImportRow[] {
  const rows = db.prepare("SELECT * FROM imports ORDER BY imported_at DESC, id DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map((row) => ({
    id: n(row["id"]),
    kind: s(row["kind"]),
    filename: sn(row["filename"]),
    importedAt: s(row["imported_at"]),
    rowsSeen: n(row["rows_seen"]),
    rowsImported: n(row["rows_imported"]),
    rowsSkipped: n(row["rows_skipped"]),
    report: row["report_json"] === null || row["report_json"] === undefined
      ? null
      : JSON.parse(String(row["report_json"])),
  }));
}

export function findContributionByRef(db: DatabaseSync, externalRef: string): ContributionRow | null {
  const row = db.prepare("SELECT * FROM contributions WHERE external_ref = ?").get(externalRef) as Row | undefined;
  return row ? toContribution(row) : null;
}

/**
 * Insert a contribution that carries a provider reference, skipping it when the
 * reference has already been imported. This is what makes re-running an import
 * idempotent (plan section 6).
 */
export function importContribution(
  db: DatabaseSync,
  input: {
    contributionDate: string;
    amountNzd: number;
    note?: string | null;
    source: ContributionRow["source"];
    externalRef: string | null;
  },
): { contribution: ContributionRow | null; skipped: boolean } {
  if (input.externalRef !== null) {
    const existing = findContributionByRef(db, input.externalRef);
    if (existing) return { contribution: existing, skipped: true };
  }

  const result = db.prepare(
    `INSERT INTO contributions (contribution_date, amount_nzd, note, source, created_at, external_ref)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.contributionDate,
    input.amountNzd,
    input.note ?? null,
    input.source,
    new Date().toISOString(),
    input.externalRef,
  );
  const row = db.prepare("SELECT * FROM contributions WHERE id = ?").get(Number(result.lastInsertRowid)) as Row;
  return { contribution: toContribution(row), skipped: false };
}

// --------------------------------------------------------------- notifications

export interface NotificationRow {
  id: number;
  milestoneId: number | null;
  channel: string;
  status: "sent" | "error" | "skipped";
  error: string | null;
  detail: string | null;
  createdAt: string;
}

export function recordNotification(
  db: DatabaseSync,
  entry: { milestoneId: number | null; channel: string; status: NotificationRow["status"]; error?: string | null; detail?: string | null },
): void {
  db.prepare(
    `INSERT INTO notifications (milestone_id, channel, status, error, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (milestone_id, channel) DO UPDATE SET
       status = excluded.status, error = excluded.error, detail = excluded.detail`,
  ).run(
    entry.milestoneId,
    entry.channel,
    entry.status,
    entry.error ?? null,
    entry.detail ?? null,
    new Date().toISOString(),
  );
}

export function listNotifications(db: DatabaseSync, limit = 50): NotificationRow[] {
  const rows = db.prepare("SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map((row) => ({
    id: n(row["id"]),
    milestoneId: row["milestone_id"] === null || row["milestone_id"] === undefined ? null : n(row["milestone_id"]),
    channel: s(row["channel"]),
    status: s(row["status"]) as NotificationRow["status"],
    error: sn(row["error"]),
    detail: sn(row["detail"]),
    createdAt: s(row["created_at"]),
  }));
}

/** Milestones that have been reached but never announced on the given channel. */
export function milestonesAwaitingNotification(
  db: DatabaseSync,
  channel: string,
): { milestone: Milestone; goalName: string; reachedOn: string }[] {
  const rows = db.prepare(
    `SELECT m.*, g.name AS goal_name
       FROM milestones m
       JOIN goals g ON g.id = m.goal_id
      WHERE m.first_reached_on IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM notifications nf
           WHERE nf.milestone_id = m.id AND nf.channel = ? AND nf.status = 'sent'
        )
      ORDER BY m.first_reached_on ASC, m.amount_nzd ASC`,
  ).all(channel) as Row[];

  return rows.map((row) => ({
    milestone: toMilestone(row),
    goalName: s(row["goal_name"]),
    reachedOn: s(row["first_reached_on"]),
  }));
}

export function stampMilestoneNotified(db: DatabaseSync, milestoneId: number): void {
  db.prepare("UPDATE milestones SET notified_at = ? WHERE id = ? AND notified_at IS NULL")
    .run(new Date().toISOString(), milestoneId);
}
