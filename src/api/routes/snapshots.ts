import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { latestHoldings, listSnapshots, totalSeries } from "../../db/repo.ts";
import { queryParam } from "../validate.ts";

export function snapshotRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  /**
   * The value-over-time series. Without a range the full history is returned;
   * `?perAccount=1` returns one row per account per day instead of the total.
   */
  app.get("/snapshots", (c) => {
    const url = new URL(c.req.url);
    const from = queryParam(url, "from");
    const to = queryParam(url, "to");
    const accountId = queryParam(url, "accountId");
    const perAccount = queryParam(url, "perAccount") === "1";

    if (perAccount) {
      return c.json({ from: from ?? null, to: to ?? null, snapshots: listSnapshots(db, { from, to, accountId }) });
    }

    const series = totalSeries(db, { from, to });
    return c.json({
      from: series[0]?.date ?? from ?? null,
      to: series.at(-1)?.date ?? to ?? null,
      points: series,
      first: series[0]?.value ?? null,
      last: series.at(-1)?.value ?? null,
    });
  });

  /** Allocation data, only available when Akahu exposes meta.portfolio. */
  app.get("/holdings/latest", (c) => {
    const holdings = latestHoldings(db);
    const total = holdings.reduce((sum, holding) => sum + (holding.value ?? 0), 0);
    return c.json({
      available: holdings.length > 0,
      note: holdings.length === 0
        ? "No holdings were present in meta.portfolio for the latest snapshot. Akahu does not guarantee this data."
        : null,
      totalValue: Math.round(total * 100) / 100,
      holdings: holdings.map((holding) => ({
        ...holding,
        sharePct: total > 0 && holding.value !== null
          ? Math.round((holding.value / total) * 1000) / 10
          : null,
      })),
    });
  });

  return app;
}
