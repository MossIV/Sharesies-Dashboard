import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { buildSummary } from "../summary.ts";

export function summaryRoutes(db: DatabaseSync, options: { today?: string; now?: Date } = {}): Hono {
  const app = new Hono();

  /** Current value, goal progress, next milestone and sync health. */
  // `today` and `now` are passed through so a test can pin the clock the summary is
  // judged against. Both matter and for different reasons: staleness is "hours since
  // the source refreshed" (which is `now`) and "days since the last snapshot" (which
  // is `today`), so a test seeding fixed dates would otherwise pass on the day it was
  // written and fail a week later.
  app.get("/summary", (c) => c.json(buildSummary(db, options)));

  return app;
}
