/**
 * Back up the database.
 *
 *   npm run backup
 *   npm run backup -- --dir D:/backups --keep 30
 *   npm run backup -- --list
 *
 * Schedule this alongside the daily collection. The database holds the only copy
 * of the history: Akahu cannot re-serve a past balance, so losing it loses the
 * past.
 */
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { DEFAULT_BACKUP_DIR, backupDatabase, listBackups } from "../src/db/backup.ts";

interface Args {
  dir: string;
  keep: number;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: DEFAULT_BACKUP_DIR, keep: 14, list: false };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const next = argv[index + 1];

    if (arg === "--list") args.list = true;
    else if (arg === "--dir" && next) {
      args.dir = next;
      index += 1;
    } else if (arg.startsWith("--dir=")) args.dir = arg.slice("--dir=".length);
    else if (arg === "--keep" && next) {
      args.keep = Number(next);
      index += 1;
    } else if (arg.startsWith("--keep=")) args.keep = Number(arg.slice("--keep=".length));
    else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.keep) || args.keep < 1) {
    throw new Error("--keep must be a positive integer");
  }
  return args;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const backups = listBackups(args.dir);
    console.log(`\n${args.dir} — ${backups.length} backup(s)`);
    for (const backup of backups) {
      console.log(`  ${backup.name}  ${formatBytes(backup.bytes).padStart(10)}  ${backup.modified.slice(0, 16)}`);
    }
    console.log();
    return;
  }

  const db = openDb();
  // A backup of an unmigrated database is still worth having, but the copy is
  // taken after migrating so it always matches the code that will read it.
  migrate(db);

  const result = backupDatabase(db, { dir: args.dir, keep: args.keep });
  db.close();

  console.log(`\nBacked up to ${result.path}`);
  console.log(`  ${formatBytes(result.bytes)} · ${result.snapshots} snapshot(s) · integrity: ${result.integrity}`);

  if (result.integrity !== "ok") {
    console.error("\n  The copy did not pass its integrity check. Treat it as unusable.");
    process.exitCode = 1;
    return;
  }

  if (result.pruned.length > 0) {
    console.log(`  Removed ${result.pruned.length} old backup(s), keeping ${args.keep}.`);
  }
  console.log();
}

try {
  main();
} catch (error) {
  console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
