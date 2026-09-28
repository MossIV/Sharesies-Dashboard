import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMilestones,
  firstReachedOn,
  nextMilestone,
  percentMilestones,
} from "../src/domain/milestones.ts";
import type { Milestone, ValuePoint } from "../src/domain/milestones.ts";

const series: ValuePoint[] = [
  { date: "2026-01-01", value: 1000 },
  { date: "2026-02-01", value: 6000 },
  { date: "2026-03-01", value: 12000 },
  { date: "2026-04-01", value: 11000 },
  { date: "2026-05-01", value: 25000 },
];

function milestone(partial: Partial<Milestone> & { id: number; amountNzd: number }): Milestone {
  return {
    goalId: 1,
    label: `$${partial.amountNzd}`,
    kind: "custom",
    percent: null,
    firstReachedOn: null,
    notes: null,
    ...partial,
  };
}

test("firstReachedOn finds the earliest date at or above the amount", () => {
  assert.equal(firstReachedOn(series, 5500), "2026-02-01");
  assert.equal(firstReachedOn(series, 12000), "2026-03-01");
  assert.equal(firstReachedOn(series, 25000), "2026-05-01");
  assert.equal(firstReachedOn(series, 30000), null);
});

test("firstReachedOn is unaffected by a later dip below the amount", () => {
  // 12000 is reached on 2026-03-01, then the value falls to 11000 in April.
  assert.equal(firstReachedOn(series, 12000), "2026-03-01");
});

test("states are reached, one next, then future", () => {
  const evaluated = evaluateMilestones(
    [
      milestone({ id: 1, amountNzd: 5000 }),
      milestone({ id: 2, amountNzd: 30000 }),
      milestone({ id: 3, amountNzd: 50000 }),
    ],
    series,
    11000,
  );

  const byId = new Map(evaluated.map((m) => [m.id, m]));
  assert.equal(byId.get(1)?.state, "reached");
  assert.equal(byId.get(1)?.firstReachedOn, "2026-02-01");
  assert.equal(byId.get(2)?.state, "next");
  assert.equal(byId.get(3)?.state, "future");
  assert.equal(nextMilestone(evaluated)?.id, 2);
});

test("reaching a milestone sticks even when the value falls below it again", () => {
  const evaluated = evaluateMilestones([milestone({ id: 1, amountNzd: 12000 })], series, 11000);
  const first = evaluated[0]!;
  assert.equal(first.state, "reached");
  assert.equal(first.firstReachedOn, "2026-03-01");
  assert.equal(first.currentlyBelow, true);
  assert.ok(first.gap > 0);
});

test("a persisted first-reached date survives a truncated series", () => {
  const evaluated = evaluateMilestones(
    [milestone({ id: 1, amountNzd: 5000, firstReachedOn: "2025-12-15" })],
    [{ date: "2026-04-01", value: 4000 }],
    4000,
  );
  assert.equal(evaluated[0]?.firstReachedOn, "2025-12-15");
  assert.equal(evaluated[0]?.state, "reached");
});

test("percent milestones are generated from the goal target", () => {
  assert.deepEqual(percentMilestones(40000), [
    { label: "25% of goal", amountNzd: 10000, kind: "percent", percent: 25 },
    { label: "50% of goal", amountNzd: 20000, kind: "percent", percent: 50 },
    { label: "75% of goal", amountNzd: 30000, kind: "percent", percent: 75 },
    { label: "100% of goal", amountNzd: 40000, kind: "percent", percent: 100 },
  ]);
});

test("progress is capped at 100 and milestones are evaluated in amount order", () => {
  const evaluated = evaluateMilestones(
    [milestone({ id: 1, amountNzd: 50000 }), milestone({ id: 2, amountNzd: 100 })],
    series,
    25000,
  );
  assert.deepEqual(evaluated.map((m) => m.id), [2, 1]);
  assert.equal(evaluated[0]?.progressPct, 100);
  assert.equal(evaluated[1]?.progressPct, 50);
});
