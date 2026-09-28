-- 002_scope_imports_notifications.sql
--
-- Three additions that the plan's Phase 4 needs:
--   1. An accounts registry, so a goal can also count KiwiSaver or other Akahu
--      accounts (plan section 14.1 and Phase 4) without changing the collector's
--      hard-coded filters.
--   2. Import support: dedupe keys for imported contributions, and a record of
--      what each import did.
--   3. Milestone-reached notifications, recorded per channel so a milestone is
--      never announced twice.

-- 1. Accounts registry -------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts (
  account_id      TEXT PRIMARY KEY,
  account_name    TEXT NOT NULL,
  connection_name TEXT,
  account_type    TEXT,
  currency        TEXT NOT NULL DEFAULT 'NZD',
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE', 'INACTIVE')),
  -- Which accounts count toward the goal. Set from the collector's filter when
  -- an account is first seen, then owned by the user via the dashboard.
  in_scope        INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_scope ON accounts (in_scope, connection_name);

-- Backfill from anything already collected, so scoped totals do not lose the
-- history that exists at the moment this migration runs.
INSERT OR IGNORE INTO accounts (
  account_id, account_name, connection_name, account_type, currency, status,
  in_scope, first_seen_at, last_seen_at
)
SELECT
  account_id,
  MAX(account_name),
  MAX(source),
  NULL,
  MAX(currency),
  MAX(status),
  1,
  MIN(snapshot_date),
  MAX(snapshot_date)
FROM snapshots
GROUP BY account_id;

-- 2. Imports -----------------------------------------------------------------

-- The provider's own identifier for an imported row (an Akahu transaction id, or
-- a hash of a CSV row). Unique so re-importing the same file cannot double-count.
ALTER TABLE contributions ADD COLUMN external_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contributions_external_ref
  ON contributions (external_ref)
  WHERE external_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  filename      TEXT,
  imported_at   TEXT NOT NULL,
  rows_seen     INTEGER NOT NULL DEFAULT 0,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  report_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_imports_at ON imports (imported_at DESC);

-- 3. Notifications -----------------------------------------------------------

ALTER TABLE milestones ADD COLUMN notified_at TEXT;

-- One row per (milestone, channel): the UNIQUE constraint is what makes
-- "announce this milestone exactly once per channel" enforceable in SQL.
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER REFERENCES milestones (id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'error', 'skipped')),
  error        TEXT,
  detail       TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (milestone_id, channel)
);
