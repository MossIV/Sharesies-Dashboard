/**
 * The goal scope has to hold everywhere, not just on the headline number.
 *
 * Both bugs here were found on real data: the dashboard showed 1.2% progress and
 * a $250 current value, while the milestone timeline showed "50% of goal
 * reached" and two milestone alerts had already gone to a phone. The cause was
 * the same in both cases — a query that looked at every snapshot row on disk
 * instead of the accounts inside the goal — and both are the kind that look
 * plausible on screen, which is why they are pinned here rather than trusted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createGoal,
  createMilestone,
  latestSnapshotDate,
  latestSnapshotPerAccount,
  latestSnapshots,
  listMilestones,
  stampReachedMilestones,
  totalSeries,
  upsertAccount,
  upsertSnapshot,
} from "../src/db/repo.ts";
import { testDb } from "./helpers.ts";

process.env["QUIET"] = "1";

const IN_GOAL = "acc:in-goal";
const EXCLUDED = "acc:excluded";

/** Two accounts: a small one inside the goal and a large one outside it. */
function dbWithTwoAccounts() {
  const db = testDb();
  for (const [accountId, accountName, inScope] of [
    [IN_GOAL, "Tracked portfolio", true],
    [EXCLUDED, "Larger portfolio", false],
  ] as const) {
    upsertAccount(db, {
      accountId,
      accountName,
      connectionName: "Sharesies",
      accountType: "INVESTMENT",
      currency: "NZD",
      status: "ACTIVE",
      defaultInScope: inScope,
    });
    // upsertAccount only sets the default for a *new* account; the scope is the
    // user's to change, so set it explicitly here.
    db.prepare("UPDATE accounts SET in_scope = ? WHERE account_id = ?").run(inScope ? 1 : 0, accountId);
  }
  return db;
}

function snapshot(db: ReturnType<typeof testDb>, accountId: string, date: string, value: number): void {
  upsertSnapshot(db, {
    snapshotDate: date,
    accountId,
    accountName: accountId,
    valueNzd: value,
    currency: "NZD",
    sourceRefreshedAt: `${date}T00:00:00.000Z`,
    status: "ACTIVE",
    source: "akahu",
    createdAt: `${date}T00:00:00.000Z`,
  });
}

describe("milestones are measured on the goal's own series", () => {
  test("an account outside the goal cannot reach a milestone", () => {
    const db = dbWithTwoAccounts();
    const goal = createGoal(db, { name: "Tracked portfolio", targetAmountNzd: 20_000 });
    createMilestone(db, { goalId: goal.id, label: "25% of goal", amountNzd: 5_000 });

    // The small account is inside the goal; the large one is not.
    snapshot(db, IN_GOAL, "2026-09-29", 250);
    snapshot(db, EXCLUDED, "2026-09-29", 9_500);

    assert.equal(stampReachedMilestones(db), 0, "5,000 is not reached by 250");
    assert.equal(listMilestones(db, goal.id)[0]?.firstReachedOn, null);

    db.close();
  });

  test("a milestone is stamped on the day the in-scope total crosses it", () => {
    const db = dbWithTwoAccounts();
    const goal = createGoal(db, { name: "Tracked portfolio", targetAmountNzd: 20_000 });
    createMilestone(db, { goalId: goal.id, label: "25% of goal", amountNzd: 5_000 });

    snapshot(db, IN_GOAL, "2026-09-01", 4_000);
    snapshot(db, IN_GOAL, "2026-09-02", 4_499.99);
    snapshot(db, IN_GOAL, "2026-09-03", 5_000);
    snapshot(db, IN_GOAL, "2026-09-04", 4_900);
    snapshot(db, EXCLUDED, "2026-09-01", 500_000);

    assert.equal(stampReachedMilestones(db), 1);
    assert.equal(listMilestones(db, goal.id)[0]?.firstReachedOn, "2026-09-03", "the first day at or above");

    db.close();
  });

  test("the sum is per day across the in-scope accounts, not per row", () => {
    const db = dbWithTwoAccounts();
    const wallet = "acc:wallet";
    upsertAccount(db, {
      accountId: wallet,
      accountName: "Sharesies wallet",
      connectionName: "Sharesies",
      accountType: "WALLET",
      currency: "NZD",
      status: "ACTIVE",
      defaultInScope: true,
    });

    const goal = createGoal(db, { name: "Combined", targetAmountNzd: 1_000 });
    createMilestone(db, { goalId: goal.id, label: "100%", amountNzd: 600 });

    // Neither account reaches 600 alone on the 2nd, but together they do.
    snapshot(db, IN_GOAL, "2026-09-01", 200);
    snapshot(db, IN_GOAL, "2026-09-02", 400);
    snapshot(db, wallet, "2026-09-02", 250);

    assert.equal(stampReachedMilestones(db), 1);
    assert.equal(listMilestones(db, goal.id)[0]?.firstReachedOn, "2026-09-02");

    db.close();
  });

  test("a stamped milestone survives a later dip", () => {
    const db = dbWithTwoAccounts();
    const goal = createGoal(db, { name: "Tracked portfolio", targetAmountNzd: 20_000 });
    createMilestone(db, { goalId: goal.id, label: "25% of goal", amountNzd: 5_000 });

    snapshot(db, IN_GOAL, "2026-09-01", 5_100);
    assert.equal(stampReachedMilestones(db), 1);
    assert.equal(listMilestones(db, goal.id)[0]?.firstReachedOn, "2026-09-01");

    // The value falls away; the date stays, and nothing is stamped twice.
    snapshot(db, IN_GOAL, "2026-09-02", 100);
    assert.equal(stampReachedMilestones(db), 0);
    assert.equal(listMilestones(db, goal.id)[0]?.firstReachedOn, "2026-09-01");

    db.close();
  });

  test("no in-scope snapshots means nothing is stamped", () => {
    const db = dbWithTwoAccounts();
    const goal = createGoal(db, { name: "Tracked portfolio", targetAmountNzd: 20_000 });
    createMilestone(db, { goalId: goal.id, label: "25% of goal", amountNzd: 5_000 });

    // Only the excluded account has been collected.
    snapshot(db, EXCLUDED, "2026-09-29", 9_500);

    assert.equal(stampReachedMilestones(db), 0);
    assert.equal(listMilestones(db, goal.id)[0]?.firstReachedOn, null);

    db.close();
  });
});

describe("the latest value comes from the goal's accounts", () => {
  test("an excluded account collected more recently cannot blank the goal value", () => {
    const db = dbWithTwoAccounts();

    snapshot(db, IN_GOAL, "2026-09-28", 250);
    // The excluded account was collected a day later — a Sharesies fetch that
    // failed, say. Taking the global maximum date would look for in-scope rows on
    // the 29th, find none, and report a goal value of zero.
    snapshot(db, EXCLUDED, "2026-09-29", 9_500);

    assert.equal(latestSnapshotDate(db, { scope: "all" }), "2026-09-29", "sync health wants the newest overall");
    assert.equal(latestSnapshotDate(db, { scope: "in" }), "2026-09-28");

    const scoped = latestSnapshots(db, { scope: "in" });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.valueNzd, 250);

    db.close();
  });

  test("the strip that lists every account is per account, not per date", () => {
    const db = dbWithTwoAccounts();
    snapshot(db, IN_GOAL, "2026-09-28", 250);
    snapshot(db, EXCLUDED, "2026-09-29", 9_500);

    // `latestSnapshots` means "the newest date, in scope", so even with scope
    // "all" it returns only the account collected on the 29th — the other one
    // would disappear from a strip whose whole job is to show it.
    assert.equal(latestSnapshots(db, { scope: "all" }).length, 1);
    assert.equal(latestSnapshotPerAccount(db).length, 2, "one row per account, whatever the date");

    db.close();
  });

  test("the series the chart draws is the in-scope total per day", () => {
    const db = dbWithTwoAccounts();
    snapshot(db, IN_GOAL, "2026-09-01", 100);
    snapshot(db, EXCLUDED, "2026-09-01", 13_000);
    snapshot(db, IN_GOAL, "2026-09-02", 200);

    const series = totalSeries(db);
    assert.deepEqual(series, [
      { date: "2026-09-01", value: 100 },
      { date: "2026-09-02", value: 200 },
    ]);

    db.close();
  });
});