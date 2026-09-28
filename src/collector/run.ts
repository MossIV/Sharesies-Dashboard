/**
 * CLI entry point for the daily job.
 *
 *   npm run collect
 *
 * Schedule it once a day (Task Scheduler on Windows, cron/systemd elsewhere).
 * Akahu refreshes on its own daily schedule, so there is nothing to gain from
 * polling more often, and the personal-app manual refresh has a 1 hour rest
 * period.
 */
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { collectOnce } from "./collect.ts";

async function main(): Promise<void> {
  const db = openDb();
  migrate(db);

  const result = await collectOnce(db);

  if (result.status === "error") {
    console.error(`Collection failed: ${result.error}`);
  } else {
    console.log(
      `Collected ${result.snapshotsWritten} snapshot(s) for ${result.snapshotDate} ` +
        `from ${result.accountsSeen} account(s)` +
        (result.value === null ? "" : `; portfolio ${result.value.toFixed(2)}`),
    );
    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
    if (result.stale) console.warn(`Stale: ${result.staleReason}`);
    if (result.milestonesStamped > 0) {
      console.log(`Milestones reached: ${result.milestonesStamped}`);
    }
    if (result.notifications.sent > 0 || result.notifications.failed > 0) {
      console.log(
        `Announcements: ${result.notifications.sent} sent, ${result.notifications.failed} failed`,
      );
    }
    for (const problem of result.notifications.problems) console.warn(`Notification config: ${problem}`);
  }

  db.close();
  process.exitCode = result.status === "error" ? 1 : 0;
}

await main();
