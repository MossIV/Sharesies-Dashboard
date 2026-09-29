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

/**
 * Where backups go.
 *
 * The rule is the same one `resolveDbPath` uses, and it has to be, because there are
 * two callers: the scheduled job reads `BACKUP_DIR`, and the command you run by hand
 * went through the default below. Two rules for one setting meant the daily copy
 * landed on the mounted volume while `docker exec … node scripts/backup.ts` wrote to
 * `/app/backups` inside the container — a backup that reported success, was invisible
 * from the share, and died with the container it was taken in.
 *
 * A blank value means "not set": resolving it would put the copies in the current
 * working directory, which in a container is the app directory itself, and in a CLI
 * run is wherever you happened to be.
 */
export function resolveBackupDir(dir?: string): string {
  return resolve(dir?.trim() || process.env["BACKUP_DIR"]?.trim() || DEFAULT_BACKUP_DIR);
}

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
  const dir = resolveBackupDir(options.dir);
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
  // -1 means "could not be counted", which is what an unmigrated source looks
  // like. The integrity check is the authoritative signal; the count is a
  // convenience, and failing the whole backup over it would report a readable
  // copy as broken.
  let snapshots = -1;
  try {
    const row = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    integrity = row?.integrity_check ?? "unknown";
    try {
      const count = copy.prepare("SELECT COUNT(*) AS count FROM snapshots").get() as { count?: number } | undefined;
      snapshots = Number(count?.count ?? 0);
    } catch {
      // No schema to count: leave the -1 above and let the caller decide.
    }
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

export interface BackupFile {
  name: string;
  /** Absolute path, so a caller never has to rebuild it from the directory. */
  path: string;
  bytes: number;
  modified: string;
}

export function listBackups(dir = DEFAULT_BACKUP_DIR): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("sharesies-") && name.endsWith(".db"))
    .sort()
    .reverse()
    .map((name) => {
      const stats = statSync(join(dir, name));
      return { name, path: join(dir, name), bytes: stats.size, modified: stats.mtime.toISOString() };
    });
}
