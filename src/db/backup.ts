/**
 * Backing up the database (plan section 13).
 *
 * This file is the only copy of the history: Akahu cannot re-serve a past balance,
 * so a lost database is a lost history. The copy is made with SQLite's own
 * `VACUUM INTO`, which produces a consistent snapshot of a database that is
 * currently open by the API server — copying the file with the filesystem would
 * risk catching a half-written page.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { REPO_ROOT, openDb } from "./client.ts";

export const DEFAULT_BACKUP_DIR = join(REPO_ROOT, "backups");
export const DEFAULT_KEEP = 14;

export interface BackupResult {
  path: string;
  bytes: number;
  /** SQLite's own integrity check on the copy. */
  integrity: string;
  /** Snapshots in the copy, so a truncated backup is obvious. */
  snapshots: number;
  /** Backups removed by the retention rule. */
  pruned: string[];
}

function timestamp(date: Date): string {
  // Colons are not legal in a Windows filename.
  return date.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}

export function backupFileName(date: Date, label?: string): string {
  const suffix = label ? `-${label.replace(/[^a-zA-Z0-9-]/g, "")}` : "";
  return `sharesies-${timestamp(date)}${suffix}.db`;
}

/**
 * Copy the live database to `dir` and verify the copy.
 *
 * Verification is the point: an unverified backup is a belief, not a backup.
 */
export function backupDatabase(
  db: DatabaseSync,
  options: { dir?: string; keep?: number; now?: Date; label?: string } = {},
): BackupResult {
  const dir = resolve(options.dir ?? DEFAULT_BACKUP_DIR);
  const keep = options.keep ?? DEFAULT_KEEP;
  const now = options.now ?? new Date();

  mkdirSync(dir, { recursive: true });
  const path = join(dir, backupFileName(now, options.label));

  if (existsSync(path)) unlinkSync(path);

  // Parameters cannot be used for the target path, so it is escaped by doubling
  // single quotes — the only way to break out of a SQLite string literal.
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

  // Verify by opening the copy, not the original.
  const copy = openDb({ path });
  let integrity = "unknown";
  let snapshots = -1;
  try {
    const row = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    integrity = row?.integrity_check ?? "unknown";
    const count = copy.prepare("SELECT COUNT(*) AS count FROM snapshots").get() as { count?: number } | undefined;
    snapshots = Number(count?.count ?? 0);
  } finally {
    copy.close();
  }

  const bytes = statSync(path).size;
  const pruned = pruneBackups(dir, keep);

  return { path, bytes, integrity, snapshots, pruned };
}

/** Keep the newest `keep` backups, delete the rest. Returns what was removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (keep <= 0) return [];

  const files = readdirSync(dir)
    .filter((name) => name.startsWith("sharesies-") && name.endsWith(".db"))
    .sort();

  const excess = files.slice(0, Math.max(0, files.length - keep));
  for (const name of excess) unlinkSync(join(dir, name));
  return excess;
}

export function listBackups(dir = DEFAULT_BACKUP_DIR): { name: string; bytes: number; modified: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("sharesies-") && name.endsWith(".db"))
    .sort()
    .reverse()
    .map((name) => {
      const stats = statSync(join(dir, name));
      return { name, bytes: stats.size, modified: stats.mtime.toISOString() };
    });
}
