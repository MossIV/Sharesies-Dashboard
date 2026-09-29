import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import {
  createContribution,
  deleteContribution,
  listContributions,
  netContributions,
  totalSeries,
} from "../../db/repo.ts";
import { contributionSeries } from "../../domain/contributions.ts";
import { notFound, optEnum, optString, queryParam, readJson, reqDate, reqId, reqNumber } from "../validate.ts";

export function contributionRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  /**
   * The log, and the two numbers it can be read against.
   *
   * `contributions` is every row, including the ones an import attributed to an
   * account outside the goal: hiding them would make a complete history look like a
   * short one. The totals are the goal's, and `excludedTotalAllTime` says how much
   * sits outside it, so a gap between the log and the headline figure has a stated
   * reason rather than being a mystery.
   */
  app.get("/contributions", (c) => {
    const url = new URL(c.req.url);
    const from = queryParam(url, "from");
    const to = queryParam(url, "to");
    const inGoalRows = listContributions(db, { from: undefined, to: undefined });
    const inGoalIds = new Set(inGoalRows.map((row) => row.id));
    // The scope decision is made once, in SQL, and reported per row. Re-deriving it
    // in the UI would be a second copy of the rule, free to drift from the total.
    const all = listContributions(db, { from: undefined, to: undefined, scope: "all" })
      .map((row) => ({ ...row, inGoal: inGoalIds.has(row.id) }));
    const totalAllTime = netContributions(db);
    const allTime = netContributions(db, { scope: "all" });

    // The chart's series, which must use the same rows as `totalAllTime` or the
    // graph and the number above it will disagree.
    const series = contributionSeries({
      points: totalSeries(db),
      contributions: inGoalRows.map((row) => ({ contributionDate: row.contributionDate, amountNzd: row.amountNzd })),
    });

    return c.json({
      contributions: all,
      /** In the goal, over the requested window. */
      total: netContributions(db, { from, to }),
      /** In the goal, all time: the figure the dashboard's charts use. */
      totalAllTime,
      /** Logged but outside the goal: another portfolio, or unattributed. */
      excludedTotalAllTime: Math.round((allTime - totalAllTime) * 100) / 100,
      counts: {
        all: all.length,
        inGoal: inGoalRows.length,
        excluded: all.length - inGoalRows.length,
      },
      series,
      scope: "goal",
    });
  });

  app.post("/contributions", async (c) => {
    const body = await readJson(c.req.raw);
    const contribution = createContribution(db, {
      contributionDate: reqDate(body, "contributionDate"),
      amountNzd: reqNumber(body, "amountNzd", { min: -1_000_000, max: 1_000_000 }),
      note: optString(body, "note") ?? null,
      source: optEnum(body, "source", ["manual", "csv", "bank"] as const) ?? "manual",
    });
    return c.json({ contribution, totalAllTime: netContributions(db) }, 201);
  });

  app.delete("/contributions/:id", (c) => {
    const id = reqId(c.req.param("id"));
    if (!deleteContribution(db, id)) throw notFound(`No contribution with id ${id}`);
    return c.json({ deleted: true, id, totalAllTime: netContributions(db) });
  });

  return app;
}
