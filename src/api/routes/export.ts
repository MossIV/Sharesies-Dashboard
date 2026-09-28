/**
 * Export every stored row as JSON or CSV.
 *
 * The backup script (`src/db/backup.ts`) is what protects the history; these
 * endpoints are what let the history leave this machine in a readable form, which
 * is the difference between "backed up" and "not lost when this app stops working"
 * (plan section 11, Phase 4; the risk it answers is in section 13).
 */
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { buildDump, contributionsCsv, snapshotsCsv, storageCounts } from "../../export/dump.ts";

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function exportRoutes(db: DatabaseSync) {
  const app = new Hono();

  app.get("/export/counts", (c) => c.json({ counts: storageCounts(db) }));

  app.get("/export/json", (c) => {
    return c.json(buildDump(db), 200, {
      "content-disposition": `attachment; filename="sharesies-dashboard-${stamp()}.json"`,
    });
  });

  app.get("/export/snapshots.csv", (c) => {
    return c.body(snapshotsCsv(db), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="sharesies-snapshots-${stamp()}.csv"`,
    });
  });

  app.get("/export/contributions.csv", (c) => {
    return c.body(contributionsCsv(db), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="sharesies-contributions-${stamp()}.csv"`,
    });
  });

  return app;
}
