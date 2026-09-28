import { test } from "node:test";
import assert from "node:assert/strict";
import {
  etaForTarget,
  monthsToTarget,
  projectMonths,
  projectScenarios,
  requiredMonthlyContribution,
} from "../src/domain/projection.ts";
import { addMonths, monthsBetween } from "../src/domain/dates.ts";

test("date arithmetic clamps to the end of the target month", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-01-15", 12), "2027-01-15");
  assert.equal(addMonths("2026-03-31", 1), "2026-04-30");
  assert.equal(monthsBetween("2026-01-01", "2027-01-01"), 12);
  assert.equal(monthsBetween("2026-01-15", "2026-02-14"), 0);
  assert.equal(monthsBetween("2026-03-01", "2026-01-01"), -2);
});

test("projection compounds and adds contributions at month end", () => {
  const points = projectMonths({
    startValue: 10000,
    startDate: "2026-01-01",
    annualReturn: 0.06,
    monthlyContribution: 500,
    months: 3,
  });

  assert.equal(points.length, 4);
  // Month 1: 10000 * 1.005 + 500 = 10550
  assert.equal(points[1]?.value, 10550);
  // Month 2: 10550 * 1.005 + 500 = 11102.75
  assert.equal(points[2]?.value, 11102.75);
  assert.equal(points[3]?.contributed, 1500);
  assert.equal(points[3]?.date, "2026-04-01");
});

test("a zero return degenerates to a straight-line saving plan", () => {
  const points = projectMonths({
    startValue: 0,
    startDate: "2026-01-01",
    annualReturn: 0,
    monthlyContribution: 100,
    months: 12,
  });
  assert.equal(points.at(-1)?.value, 1200);
});

test("ETA helpers report the first month at or above the target", () => {
  const points = projectMonths({
    startValue: 1000,
    startDate: "2026-01-01",
    annualReturn: 0.06,
    monthlyContribution: 100,
    months: 24,
  });
  // 1000 grows at 0.5%/month plus 100: 1105, 1210.53, 1316.58, 1423.16, 1530.28,
  // so 1500 is first reached in month 5.
  assert.equal(etaForTarget(points, 1500), "2026-06-01");
  assert.equal(monthsToTarget(points, 1500), 5);
  assert.equal(etaForTarget(points, 1_000_000), null);
});

test("scenarios spread the base return by two percentage points", () => {
  const scenarios = projectScenarios({
    startValue: 10000,
    startDate: "2026-01-01",
    annualReturn: 0.07,
    monthlyContribution: 0,
    months: 120,
  });

  assert.deepEqual(scenarios.map((s) => s.key), ["low", "base", "high"]);
  assert.deepEqual(scenarios.map((s) => s.annualReturn), [0.05, 0.07, 0.09]);
  assert.ok(scenarios[0]!.endValue < scenarios[1]!.endValue);
  assert.ok(scenarios[1]!.endValue < scenarios[2]!.endValue);
});

test("required monthly contribution hits the target on the target date", () => {
  const result = requiredMonthlyContribution({
    startValue: 10000,
    fromDate: "2026-01-01",
    targetAmount: 50000,
    targetDate: "2029-01-01",
    annualReturn: 0.06,
  });

  assert.equal(result.months, 36);
  assert.equal(result.targetPassed, false);
  assert.equal(result.alreadyOnTrack, false);

  // Feed the answer back into the simulator: it must land on the target.
  const points = projectMonths({
    startValue: 10000,
    startDate: "2026-01-01",
    annualReturn: 0.06,
    monthlyContribution: result.monthly,
    months: 36,
  });
  const end = points.at(-1)?.value ?? 0;
  assert.ok(Math.abs(end - 50000) <= 1, `expected about 50000, got ${end}`);
});

test("required contribution is zero when the target is already reachable", () => {
  const onTrack = requiredMonthlyContribution({
    startValue: 60000,
    fromDate: "2026-01-01",
    targetAmount: 50000,
    targetDate: "2029-01-01",
    annualReturn: 0.06,
  });
  assert.equal(onTrack.monthly, 0);
  assert.equal(onTrack.alreadyOnTrack, true);

  const passed = requiredMonthlyContribution({
    startValue: 10000,
    fromDate: "2026-01-01",
    targetAmount: 50000,
    targetDate: "2025-01-01",
    annualReturn: 0.06,
  });
  assert.equal(passed.targetPassed, true);
  assert.equal(passed.monthly, 0);
});

test("a zero-return plan needs simple arithmetic", () => {
  const result = requiredMonthlyContribution({
    startValue: 0,
    fromDate: "2026-01-01",
    targetAmount: 12000,
    targetDate: "2027-01-01",
    annualReturn: 0,
  });
  assert.equal(result.months, 12);
  assert.equal(result.monthly, 1000);
});
