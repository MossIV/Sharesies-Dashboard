import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import {
  createGoal,
  createMilestone,
  deleteGoal,
  deleteMilestone,
  getGoal,
  listGoals,
  listMilestones,
  updateGoal,
  updateMilestone,
} from "../../db/repo.ts";
import { percentMilestones } from "../../domain/milestones.ts";
import {
  badRequest,
  notFound,
  optBoolean,
  optDate,
  optEnum,
  optString,
  readJson,
  reqId,
  reqNumber,
  reqString,
} from "../validate.ts";

export function goalRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  // ------------------------------------------------------------------- goals

  app.get("/goals", (c) => c.json({ goals: listGoals(db) }));

  app.get("/goals/:id", (c) => {
    const id = reqId(c.req.param("id"));
    const goal = getGoal(db, id);
    if (!goal) throw notFound(`No goal with id ${id}`);
    return c.json({ goal, milestones: listMilestones(db, id) });
  });

  app.post("/goals", async (c) => {
    const body = await readJson(c.req.raw);
    const goal = createGoal(db, {
      name: reqString(body, "name", { maxLength: 120 }),
      targetAmountNzd: reqNumber(body, "targetAmountNzd", { min: 1 }),
      targetDate: optDate(body, "targetDate") ?? null,
      progressBasis: optEnum(body, "progressBasis", ["value", "contributions"] as const) ?? "value",
      isActive: optBoolean(body, "isActive") ?? true,
    });

    // Optionally seed the 25/50/75/100% milestones in the same request.
    let milestones = listMilestones(db, goal.id);
    if (optBoolean(body, "withPercentMilestones") === true) {
      milestones = percentMilestones(goal.targetAmountNzd).map((milestone) =>
        createMilestone(db, { goalId: goal.id, ...milestone })
      );
    }

    return c.json({ goal, milestones }, 201);
  });

  app.patch("/goals/:id", async (c) => {
    const id = reqId(c.req.param("id"));
    const body = await readJson(c.req.raw);
    const goal = updateGoal(db, id, {
      ...(("name" in body) ? { name: reqString(body, "name", { maxLength: 120 }) } : {}),
      ...(("targetAmountNzd" in body) ? { targetAmountNzd: reqNumber(body, "targetAmountNzd", { min: 1 }) } : {}),
      ...(("targetDate" in body) ? { targetDate: optDate(body, "targetDate") ?? null } : {}),
      ...(("progressBasis" in body)
        ? { progressBasis: optEnum(body, "progressBasis", ["value", "contributions"] as const) ?? "value" }
        : {}),
      ...(("isActive" in body) ? { isActive: optBoolean(body, "isActive") ?? true } : {}),
    });
    if (!goal) throw notFound(`No goal with id ${id}`);
    return c.json({ goal, milestones: listMilestones(db, id) });
  });

  app.delete("/goals/:id", (c) => {
    const id = reqId(c.req.param("id"));
    if (!deleteGoal(db, id)) throw notFound(`No goal with id ${id}`);
    return c.json({ deleted: true, id });
  });

  // -------------------------------------------------------------- milestones

  app.get("/goals/:id/milestones", (c) => {
    const id = reqId(c.req.param("id"));
    if (!getGoal(db, id)) throw notFound(`No goal with id ${id}`);
    return c.json({ milestones: listMilestones(db, id) });
  });

  app.post("/goals/:id/milestones", async (c) => {
    const goalId = reqId(c.req.param("id"));
    const goal = getGoal(db, goalId);
    if (!goal) throw notFound(`No goal with id ${goalId}`);

    const body = await readJson(c.req.raw);

    // Convenience: {"percent": [25, 50, 75, 100]} expands to that set.
    if (Array.isArray(body["percent"])) {
      const percents = body["percent"].map((value, index) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) {
          throw badRequest(`percent[${index}] must be a number between 0 and 1000`);
        }
        return parsed;
      });
      const created = percentMilestones(goal.targetAmountNzd, percents).map((milestone) =>
        createMilestone(db, { goalId, ...milestone })
      );
      return c.json({ milestones: created }, 201);
    }

    const kind = optEnum(body, "kind", ["custom", "percent"] as const) ?? "custom";
    const percent = body["percent"] === undefined ? null : reqNumber(body, "percent", { min: 0.01, max: 1000 });
    const amount = body["amountNzd"] === undefined
      ? (percent === null ? null : Math.round(((goal.targetAmountNzd * percent) / 100) * 100) / 100)
      : reqNumber(body, "amountNzd", { min: 1 });

    if (amount === null) throw badRequest("amountNzd is required (or provide percent with a goal target)");

    const milestone = createMilestone(db, {
      goalId,
      label: reqString(body, "label", { maxLength: 120 }),
      amountNzd: amount,
      kind,
      percent,
      notes: optString(body, "notes") ?? null,
    });
    return c.json({ milestone }, 201);
  });

  app.patch("/milestones/:id", async (c) => {
    const id = reqId(c.req.param("id"));
    const body = await readJson(c.req.raw);

    // A target-date change is a goal-level decision, so accept annualReturn-free
    // edits here but keep the percentage consistent with the new amount.
    const milestone = updateMilestone(db, id, {
      ...(("label" in body) ? { label: reqString(body, "label", { maxLength: 120 }) } : {}),
      ...(("amountNzd" in body) ? { amountNzd: reqNumber(body, "amountNzd", { min: 1 }) } : {}),
      ...(("kind" in body) ? { kind: optEnum(body, "kind", ["custom", "percent"] as const) ?? "custom" } : {}),
      ...(("percent" in body)
        ? { percent: body["percent"] === null ? null : reqNumber(body, "percent", { min: 0.01, max: 1000 }) }
        : {}),
      ...(("notes" in body) ? { notes: optString(body, "notes") ?? null } : {}),
      ...(("firstReachedOn" in body) ? { firstReachedOn: optDate(body, "firstReachedOn") ?? null } : {}),
    });
    if (!milestone) throw notFound(`No milestone with id ${id}`);
    return c.json({ milestone });
  });

  app.delete("/milestones/:id", (c) => {
    const id = reqId(c.req.param("id"));
    if (!deleteMilestone(db, id)) throw notFound(`No milestone with id ${id}`);
    return c.json({ deleted: true, id });
  });

  return app;
}
