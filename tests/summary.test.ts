import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSyncHealth, buildSummary, trailingChange } from "../src/api/summary.ts";
import { collectOnce } from "../src/collector/collect.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import { createGoal, createMilestone } from "../src/db/repo.ts";
import { loadFixture, testDb } from "./helpers.ts";

const NOW = new Date("2026-09-28T04:00:00.000Z");
const TODAY = "2026-09-28";

test("trailingChange measures from the closest point at or before the cutoff", () => {
  const series = [
    { date: "2026-08-01", value: 1000 },
    { date: "2026-09-20", value: 1200 },
    { date: "2026-09-25", value: 1300 },
    { date: "2026-09-28", value: 1400 },
  ];

  // 7 days back from 28 Sept is 21 Sept, so the closest earlier point is 20 Sept.
  assert.equal(trailingChange(series, TODAY, 7), 200);
  // 30 days back is 29 Aug, and the closest earlier point is 1 Aug.
  assert.equal(trailingChange(series, TODAY, 30), 400);
});

test("trailingChange returns null without a baseline or without a move", () => {
  assert.equal(trailingChange([], TODAY, 7), null);
  assert.equal(trailingChange([{ date: "2026-09-28", value: 1000 }], TODAY, 7), null);
  // History is shorter than the window, so no baseline exists yet.
  assert.equal(trailingChange([{ date: "2026-09-27", value: 900 }, { date: "2026-09-28", value: 1000 }], TODAY, 30), null);
});

test("trailingChange distinguishes the 7 and 30 day windows", () => {
  // A regression guard: an earlier implementation scanned for the first point at
  // or before the cutoff, so every window reported the change since day one.
  const series = Array.from({ length: 60 }, (_, index) => ({
    date: new Date(Date.parse("2026-07-31T00:00:00.000Z") + index * 86_400_000).toISOString().slice(0, 10),
    value: 1000 + index * 10,
  }));

  const week = trailingChange(series, TODAY, 7);
  const month = trailingChange(series, TODAY, 30);
  assert.notEqual(week, month);
  assert.ok(Math.abs(week! - 70) <= 10 && Math.abs(month! - 300) <= 10, `${week} / ${month}`);
});

test("a stale or inactive collection is surfaced in sync health", async () => {
  const db = testDb();
  const raw = loadFixture("accounts.sharesies-regressions.sample.json");
  const source: PortfolioSource = {
    name: "akahu",
    fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
  };

  await collectOnce(db, { source, now: NOW });
  const health = buildSyncHealth(db, NOW, TODAY);

  assert.equal(health.hasInactive, true);
  assert.equal(health.stale, true);
  assert.match(health.staleReason ?? "", /INACTIVE/);
  assert.equal(health.lastRunStatus, "ok");
  assert.equal(health.daysCollected, 1);

  db.close();
});

test("an empty database reports a first-run state rather than a failure", () => {
  const db = testDb();
  const health = buildSyncHealth(db, NOW, TODAY);

  assert.equal(health.stale, true);
  assert.match(health.staleReason ?? "", /No snapshots yet/);
  assert.equal(health.lastRunAt, null);
  assert.deepEqual(health.accounts, []);

  db.close();
});

test("summary carries the goal, milestone states and changes", async () => {
  const db = testDb();
  const raw = loadFixture("accounts.sharesies-portfolio.sample.json");
  const source: PortfolioSource = {
    name: "akahu",
    fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
  };

  await collectOnce(db, { source, now: NOW, snapshotDate: "2026-09-21" });
  await collectOnce(db, { source, now: NOW, snapshotDate: TODAY });

  const goal = createGoal(db, { name: "Deposit", targetAmountNzd: 50000, targetDate: "2028-09-28" });
  createMilestone(db, { goalId: goal.id, label: "First 10k", amountNzd: 10000 });
  createMilestone(db, { goalId: goal.id, label: "Big", amountNzd: 90000 });

  const summary = buildSummary(db, { now: NOW, today: TODAY });

  assert.equal(summary.currentValue, 18844.7);
  assert.equal(summary.goal?.name, "Deposit");
  assert.equal(summary.goal?.progressPct, 37.7);
  assert.equal(summary.milestones.length, 2);
  assert.equal(summary.nextMilestone?.label, "Big");
  // Every snapshot in the fixture is the same value, so nothing moved.
  assert.equal(summary.change7d, 0);

  db.close();
});
