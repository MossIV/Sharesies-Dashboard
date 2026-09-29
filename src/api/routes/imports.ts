import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { listImports } from "../../db/repo.ts";
import { importSharesiesReport } from "../../import/sharesies-report.ts";
import type { DateFormat, RowCategory } from "../../import/csv.ts";
import { badRequest, optEnum, optString, readJson } from "../validate.ts";

/** A report is a few hundred kilobytes at most; this is a sanity bound, not a quota. */
const MAX_CSV_BYTES = 5_000_000;

const CATEGORIES: RowCategory[] = [
  "deposit", "withdrawal", "buy", "sell", "dividend", "fee", "interest", "transfer", "unknown",
];

const DATE_FORMATS: DateFormat[] = ["iso", "dmy", "mdy", "named", "unknown"];

function reqCategories(body: Record<string, unknown>): RowCategory[] | undefined {
  if (!("categories" in body)) return undefined;
  const value = body["categories"];
  if (!Array.isArray(value)) throw badRequest("categories must be an array", { categories: "expected an array" });
  if (value.length === 0) throw badRequest("categories must not be empty", { categories: "empty" });

  return value.map((entry) => {
    if (typeof entry !== "string" || !CATEGORIES.includes(entry as RowCategory)) {
      throw badRequest(`categories may only contain: ${CATEGORIES.join(", ")}`, { categories: "invalid" });
    }
    return entry as RowCategory;
  });
}

export function importRoutes(db: DatabaseSync) {
  const app = new Hono();

  /**
   * Preview or apply a Sharesies transaction report.
   *
   * The body carries the CSV text rather than a path: the browser reads the file
   * the user picked, so the server never gains a "read any file on disk" endpoint.
   *
   * `mode` defaults to "preview" — nothing is written unless asked for.
   */
  app.post("/import/sharesies-csv", async (c) => {
    const body = await readJson(c.req.raw);
    const csv = optString(body, "csv");
    if (typeof csv !== "string" || csv.trim() === "") {
      throw badRequest("csv must be the report's text content", { csv: "required" });
    }
    if (csv.length > MAX_CSV_BYTES) {
      throw badRequest(`csv is larger than ${MAX_CSV_BYTES} bytes`, { csv: "too large" });
    }

    const mode = optEnum(body, "mode", ["preview", "apply"] as const) ?? "preview";
    const filename = optString(body, "filename");
    const dateFormat = optEnum(body, "dateFormat", DATE_FORMATS);
    const categories = reqCategories(body);

    const outcome = await importSharesiesReport(db, {
      csv,
      filename: filename ?? null,
      mode,
      options: {
        ...(categories ? { categories } : {}),
        ...(dateFormat ? { dateFormat } : {}),
      },
    });

    return c.json({
      mode,
      // The rows an apply would write (or did write).
      selected: outcome.selected,
      imported: outcome.imported,
      skipped: outcome.skipped,
      importId: outcome.importId,
      detected: {
        delimiter: outcome.plan.delimiter,
        columns: outcome.plan.columns,
        unrecognisedColumns: outcome.plan.unrecognisedColumns,
        dateFormat: outcome.plan.dateFormat,
        dateAmbiguous: outcome.plan.dateAmbiguous,
        raggedRows: outcome.plan.raggedRows,
        counts: outcome.plan.counts,
        currencies: outcome.plan.currencies,
        portfolios: outcome.plan.portfolios,
      },
      // Which portfolio each row belongs to, and whether the account is in the goal.
      accounts: outcome.accounts,
      currencyTotals: outcome.currencyTotals,
      fx: outcome.fx,
      outsideGoal: outcome.outsideGoal,
      unattributed: outcome.unattributed,
      warnings: outcome.warnings,
      // Every row, so the UI can show what was found and what was ignored.
      transactions: outcome.transactions,
    });
  });

  app.get("/imports", (c) => c.json({ imports: listImports(db, 20) }));

  return app;
}
