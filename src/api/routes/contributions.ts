import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { createContribution, deleteContribution, listContributions, netContributions } from "../../db/repo.ts";
import { notFound, optEnum, optString, queryParam, readJson, reqDate, reqId, reqNumber } from "../validate.ts";

export function contributionRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/contributions", (c) => {
    const url = new URL(c.req.url);
    const from = queryParam(url, "from");
    const to = queryParam(url, "to");
    const contributions = listContributions(db, { from, to });
    return c.json({
      contributions,
      total: netContributions(db, { from, to }),
      totalAllTime: netContributions(db),
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
