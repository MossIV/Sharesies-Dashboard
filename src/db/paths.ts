/**
 * What the app will actually read and write, and whether those places survive the
 * container.
 *
 * This exists because the startup banner used to repeat the environment variable:
 * it printed `backups: ${BACKUP_DIR:-/backups}`, so a container with no BACKUP_DIR
 * reported "backups: /backups" while the app wrote to `/app/backups` — inside the
 * container, on the one filesystem a rebuild throws away. The same mistake was
 * fixed for the database earlier, by asking the app for the resolved path instead
 * of echoing a variable, and the backups line was left behind.
 *
 * The extra guard is the check that a path is a real mount. A banner that names the
 * right path is only useful if the path is the mounted one; where the app can tell
 * the difference, it says so at startup rather than at the moment the backup is
 * needed and missing.
 *
 * Pure apart from `statSync`, and the device lookup is injectable so the rule can
 * be tested without a container.
 */
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDbPath } from "./client.ts";
import { resolveBackupDir } from "./backup.ts";

/** The filesystem device a path lives on, or null when it cannot be determined. */
export type DeviceOf = (path: string) => number | null;

/**
 * The directory to judge a path by: the path itself when it is one, otherwise the
 * folder that holds it.
 *
 * This matters for the database, which is a file that may not exist yet — checking
 * `/data/sharesies.db` directly finds nothing and says nothing, where checking `/data`
 * answers the question actually being asked.
 */
function containingDirectory(path: string): string {
  try {
    return statSync(path).isDirectory() ? path : dirname(path);
  } catch {
    return dirname(path);
  }
}

/**
 * Device numbers mean "same filesystem" on Linux, which is where containers run.
 * Everywhere else this returns null, and a null check stays quiet: a warning that
 * cannot be trusted is worse than no warning.
 */
export const deviceOfPath: DeviceOf = (path) => {
  if (process.platform !== "linux") return null;
  try {
    return statSync(containingDirectory(path)).dev;
  } catch {
    return null;
  }
};

/**
 * Whether `path` is on a different filesystem from `/`.
 *
 * `true` means it is a mount (a volume, a bind mount, a second disk). `false` means
 * it is inside the container's own writable layer, so it dies with the container.
 * `null` means unknown — the path may not exist yet, or this is not Linux.
 */
export function isSeparateFilesystem(path: string, deviceOf: DeviceOf = deviceOfPath): boolean | null {
  const here = deviceOf(path);
  const root = deviceOf("/");
  if (here === null || root === null) return null;
  return here !== root;
}

export interface StoragePaths {
  dbPath: string;
  backupDir: string;
}

export interface DescribeStorageOptions {
  dbPath?: string;
  backupDir?: string;
  deviceOf?: DeviceOf;
}

/**
 * The startup block: the paths the app resolved, plus a warning for any of them
 * that is not on a mounted volume.
 */
export function describeStorage(options: DescribeStorageOptions = {}): string[] {
  const dbPath = options.dbPath ?? resolveDbPath();
  const backupDir = options.backupDir ?? resolveBackupDir();
  const deviceOf = options.deviceOf ?? deviceOfPath;

  const lines = [`  database: ${dbPath}`, `  backups:  ${backupDir}`];

  for (const [label, path] of [["database", dbPath], ["backups", backupDir]] as const) {
    if (isSeparateFilesystem(path, deviceOf) === false) {
      lines.push(`  WARNING: the ${label} path is on the container's own filesystem, not a mounted volume:`);
      lines.push(`           ${path}`);
      lines.push("           It will be lost when the container is recreated. Check the volumes and the");
      lines.push("           DB_PATH / BACKUP_DIR values in the compose file.");
    }
  }

  return lines;
}
