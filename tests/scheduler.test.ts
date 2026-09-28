/**
 * Scheduling the daily job, including the two days a year that punish naive
 * arithmetic.
 *
 * New Zealand starts daylight saving on the last Sunday in September and ends it
 * on the first Sunday in April. A daily 07:00 run is therefore 23 hours after the
 * previous one on the first of those, and 25 hours after on the second. Code that
 * adds 24 hours drifts, misses a day once a year and collects twice on another.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TIME_ZONE,
  createWaiter,
  describeInstant,
  hoursUntil,
  nextRunAfter,
  offsetMs,
  partsInZone,
  zonedTimeToInstant,
} from "../src/scheduler/schedule.ts";
import { needsCatchUp, parseArgs, runOncePass } from "../src/scheduler/run.ts";
import { openDb } from "../src/db/client.ts";
import { listSnapshots } from "../src/db/repo.ts";
import { listBackups } from "../src/db/backup.ts";
import { loadFixture, testDb } from "./helpers.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import type { collectOnce } from "../src/collector/collect.ts";

process.env["QUIET"] = "1";

const SLOT = { hour: 7, minute: 0, timeZone: DEFAULT_TIME_ZONE };

describe("next run time", () => {
  test("is today when the time is still ahead", () => {
    // 2026-06-15T00:00Z is 12:00 on 15 June in NZ, so 07:00 today has passed.
    // 2026-06-14T18:00Z is 06:00 on 15 June in NZ, so 07:00 today is next.
    const atSixAm = new Date("2026-06-14T18:00:00.000Z");
    const next = nextRunAfter(atSixAm, SLOT);

    assert.equal(next.toISOString(), "2026-06-14T19:00:00.000Z", "07:00 NZST is 19:00 UTC the day before");
    assert.equal(hoursUntil(next, atSixAm), 1);
  });

  test("is tomorrow once the time has passed", () => {
    // 06:30 and 07:30 on the same NZ day, an hour apart, a day of runs apart.
    const justBefore = new Date("2026-06-14T18:30:00.000Z");
    const justAfter = new Date("2026-06-14T19:30:00.000Z");

    assert.equal(nextRunAfter(justBefore, SLOT).toISOString(), "2026-06-14T19:00:00.000Z");
    assert.equal(nextRunAfter(justAfter, SLOT).toISOString(), "2026-06-15T19:00:00.000Z");
  });

  test("from exactly the run time, it is the next day", () => {
    const now = new Date("2026-06-14T19:00:00.000Z");
    assert.equal(nextRunAfter(now, SLOT).toISOString(), "2026-06-15T19:00:00.000Z");
  });

  test("is 23 hours later across the start of daylight saving", () => {
    // DST starts 02:00 on 2026-09-27: 07:00 is +12 the day before and +13 after.
    const before = new Date("2026-09-25T19:00:00.000Z"); // 07:00 on the 26th, NZST
    const next = nextRunAfter(before, SLOT);

    assert.equal(offsetMs(before), 12 * 3_600_000, "NZST is UTC+12");
    assert.equal(offsetMs(next), 13 * 3_600_000, "NZDT is UTC+13");
    assert.equal(hoursUntil(next, before), 23, "the day the clocks go forward is short");
    assert.equal(partsInZone(next).day, 27);
  });

  test("is 25 hours later across the end of daylight saving", () => {
    // DST ends 03:00 on Sunday 2026-04-05. The run on the 4th is at +13 and the
    // run on the 5th is at +12, so the gap is 25 hours.
    const before = new Date("2026-04-03T18:00:00.000Z"); // 07:00 on the 4th, NZDT
    const next = nextRunAfter(before, SLOT);

    assert.equal(offsetMs(before), 13 * 3_600_000, "NZDT is UTC+13");
    assert.equal(offsetMs(next), 12 * 3_600_000, "NZST is UTC+12");
    assert.equal(next.toISOString(), "2026-04-04T19:00:00.000Z");
    assert.equal(hoursUntil(next, before), 25, "the day the clocks go back is long");
    assert.equal(partsInZone(next).day, 5);
  });

  test("stays at the same wall-clock time for a fortnight either side of a change", () => {
    // The property that matters is the local clock, not the interval: start seven
    // days before the September change and step a run at a time through it.
    let run = new Date("2026-09-20T19:00:00.000Z");
    const seen: string[] = [];

    for (let day = 0; day < 14; day++) {
      const wall = partsInZone(run);
      seen.push(`${wall.day} ${wall.hour}:${String(wall.minute).padStart(2, "0")}`);
      run = nextRunAfter(run, SLOT);
    }

    assert.deepEqual(
      new Set(seen.map((entry) => entry.split(" ")[1])),
      new Set(["7:00"]),
      "every run lands on 07:00 local",
    );
    assert.equal(new Set(seen.map((entry) => entry.split(" ")[0])).size, 14, "one run per calendar day");
  });

  test("a time zone other than New Zealand works too", () => {
    const next = nextRunAfter(new Date("2026-06-14T18:00:00.000Z"), {
      hour: 7,
      minute: 0,
      timeZone: "UTC",
    });
    assert.equal(next.toISOString(), "2026-06-15T07:00:00.000Z");
  });

  test("an odd minute is honoured", () => {
    const next = nextRunAfter(new Date("2026-06-14T18:00:00.000Z"), { ...SLOT, minute: 35 });
    assert.equal(partsInZone(next).minute, 35);
    assert.equal(partsInZone(next).hour, 7);
  });

  test("describes itself in the local clock", () => {
    const next = nextRunAfter(new Date("2026-06-14T18:00:00.000Z"), SLOT);
    assert.equal(describeInstant(next), "07:00 on 15 June 2026 (Pacific/Auckland)");
  });
});

describe("wall clock conversion", () => {
  test("round-trips a normal local time", () => {
    const instant = zonedTimeToInstant({ year: 2026, month: 6, day: 15, hour: 7, minute: 0, second: 0 });
    assert.equal(instant.toISOString(), "2026-06-14T19:00:00.000Z");
  });

  test("handles the hour that does not exist when the clocks go forward", () => {
    // 02:30 on 2026-09-27 never happens in New Zealand.
    const instant = zonedTimeToInstant({ year: 2026, month: 9, day: 27, hour: 2, minute: 30, second: 0 });
    const wall = partsInZone(instant);
    assert.equal(wall.day, 27);
    assert.ok(wall.hour >= 3, `expected 03:00 or later, got ${wall.hour}:${wall.minute}`);
  });

  test("resolves the hour that happens twice to the first occurrence", () => {
    // 02:30 on 2026-04-05 happens twice: at +13 and again at +12.
    const instant = zonedTimeToInstant({ year: 2026, month: 4, day: 5, hour: 2, minute: 30, second: 0 });
    assert.equal(offsetMs(instant), 13 * 3_600_000, "the first occurrence is the NZDT one");
  });
});

describe("arguments", () => {
  test("defaults to 07:00 New Zealand", () => {
    const args = parseArgs([], {});
    assert.equal(args.hour, 7);
    assert.equal(args.minute, 0);
    assert.equal(args.timeZone, "Pacific/Auckland");
    assert.equal(args.once, false);
  });

  test("reads the environment and the flags", () => {
    assert.equal(parseArgs([], { SCHEDULE_HOUR_NZ: "6", SCHEDULE_MINUTE_NZ: "30" }).hour, 6);
    assert.equal(parseArgs(["--hour", "21"], {}).hour, 21);
    assert.equal(parseArgs(["--hour=21"], {}).hour, 21);
    assert.equal(parseArgs(["--minute=5"], {}).minute, 5);
    assert.equal(parseArgs(["--keep=30"], {}).keep, 30);
    assert.equal(parseArgs(["--once"], {}).once, true);
  });

  test("refuses an impossible time rather than scheduling nothing", () => {
    assert.throws(() => parseArgs(["--hour=24"], {}), /0-23/);
    assert.throws(() => parseArgs(["--minute=60"], {}), /0-59/);
    assert.throws(() => parseArgs(["--keep=0"], {}), /positive integer/);
    assert.throws(() => parseArgs(["--nonsense"], {}), /Unknown argument/);
  });
});

describe("the cancellable wait", () => {
  test("a stop request does not have to outlast the sleep", async () => {
    // The bug this covers: the scheduler slept in one long timer, so a SIGTERM
    // only set a flag and the process stayed alive until the timer fired — up to
    // a minute. `docker stop` waited out its grace period and killed the
    // container instead of letting it exit.
    const waiter = createWaiter();
    const started = Date.now();
    const pending = waiter.wait(60_000);

    setTimeout(() => waiter.cancel(), 20);
    await pending;

    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `cancelling should be immediate, took ${elapsed}ms`);
  });

  test("an uncancelled wait still runs to its full time", async () => {
    const waiter = createWaiter();
    const started = Date.now();
    await waiter.wait(60);
    assert.ok(Date.now() - started >= 55);
  });

  test("cancelling with nothing pending is harmless", () => {
    const waiter = createWaiter();
    assert.doesNotThrow(() => waiter.cancel());
  });

  test("cancelling a finished wait does not resolve the next one", async () => {
    const waiter = createWaiter();
    await waiter.wait(10);
    waiter.cancel();

    let finished = false;
    const pending = waiter.wait(80).then(() => {
      finished = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(finished, false, "the second wait must not be cut short by the first cancel");
    await pending;
    assert.equal(finished, true);
  });
});

describe("catch-up", () => {
  const now = new Date("2026-09-29T00:00:00.000Z");

  test("runs when there is no previous run", () => {
    assert.equal(needsCatchUp(null, now), true);
  });

  test("does not run minutes after a run", () => {
    assert.equal(needsCatchUp("2026-09-28T23:00:00.000Z", now), false);
  });

  test("runs when the last run is a day old", () => {
    assert.equal(needsCatchUp("2026-09-28T00:00:00.000Z", now), true);
  });

  test("treats an unparseable timestamp as overdue", () => {
    assert.equal(needsCatchUp("not a date", now), true);
  });
});

describe("a scheduled pass", () => {
  function fakeSource(): PortfolioSource {
    const raw = loadFixture("accounts.sharesies-portfolio.sample.json");
    return {
      name: "akahu",
      fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
    };
  }

  test("collects and then backs up, and says so", async () => {
    const db = testDb();
    const dir = mkdtempSync(join(tmpdir(), "sharesies-pass-"));
    const lines: string[] = [];

    const collect: typeof collectOnce = async (handle, options) => {
      const { collectOnce: real } = await import("../src/collector/collect.ts");
      return real(handle, { ...options, source: fakeSource(), notify: false });
    };

    const result = await runOncePass(db, {
      hour: 7,
      minute: 0,
      timeZone: DEFAULT_TIME_ZONE,
      backupKeep: 3,
      backupDir: dir,
      collect,
      log: (line) => lines.push(line),
    });

    assert.equal(result.ok, true);
    assert.match(result.summary, /3 snapshot\(s\)/, lines.join("\n"));
    assert.ok(lines.some((line) => line.includes("backup:")), lines.join("\n"));
    assert.equal(listSnapshots(db, { scope: "all" }).length, 3, "the pass wrote the snapshots");

    const backups = listBackups(dir);
    assert.equal(backups.length, 1, "the pass left exactly one backup");
    assert.match(backups[0]!.name, /^sharesies-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/);

    // The copy is a real database, not just a file with the right name.
    const copy = openDb({ path: backups[0]!.path });
    const count = copy.prepare("SELECT COUNT(*) AS count FROM snapshots").get() as { count: number };
    assert.equal(count.count, 3);
    copy.close();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failing collection still backs up, and is reported not thrown", async () => {
    const db = testDb();
    const dir = mkdtempSync(join(tmpdir(), "sharesies-fail-"));
    const lines: string[] = [];

    const collect: typeof collectOnce = async () => {
      throw new Error("Akahu is down");
    };

    const result = await runOncePass(db, {
      hour: 7,
      minute: 0,
      timeZone: DEFAULT_TIME_ZONE,
      backupKeep: 3,
      backupDir: dir,
      collect,
      log: (line) => lines.push(line),
    });

    assert.equal(result.ok, false);
    assert.match(lines.join("\n"), /Akahu is down/);
    assert.match(lines.join("\n"), /backup:\s/, "the backup still ran");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});