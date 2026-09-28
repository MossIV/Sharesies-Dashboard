-- 001_init.sql — initial schema (plan section 4).
--
-- Conventions
--   * All timestamps are ISO-8601 UTC strings ('YYYY-MM-DDTHH:MM:SS.sssZ').
--   * All dates are calendar dates ('YYYY-MM-DD').
--   * Money is stored in NZD in REAL columns. One user, presentational precision,
--     so floating point is acceptable here; no ledger arithmetic depends on it.
--   * "Raw first, parse second": every fetch lands in raw_fetches before anything
--     is derived from it, so a change in Akahu's response shape is re-parsable.

-- Every fetch, untouched. Insurance against inconsistent `meta` shapes.
CREATE TABLE IF NOT EXISTS raw_fetches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at   TEXT    NOT NULL,
  endpoint     TEXT    NOT NULL,
  account_id   TEXT,
  payload_json TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_fetches_account ON raw_fetches (account_id, fetched_at DESC);

-- Normalized daily point used by charts. One row per account per day.
CREATE TABLE IF NOT EXISTS snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date       TEXT    NOT NULL,
  account_id          TEXT    NOT NULL,
  account_name        TEXT    NOT NULL,
  value_nzd           REAL    NOT NULL,
  currency            TEXT    NOT NULL DEFAULT 'NZD',
  source_refreshed_at TEXT,
  status              TEXT    NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE', 'INACTIVE')),
  source              TEXT    NOT NULL DEFAULT 'akahu',
  created_at          TEXT    NOT NULL,
  UNIQUE (snapshot_date, account_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots (snapshot_date);

-- Only populated if meta.portfolio exposes holdings. Nullable fields on purpose.
CREATE TABLE IF NOT EXISTS holding_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  name        TEXT,
  symbol      TEXT,
  units       REAL,
  value       REAL,
  raw_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_holding_snapshots_snapshot ON holding_snapshots (snapshot_id);

-- Money you put in. Needed for "contributions vs growth" and for projections.
-- source: manual | csv | bank
CREATE TABLE IF NOT EXISTS contributions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contribution_date TEXT NOT NULL,
  amount_nzd        REAL NOT NULL,
  note              TEXT,
  source            TEXT NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual', 'csv', 'bank')),
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contributions_date ON contributions (contribution_date);

CREATE TABLE IF NOT EXISTS goals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  target_amount_nzd REAL NOT NULL CHECK (target_amount_nzd > 0),
  target_date       TEXT,
  -- 'value' (default): progress = portfolio value. 'contributions': progress = net deposits.
  progress_basis    TEXT NOT NULL DEFAULT 'value'
                          CHECK (progress_basis IN ('value', 'contributions')),
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id          INTEGER NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  label            TEXT    NOT NULL,
  amount_nzd       REAL    NOT NULL CHECK (amount_nzd > 0),
  -- custom | percent. Percent milestones also carry their percent so the
  -- amount can be regenerated if the goal target changes.
  kind             TEXT    NOT NULL DEFAULT 'custom'
                           CHECK (kind IN ('custom', 'percent')),
  percent          REAL,
  -- First snapshot date at or above amount_nzd. Kept even if the value later
  -- dips; the UI shows a "currently below" marker instead of un-achieving it.
  first_reached_on TEXT,
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones (goal_id, amount_nzd);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  -- ok | error | rate_limited | partial
  status        TEXT NOT NULL DEFAULT 'ok',
  error         TEXT,
  accounts_seen INTEGER NOT NULL DEFAULT 0,
  snapshots_written INTEGER NOT NULL DEFAULT 0,
  stale         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs (started_at DESC);
