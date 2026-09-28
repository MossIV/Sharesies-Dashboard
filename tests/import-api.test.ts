import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { CsvSource } from "../src/sources/CsvSource.ts";
import { listContributions } from "../src/db/repo.ts";
import { testDb, FIXTURES } from "./helpers.ts";

process.env["QUIET"] = "1";

const SAMPLE = readFileSync(join(FIXTURES, "sharesies-transaction-report.sample.csv"), "utf8");

function app() {
  const db = testDb();
  return { db, app: createApp(db) };
}

async function post(app: ReturnType<typeof createApp>, body: unknown): Promise<{ status: number; body: any }> {
  const response = await app.request("/api/import/sharesies-csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("POST /api/import/sharesies-csv", () => {
  test("preview reports what it found and writes nothing", async () => {
    const { db, app: server } = app();
    const result = await post(server, { csv: SAMPLE, filename: "report.csv" });

    assert.equal(result.status, 200);
    assert.equal(result.body.mode, "preview");
    assert.equal(result.body.imported, 0);
    assert.equal(result.body.importId, null);
    assert.equal(result.body.detected.dateFormat, "iso");
    assert.equal(result.body.detected.counts.deposit, 4);
    assert.equal(result.body.detected.counts.buy, 2);
    assert.equal(result.body.selected.length, 4);
    assert.equal(result.body.transactions.length, 9, "every row is reported back");

    assert.equal(listContributions(db).length, 0, "a preview must not write");

    db.close();
  });

  test("apply writes the deposits and records the run", async () => {
    const { db, app: server } = app();
    const result = await post(server, { csv: SAMPLE, filename: "report.csv", mode: "apply" });

    assert.equal(result.body.imported, 4);
    assert.equal(result.body.skipped, 0);
    assert.ok(result.body.importId !== null);

    const contributions = listContributions(db);
    assert.equal(contributions.length, 4);
    assert.deepEqual(
      contributions.map((row) => row.contributionDate).sort(),
      ["2026-01-15", "2026-02-15", "2026-03-15", "2026-05-15"],
    );
    assert.deepEqual(contributions.map((row) => row.amountNzd).sort((a, b) => a - b), [500, 500, 500, 750]);
    assert.equal(contributions[0]?.source, "csv");
    assert.ok(contributions[0]?.note?.startsWith("Sharesies report:"), contributions[0]?.note ?? "");

    const imports = await (await server.request("/api/imports")).json() as any;
    assert.equal(imports.imports.length, 1);
    assert.equal(imports.imports[0].kind, "sharesies_report");
    assert.equal(imports.imports[0].filename, "report.csv");
    assert.equal(imports.imports[0].rowsSeen, 9);
    assert.equal(imports.imports[0].rowsImported, 4);

    db.close();
  });

  test("re-importing the same file adds nothing", async () => {
    const { db, app: server } = app();
    await post(server, { csv: SAMPLE, mode: "apply" });
    const second = await post(server, { csv: SAMPLE, mode: "apply" });

    assert.equal(second.body.imported, 0);
    assert.equal(second.body.skipped, 4);
    assert.equal(listContributions(db).length, 4, "no duplicates");
    assert.ok(
      second.body.warnings.some((warning: string) => warning.includes("already in the log")),
      second.body.warnings.join(" | "),
    );

    db.close();
  });

  test("buy rows are imported only when asked for by category", async () => {
    const { db, app: server } = app();
    const result = await post(server, { csv: SAMPLE, mode: "apply", categories: ["deposit", "buy"] });

    assert.equal(result.body.imported, 6);
    const contributions = listContributions(db);
    assert.equal(contributions.length, 6);
    assert.ok(contributions.every((row) => row.amountNzd > 0), "a negative buy is stored as a positive amount");

    db.close();
  });

  test("imported contributions reach the summary's net contributions", async () => {
    const { db, app: server } = app();
    await post(server, { csv: SAMPLE, mode: "apply" });

    const summary = await (await server.request("/api/summary")).json() as any;
    assert.equal(summary.netContributions, 2250);

    db.close();
  });

  test("rejects a missing or empty csv", async () => {
    const { db, app: server } = app();
    assert.equal((await post(server, {})).status, 400);
    assert.equal((await post(server, { csv: "   " })).status, 400);
    db.close();
  });

  test("rejects an unknown category or date format", async () => {
    const { db, app: server } = app();
    const badCategory = await post(server, { csv: SAMPLE, categories: ["nonsense"] });
    assert.equal(badCategory.status, 400);
    assert.match(badCategory.body.error, /categories may only contain/);

    const badFormat = await post(server, { csv: SAMPLE, dateFormat: "nonsense" });
    assert.equal(badFormat.status, 400);

    db.close();
  });

  test("honours an explicit dateFormat override", async () => {
    const { db, app: server } = app();
    const variant = readFileSync(join(FIXTURES, "sharesies-report-variant.sample.csv"), "utf8");

    const asDmy = await post(server, { csv: variant });
    assert.equal(asDmy.body.detected.dateAmbiguous, true);
    assert.equal(asDmy.body.selected[0].date, "2026-04-03");

    const asMdy = await post(server, { csv: variant, dateFormat: "mdy" });
    assert.equal(asMdy.body.detected.dateAmbiguous, false);
    assert.equal(asMdy.body.selected[0].date, "2026-03-04");

    db.close();
  });
});

describe("CsvSource", () => {
  test("takes the newest running balance as the portfolio value", async () => {
    const source = new CsvSource({ filePath: join(FIXTURES, "sharesies-transaction-report.sample.csv") });
    const result = await source.fetchAccounts();

    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0]?.valueNzd, 2476.54);
    // Fresh as of the report, not as of now.
    assert.equal(result.accounts[0]?.sourceRefreshedAt, "2026-05-15T00:00:00.000Z");
    assert.equal(result.accounts[0]?.holdings.length, 0, "no holdings are invented from a transaction log");

    // The default connection matcher must select it.
    assert.equal(result.accounts[0]?.connectionName, "Sharesies");
  });

  test("refuses to supply a value when the report has no balance column", async () => {
    // No balance column at all: a transaction log says nothing about what the
    // portfolio was worth, and inventing a number would be worse than failing.
    const scratch = join(process.env["TMPDIR"] ?? ".", "report-no-balance.csv");
    writeFileSync(scratch, "Date,Type,Description,Amount\n2026-01-15,Top up,Top up,500.00\n");

    const source = new CsvSource({ filePath: scratch });
    await assert.rejects(() => source.fetchAccounts(), /no balance column/);

    rmSync(scratch, { force: true });
  });
});
