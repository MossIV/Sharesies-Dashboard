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
import { basisPayload, resolveContributionsBasis } from "../settings.ts";
import { badRequest, notFound, optEnum, optString, queryParam, readJson, reqDate, reqId, reqNumber } from "../validate.ts";

export function contributionRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  /** The goal's total under the basis in force, for the write endpoints to echo back. */
  const goalTotal = (): number => netContributions(db, { basis: resolveContributionsBasis(db).basis });

  /**
   * The log, and the two numbers it can be read against.
   *
   * `contributions` is every row, including the ones an import attributed to an
   * account outside the goal: hiding them would make a complete history look like a
   * short one. The totals are the goal's, and `excludedTotalAllTime` says how much
   * sits outside it, so a gap between the log and the headline figure has a stated
   * reason rather than being a mystery.
   *
   * Rows carry two flags, because two separate rules can leave a row out. `inGoal` is
   * the account scope: this row belongs to an account the goal tracks. `counted` is
   * that plus the basis: money sent to the platform, rather than a movement inside it.
   * Both are decided in SQL and reported, rather than re-derived here or in the UI
   * where a second copy of the rule would be free to drift from the total it explains.
   */
  app.get("/contributions", (c) => {
    const url = new URL(c.req.url);
    const from = queryParam(url, "from");
    const to = queryParam(url, "to");
    const basis = resolveContributionsBasis(db);

    const scopeRows = listContributions(db, { scope: "goal" });
    const countedRows = listContributions(db, { scope: "goal", basis: basis.basis });
    const inGoalIds = new Set(scopeRows.map((row) => row.id));
    const countedIds = new Set(countedRows.map((row) => row.id));
    const all = listContributions(db, { scope: "all" }).map((row) => ({
      ...row,
      inGoal: inGoalIds.has(row.id),
      counted: countedIds.has(row.id),
    }));

    const totalAllTime = netContributions(db, { basis: basis.basis });
    const allTime = netContributions(db, { scope: "all" });

    // The chart's series, which must use the same rows as `totalAllTime` or the graph
    // and the number above it will disagree.
    const series = contributionSeries({
      points: totalSeries(db),
      contributions: countedRows.map((row) => ({ contributionDate: row.contributionDate, amountNzd: row.amountNzd })),
    });

    return c.json({
      contributions: all,
      /** In the goal, over the requested window. */
      total: netContributions(db, { from, to, basis: basis.basis }),
      /** In the goal, all time: the figure the dashboard's charts use. */
      totalAllTime,
      /** Logged but outside the goal: another portfolio, or unattributed. */
      excludedTotalAllTime: Math.round((allTime - totalAllTime) * 100) / 100,
      counts: {
        all: all.length,
        inGoal: scopeRows.length,
        /** In the goal *and* counting under the basis: what the totals add up. */
        counted: countedRows.length,
        excluded: all.length - scopeRows.length,
        /** In the goal but internal to the platform: logged, not counted. */
        inGoalNotCounted: scopeRows.length - countedRows.length,
      },
      /** What the contributions figure is counting, and where that choice came from. */
      basis: basis.basis,
      basisRequested: basis.requested,
      basisSource: basis.source,
      basisNote: basisPayload(basis).note,
      series,
      scope: "goal",
    });
  });

  app.post("/contributions", async (c) => {
    const body = await readJson(c.req.raw);
    const source = optEnum(body, "source", ["manual", "csv", "bank"] as const) ?? "manual";
    const category = optString(body, "category") ?? null;

    // A category is the only thing that tells a report row apart from a movement
    // inside the platform, so a csv row logged by hand without one would be invisible
    // in the totals it was meant to appear in. Refusing it explains the rule at the
    // moment it matters, rather than leaving a row that silently counts for nothing.
    if (source === "csv" && category === null) {
      throw badRequest('A csv row needs a category ("deposit" or "withdrawal") to count as a contribution');
    }

    const contribution = createContribution(db, {
      contributionDate: reqDate(body, "contributionDate"),
      amountNzd: reqNumber(body, "amountNzd", { min: -1_000_000, max: 1_000_000 }),
      note: optString(body, "note") ?? null,
      source,
      category,
    });
    return c.json({ contribution, totalAllTime: goalTotal() }, 201);
  });

  app.delete("/contributions/:id", (c) => {
    const id = reqId(c.req.param("id"));
    if (!deleteContribution(db, id)) throw notFound(`No contribution with id ${id}`);
    return c.json({ deleted: true, id, totalAllTime: goalTotal() });
  });

  return app;
}
