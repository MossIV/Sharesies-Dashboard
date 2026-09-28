/**
 * Typed data access. Everything SQL lives here so routes and the collector stay
 * free of it, and so the pure domain layer never sees a database handle.
 */
import type { DatabaseSync } from "node:sqlite";
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

export function listSnapshots(
  db: DatabaseSync,
  options: { from?: string | undefined; to?: string | undefined; accountId?: string | undefined } = {},
): SnapshotRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.from) {
    clauses.push("snapshot_date >= ?");
    params.push(options.from);
  }
  if (options.to) {
    clauses.push("snapshot_date <= ?");
    params.push(options.to);
  }
  if (options.accountId) {
    clauses.push("account_id = ?");
    params.push(options.accountId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM snapshots ${where} ORDER BY snapshot_date ASC, account_id ASC`,
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

/** One point per date, summed across accounts: the series the charts plot. */
export function totalSeries(
  db: DatabaseSync,
  options: { from?: string | undefined; to?: string | undefined } = {},
): ValuePoint[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (options.from) {
    clauses.push("snapshot_date >= ?");
    params.push(options.from);
  }
  if (options.to) {
    clauses.push("snapshot_date <= ?");
    params.push(options.to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT snapshot_date AS date, ROUND(SUM(value_nzd), 2) AS value
       FROM snapshots ${where}
      GROUP BY snapshot_date
      ORDER BY snapshot_date ASC`,
  ).all(...params) as Row[];

  return rows.map((row) => ({ date: s(row["date"]), value: n(row["value"]) }));
}

export function latestSnapshotDate(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT MAX(snapshot_date) AS d FROM snapshots").get() as Row | undefined;
  return sn(row?.["d"]);
}

export function latestSnapshots(db: DatabaseSync): SnapshotRow[] {
  const latest = latestSnapshotDate(db);
  if (!latest) return [];
  return listSnapshots(db, { from: latest, to: latest });
}

export function latestHoldings(db: DatabaseSync): HoldingRow[] {
  const rows = db.prepare(
    `SELECT h.* FROM holding_snapshots h
       JOIN snapshots s ON s.id = h.snapshot_id
      WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM snapshots)
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
  const row = db.prepare("SELECT * FROM goals WHERE is_active = 1 ORDER BY id ASC LIMIT 1").get() as
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
}

export function createGoal(db: DatabaseSync, input: GoalInput): Goal {
  const result = db.prepare(
    `INSERT INTO goals (name, target_amount_nzd, target_date, progress_basis, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.name,
    input.targetAmountNzd,
    input.targetDate ?? null,
    input.progressBasis ?? "value",
    input.isActive === false ? 0 : 1,
    new Date().toISOString(),
  );
  const goal = getGoal(db, Number(result.lastInsertRowid));
  if (!goal) throw new Error("Failed to create goal");
  return goal;
}

export function updateGoal(db: DatabaseSync, id: number, patch: Partial<GoalInput>): Goal | null {
  const current = getGoal(db, id);
  if (!current) return null;

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
 */
export function stampReachedMilestones(db: DatabaseSync): number {
  const rows = db.prepare(
    `SELECT m.id, m.amount_nzd, m.first_reached_on,
            (SELECT MIN(snapshot_date) FROM snapshots WHERE value_nzd >= m.amount_nzd) AS reached_on
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
