import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Every entry point in this repo ends with `if (import.meta.main) main()`, and
 * `import.meta.main` was only added in Node 24.2. On 24.0 or 24.1 it is
 * `undefined`, so a script would import its modules, run nothing and exit 0 —
 * `npm run collect` reporting success while collecting nothing. client.ts is
 * imported by every entry point, so the check lives here and fails loudly.
 */
if (typeof import.meta.main !== "boolean") {
  throw new Error(
    `This project needs Node 24.2 or newer (found ${process.version}): ` +
      "import.meta.main is unavailable, and every command would silently do nothing.",
  );
}

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

export const DEFAULT_DB_PATH = "data/sharesies.db";

/**
 * Resolve a DB path relative to the repo root, so scripts work from any cwd.
 *
 * A blank value counts as unset. The example `.env` ships `DB_PATH=` with nothing
 * after it, and `resolve(REPO_ROOT, "")` is the repo root — SQLite would then try
 * to open a directory as a database file rather than falling back to the default.
 */
export function resolveDbPath(path?: string): string {
  const raw = path?.trim() || process.env["DB_PATH"]?.trim() || DEFAULT_DB_PATH;
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

export interface OpenDbOptions {
  /** File path, or ":memory:" for tests. */
  path?: string;
  /** Set false in tests for speed. */
  wal?: boolean;
}

/**
 * Open (creating if needed) the SQLite database.
 *
 * Uses node:sqlite rather than better-sqlite3: it is built into Node 24+, so
 * there is no native module to compile on Windows.
 */
export function openDb(options: OpenDbOptions = {}): DatabaseSync {
  const path = options.path ?? resolveDbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (options.wal !== false && path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  return db;
}

/** Run `fn` inside a transaction, rolling back on any thrown error. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the interesting one.
    }
    throw error;
  }
}

export function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Today's calendar date in Pacific/Auckland — the day the user experiences. */
export function todayNz(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
