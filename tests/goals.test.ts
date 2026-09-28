import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGoalProgress, computePace, PACE_TOLERANCE_PCT } from "../src/domain/goals.ts";
import type { Goal } from "../src/domain/goals.ts";
import type { ValuePoint } from "../src/domain/milestones.ts";

function goal(partial: Partial<Goal> = {}): Goal {
  return {
    id: 1,
    name: "House deposit",
    targetAmountNzd: 100000,
    targetDate: "2028-01-01",
    progressBasis: "value",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const series: ValuePoint[] = [
  { date: "2026-01-01", value: 20000 },
  { date: "2026-07-01", value: 35000 },
];

test("progress bar maths", () => {
  const progress = computeGoalProgress({
    goal: goal(),
    currentValue: 25000,
    series,
    today: "2026-07-01",
    annualReturn: 0.07,
  });

  assert.equal(progress.progressPct, 25);
  assert.equal(progress.remaining, 75000);
  assert.equal(progress.progressBasis, "value");
});

test("pace is ahead, behind or on track against the straight line", () => {
  const half = "2027-01-01"; // halfway between 2026-01-01 and 2028-01-01
  const straightLine = computePace(goal(), series, 60000, half);
  // Baseline 20000 -> 100000 over 24 months: 40000 after 12 months, plus the
  // baseline. 60000 is comfortably above that, so: ahead.
  assert.equal(straightLine.expectedValue, 60000);
  assert.equal(straightLine.status, "on_track");

  assert.equal(computePace(goal(), series, 70000, half).status, "ahead");
  assert.equal(computePace(goal(), series, 45000, half).status, "behind");
});

test("pace is unknown without a target date, an empty series or a zero baseline", () => {
  assert.equal(computePace(goal({ targetDate: null }), series, 25000, "2026-07-01").status, "unknown");
  assert.equal(computePace(goal(), [], 25000, "2026-07-01").status, "unknown");
  assert.equal(
    computePace(goal({ targetAmountNzd: 0 }), [{ date: "2026-01-01", value: 0 }], 0, "2026-01-01").status,
    "unknown",
  );
});

test("the on-track band is symmetric around the straight line", () => {
  const expected = 60000;
  const inside = expected * (1 + (PACE_TOLERANCE_PCT - 0.5) / 100);
  const outside = expected * (1 + (PACE_TOLERANCE_PCT + 0.5) / 100);
  assert.equal(computePace(goal(), series, inside, "2027-01-01").status, "on_track");
  assert.equal(computePace(goal(), series, outside, "2027-01-01").status, "ahead");
});

test("the contributions basis tracks deposits instead of value", () => {
  const progress = computeGoalProgress({
    goal: goal({ progressBasis: "contributions" }),
    currentValue: 80000,
    netContributions: 30000,
    series,
    today: "2026-07-01",
    annualReturn: 0.07,
  });

  assert.equal(progress.progressBasis, "contributions");
  assert.equal(progress.progressValue, 30000);
  assert.equal(progress.progressPct, 30);
  // The current value is still reported, it just is not the basis.
  assert.equal(progress.currentValue, 80000);
});

test("required monthly contribution is derived from the target date", () => {
  const progress = computeGoalProgress({
    goal: goal({ targetDate: "2027-01-01" }),
    currentValue: 20000,
    series,
    today: "2026-01-01",
    annualReturn: 0,
  });

  // 80000 remaining over 12 months with no growth.
  assert.equal(progress.requiredMonthly, 6666.67);
  assert.equal(progress.targetPassed, false);

  const noDate = computeGoalProgress({
    goal: goal({ targetDate: null }),
    currentValue: 20000,
    series,
    today: "2026-01-01",
    annualReturn: 0.07,
  });
  assert.equal(noDate.requiredMonthly, null);
});
