import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { buildSummary } from "../summary.ts";

export function summaryRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  /** Current value, goal progress, next milestone and sync health. */
  app.get("/summary", (c) => c.json(buildSummary(db)));

  return app;
}
