/**
 * The goal lifecycle: which goal the dashboard measures.
 *
 * Both behaviours here were written after a real first run exposed the failure
 * they prevent. The demo seeder left its goal behind on `--reset`, the real goal
 * became the second active row, and `getActiveGoal` returned the older one: the
 * dashboard showed a $100k demo target against a real $18,000 one, with nothing
 * on screen to say the goal was not the user's. A silent wrong answer is the worst
 * kind, so both halves are pinned down here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createGoal,
  createMilestone,
  deleteGoal,
  getActiveGoal,
  getGoal,
  listGoals,
  listMilestones,
  updateGoal,
} from "../src/db/repo.ts";
import { testDb } from "./helpers.ts";

describe("goal activation", () => {
  test("creating an active goal deactivates the one before it", () => {
    const db = testDb();
    const first = createGoal(db, { name: "First $100k", targetAmountNzd: 100_000 });
    const second = createGoal(db, { name: "High-growth portfolio", targetAmountNzd: 18_000 });

    assert.equal(getGoal(db, first.id)?.isActive, false);
    assert.equal(getGoal(db, second.id)?.isActive, true);
    assert.equal(getActiveGoal(db)?.id, second.id, "the newest goal is the one measured");
    assert.equal(listGoals(db).filter((goal) => goal.isActive).length, 1);

    db.close();
  });

  test("an inactive goal does not disturb the active one", () => {
    const db = testDb();
    const active = createGoal(db, { name: "Active", targetAmountNzd: 18_000 });
    const parked = createGoal(db, { name: "Later", targetAmountNzd: 50_000, isActive: false });

    assert.equal(getGoal(db, active.id)?.isActive, true);
    assert.equal(getGoal(db, parked.id)?.isActive, false);
    assert.equal(getActiveGoal(db)?.id, active.id);

    db.close();
  });

  test("reactivating an old goal makes it the measured one", () => {
    const db = testDb();
    createGoal(db, { name: "Old", targetAmountNzd: 5_000 });
    const newer = createGoal(db, { name: "New", targetAmountNzd: 18_000 });
    const old = listGoals(db).find((goal) => goal.name === "Old")!;

    updateGoal(db, old.id, { isActive: true });

    assert.equal(getActiveGoal(db)?.id, old.id);
    assert.equal(getGoal(db, newer.id)?.isActive, false);
    assert.equal(listGoals(db).filter((goal) => goal.isActive).length, 1);

    db.close();
  });

  test("with two active rows anyway, the newest wins rather than the lowest id", () => {
    const db = testDb();
    const first = createGoal(db, { name: "First $100k", targetAmountNzd: 100_000 });
    const second = createGoal(db, { name: "High-growth portfolio", targetAmountNzd: 18_000 });

    // Force the impossible state directly, the way the old seeded database was in.
    db.prepare("UPDATE goals SET is_active = 1").run();

    assert.equal(first.id < second.id, true, "the fixture needs the older row to have the lower id");
    assert.equal(getActiveGoal(db)?.id, second.id);

    db.close();
  });

  test("deleting a goal takes its milestones with it", () => {
    const db = testDb();
    const goal = createGoal(db, { name: "High-growth portfolio", targetAmountNzd: 18_000 });
    createMilestone(db, { goalId: goal.id, label: "25% of goal", amountNzd: 4_500 });
    createMilestone(db, { goalId: goal.id, label: "50% of goal", amountNzd: 9_000 });
    assert.equal(listMilestones(db, goal.id).length, 2);

    assert.equal(deleteGoal(db, goal.id), true);

    assert.equal(listMilestones(db, goal.id).length, 0, "milestones must not outlive their goal");
    assert.equal(getActiveGoal(db), null);
    db.close();
  });
});

describe("goal source", () => {
  test("a goal created by a user is manual", () => {
    const db = testDb();
    const goal = createGoal(db, { name: "High-growth portfolio", targetAmountNzd: 18_000 });
    assert.equal(goal.source, "manual");
    db.close();
  });

  test("a seeded goal is marked demo, so the seeder's reset can find it", () => {
    const db = testDb();
    const demo = createGoal(db, { name: "First $100k", targetAmountNzd: 100_000, source: "demo" });
    const real = createGoal(db, { name: "High-growth portfolio", targetAmountNzd: 18_000 });

    assert.equal(demo.source, "demo");
    assert.equal(real.source, "manual");

    // What `seed:demo:reset` runs, and the fix for the leftover-demo-goal bug.
    const removed = db.prepare("DELETE FROM goals WHERE source = 'demo'").run();
    assert.equal(Number(removed.changes), 1);
    assert.deepEqual(listGoals(db).map((goal) => goal.name), ["High-growth portfolio"]);

    db.close();
  });

  test("the reset never touches a real goal even with the demo name", () => {
    const db = testDb();
    // A user who simply likes the same name and target as the seeder.
    createGoal(db, { name: "First $100k", targetAmountNzd: 100_000 });

    const removed = db.prepare("DELETE FROM goals WHERE source = 'demo'").run();
    assert.equal(Number(removed.changes), 0);
    assert.equal(listGoals(db).length, 1);

    db.close();
  });
});