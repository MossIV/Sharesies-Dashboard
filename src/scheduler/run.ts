/**
 * The daily job, unattended (plan section 5 and the Phase 1 "done when").
 *
 *   npm run schedule                     # collect + back up daily at 07:00 NZ
 *   npm run schedule -- --hour 6         # a different time
 *   npm run schedule -- --once           # run now and exit (a smoke test)
 *
 * Why a loop rather than cron: the target is a container on a NAS, and the two
 * things people reach for instead are both awkward there — cron inside a
 * container needs a process manager and stops being obvious, and the NAS's own
 * scheduler usually cannot reach into the container. One command that stays
 * running is the whole mechanism, and it works the same on Windows.
 *
 * What it deliberately does NOT do: backfill missed days. If the machine was off
 * for a week, the week has no snapshots. Writing today's value into seven past
 * dates would be inventing history, and the whole point of this database is that
 * the history is real.
 */
import { openDb, todayNz } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { recentSyncRuns } from "../db/repo.ts";
import { backupDatabase, DEFAULT_BACKUP_DIR } from "../db/backup.ts";
import { collectOnce } from "../collector/collect.ts";
import { DEFAULT_TIME_ZONE, describeInstant, hoursUntil, nextRunAfter } from "./schedule.ts";

/** Wake this often while waiting, so a clock change or a signal is noticed. */
const WAKE_INTERVAL_MS = 60_000;

/** A restart older than this runs once immediately instead of waiting a day. */
const CATCH_UP_AFTER_HOURS = 20;

export interface SchedulerOptions {
  hour: number;
  minute: number;
  timeZone: string;
  /** Keep this many database backups. */
  backupKeep: number;
  backupDir: string;
  /** Injected in tests, so a pass can run without touching Akahu. */
  collect?: typeof collectOnce;
  backup?: typeof backupDatabase;
  log?: (message: string) => void;
}

interface Args {
  hour: number;
  minute: number;
  timeZone: string;
  keep: number;
  dir: string;
  once: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const args: Args = {
    hour: Number(env["SCHEDULE_HOUR_NZ"] ?? "7"),
    minute: Number(env["SCHEDULE_MINUTE_NZ"] ?? "0"),
    timeZone: env["SCHEDULE_TIME_ZONE"]?.trim() || DEFAULT_TIME_ZONE,
    keep: Number(env["BACKUP_KEEP"] ?? "14"),
    dir: env["BACKUP_DIR"]?.trim() || DEFAULT_BACKUP_DIR,
    once: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const next = argv[index + 1];

    if (arg === "--once") args.once = true;
    else if (arg === "--hour" && next) {
      args.hour = Number(next);
      index += 1;
    } else if (arg.startsWith("--hour=")) args.hour = Number(arg.slice("--hour=".length));
    else if (arg === "--minute" && next) {
      args.minute = Number(next);
      index += 1;
    } else if (arg.startsWith("--minute=")) args.minute = Number(arg.slice("--minute=".length));
    else if (arg === "--keep" && next) {
      args.keep = Number(next);
      index += 1;
    } else if (arg.startsWith("--keep=")) args.keep = Number(arg.slice("--keep=".length));
    else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.hour) || args.hour < 0 || args.hour > 23) {
    throw new Error(`--hour must be 0-23, got ${args.hour}`);
  }
  if (!Number.isInteger(args.minute) || args.minute < 0 || args.minute > 59) {
    throw new Error(`--minute must be 0-59, got ${args.minute}`);
  }
  if (!Number.isInteger(args.keep) || args.keep < 1) {
    throw new Error(`--keep must be a positive integer, got ${args.keep}`);
  }

  return args;
}

/**
 * One pass: collect, then back up.
 *
 * The backup runs even when the collection fails, because a failed fetch is
 * exactly when you want yesterday's data safe. A collection failure is reported
 * and does not kill the loop: Akahu being briefly unavailable should cost one
 * day, not the scheduler.
 */
export async function runOncePass(
  db: ReturnType<typeof openDb>,
  options: SchedulerOptions,
): Promise<{ ok: boolean; summary: string }> {
  const log = options.log ?? ((message: string) => console.log(message));
  const collect = options.collect ?? collectOnce;
  const backup = options.backup ?? backupDatabase;

  let ok = true;
  let summary = "";

  try {
    const result = await collect(db, {});
    summary = `${result.snapshotsWritten} snapshot(s) for ${result.snapshotDate}, value ${result.value ?? "unknown"}`;
    if (result.stale) summary += ` (stale: ${result.staleReason})`;
    if (result.error) {
      ok = false;
      summary += ` — error: ${result.error}`;
    }
    log(`  collect: ${summary}`);
  } catch (error) {
    ok = false;
    summary = `collect failed: ${error instanceof Error ? error.message : String(error)}`;
    log(`  ${summary}`);
  }

  try {
    const result = backup(db, { dir: options.backupDir, keep: options.backupKeep });
    log(
      `  backup:  ${result.path} (${result.integrity}` +
        `${result.pruned.length > 0 ? `, removed ${result.pruned.length}` : ""})`,
    );
    if (result.integrity !== "ok") ok = false;
  } catch (error) {
    ok = false;
    log(`  backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ok, summary };
}

/** Whether a run is overdue: no run yet, or the last one is old enough. */
export function needsCatchUp(
  lastRunAt: string | null,
  now: Date,
  thresholdHours = CATCH_UP_AFTER_HOURS,
): boolean {
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= thresholdHours * 3_600_000;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  migrate(db);

  const options: SchedulerOptions = {
    hour: args.hour,
    minute: args.minute,
    timeZone: args.timeZone,
    backupKeep: args.keep,
    backupDir: args.dir,
  };

  const slot = { hour: args.hour, minute: args.minute, timeZone: args.timeZone };
  const clock = `${String(args.hour).padStart(2, "0")}:${String(args.minute).padStart(2, "0")}`;
  console.log(`\nScheduler: collect and back up daily at ${clock} ${args.timeZone}`);

  if (args.once) {
    console.log(`Running one pass now (${todayNz()}).\n`);
    const { ok } = await runOncePass(db, options);
    db.close();
    console.log("");
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const lastRun = recentSyncRuns(db, 1)[0]?.startedAt ?? null;
  if (needsCatchUp(lastRun, new Date())) {
    console.log(lastRun ? `Last run ${lastRun} — catching up now.\n` : "No runs recorded yet — taking the first snapshot now.\n");
    await runOncePass(db, options);
  }

  let stopped = false;
  const stop = (signal: string): void => {
    stopped = true;
    console.log(`\nReceived ${signal}; stopping after the current wait.`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopped) {
    const now = new Date();
    const next = nextRunAfter(now, slot);
    console.log(`\nNext run: ${describeInstant(next, args.timeZone)} (in ${hoursUntil(next, now)} h)`);

    // Sleep in short steps rather than one long timer: a suspend, a clock change
    // or an NTP correction would otherwise delay the run by an unknown amount.
    while (!stopped && Date.now() < next.getTime()) {
      const remaining = next.getTime() - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, WAKE_INTERVAL_MS)));
    }
    if (stopped) break;

    const day = todayNz();
    console.log(`\nRunning the daily pass (${day}).`);
    await runOncePass(db, options);
  }

  db.close();
  console.log("Scheduler stopped.");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`Scheduler failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}