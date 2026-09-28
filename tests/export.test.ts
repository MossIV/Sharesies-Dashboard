import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { collectOnce } from "../src/collector/collect.ts";
import { createContribution, createGoal, createMilestone, netContributions } from "../src/db/repo.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import { backupDatabase, backupFileName, listBackups, pruneBackups } from "../src/db/backup.ts";
import { openDb } from "../src/db/client.ts";
import { csvField, toCsv } from "../src/export/csv-write.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import { loadFixture, testDb } from "./helpers.ts";

process.env["QUIET"] = "1";

const NOW = new Date("2026-09-28T04:00:00.000Z");

function fakeSource(): PortfolioSource {
  const raw = loadFixture("accounts.sharesies-portfolio.sample.json");
  return {
    name: "akahu",
    fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
  };
}

async function seededApp() {
  const db = testDb();
  await collectOnce(db, { source: fakeSource(), now: NOW, notify: false });

  const goal = createGoal(db, {
    name: "First $100k",
    targetAmountNzd: 100_000,
    targetDate: "2028-09-27",
    progressBasis: "value",
  });
  createMilestone(db, { goalId: goal.id, label: "25% of goal", amountNzd: 25_000 });
  createContribution(db, {
    contributionDate: "2026-08-01",
    amountNzd: 400,
    note: 'Note with a comma, a "quote" and a\nnewline',
    source: "manual",
  });

  return { db, app: createApp(db, { today: "2026-09-28" }) };
}

describe("csv writing", () => {
  test("quotes only what needs quoting", () => {
    assert.equal(csvField("plain"), "plain");
    assert.equal(csvField("has,comma"), '"has,comma"');
    assert.equal(csvField('has"quote'), '"has""quote"');
    assert.equal(csvField("has\nnewline"), '"has\nnewline"');
    assert.equal(csvField(null), "");
    assert.equal(csvField(undefined), "");
    assert.equal(csvField(0), "0", "a zero must not become an empty cell");
    assert.equal(csvField(1234.56), "1234.56");
  });

  test("uses CRLF and ends with a newline", () => {
    const csv = toCsv(["a", "b"], [[1, 2], [3, 4]]);
    assert.equal(csv, "a,b\r\n1,2\r\n3,4\r\n");
  });
});

describe("export endpoints", () => {
  test("GET /api/export/json returns a complete, self-describing dump", async () => {
    const { db, app } = await seededApp();
    const response = await app.request("/api/export/json");

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="sharesies-dashboard-\d{4}-\d{2}-\d{2}\.json"/);

    const dump = await response.json() as any;
    assert.equal(dump.app, "sharesies-dashboard");
    assert.equal(dump.dumpVersion, 2);
    assert.equal(dump.goals.length, 1);
    assert.equal(dump.milestones.length, 1);
    assert.equal(dump.milestones[0].goalName, "First $100k");
    assert.equal(dump.snapshots.length, 3, "every account, including the out-of-scope one");
    assert.equal(dump.accounts.length, 3);
    assert.equal(dump.contributions.length, 1);
    assert.equal(dump.counts.snapshots, 3);
    assert.equal(dump.counts.netContributions, 400);
    assert.ok(dump.exportedAt.startsWith("20"));

    db.close();
  });

  test("GET /api/export/snapshots.csv is a CSV of every account", async () => {
    const { db, app } = await seededApp();
    const response = await app.request("/api/export/snapshots.csv");

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/csv/);

    const lines = (await response.text()).trim().split("\r\n");
    assert.equal(lines[0], "snapshot_date,account_id,account_name,value_nzd,currency,status,source,source_refreshed_at");
    assert.equal(lines.length, 4, "a header plus three accounts");
    assert.ok(lines.some((line) => line.startsWith("2026-09-28,acc_sharesies_investment_0001")));

    db.close();
  });

  test("GET /api/export/contributions.csv escapes the note", async () => {
    const { db, app } = await seededApp();
    const response = await app.request("/api/export/contributions.csv");
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.ok(text.includes('"Note with a comma, a ""quote"" and a\nnewline"'), text);
    assert.equal(text.trim().split("\r\n").length, 2, "the escaped newline must not add a row");

    db.close();
  });

  test("the CSV round-trips through the importer's parser", async () => {
    const { db, app } = await seededApp();
    const { parseCsv } = await import("../src/import/csv.ts");

    const text = await (await app.request("/api/export/contributions.csv")).text();
    const parsed = parseCsv(text);

    assert.equal(parsed.header[0], "contribution_date");
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0]?.[3], 'Note with a comma, a "quote" and a\nnewline');

    db.close();
  });

  test("a dump reflects the current state rather than a cached one", async () => {
    const { db, app } = await seededApp();
    createContribution(db, { contributionDate: "2026-09-01", amountNzd: 100, source: "manual" });

    const dump = await (await app.request("/api/export/json")).json() as any;
    assert.equal(dump.counts.contributions, 2);
    assert.equal(dump.counts.netContributions, netContributions(db));

    db.close();
  });
});

describe("backup", () => {
  test("name includes the timestamp and is filesystem-safe", () => {
    const name = backupFileName(new Date("2026-09-28T04:05:06.789Z"));
    assert.equal(name, "sharesies-2026-09-28T04-05-06Z.db");
    assert.ok(!name.includes(":"), "colons are not legal in a Windows filename");
    assert.equal(backupFileName(new Date("2026-09-28T04:05:06.789Z"), "manual"), "sharesies-2026-09-28T04-05-06Z-manual.db");
  });

  test("copies a live database and verifies the copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "sharesies-backup-"));
    const db = openDb({ path: join(dir, "live.db") });
    db.exec("CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, value_nzd REAL)");
    db.prepare("INSERT INTO snapshots (value_nzd) VALUES (?)").run(1234.56);

    const result = backupDatabase(db, { dir, now: new Date("2026-09-28T04:05:06.789Z") });

    assert.ok(existsSync(result.path));
    assert.equal(result.integrity, "ok", "the copy must pass its own integrity check");
    assert.equal(result.snapshots, 1);
    assert.ok(result.bytes > 0);
    assert.equal(statSync(result.path).size, result.bytes);
    assert.deepEqual(result.pruned, []);

    // The copy is a real, openable database with the data in it.
    const copy = openDb({ path: result.path });
    const row = copy.prepare("SELECT value_nzd FROM snapshots").get() as { value_nzd: number };
    assert.equal(row.value_nzd, 1234.56);
    copy.close();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps the newest N backups and deletes the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "sharesies-prune-"));
    const db = openDb({ path: join(dir, "live.db") });
    db.exec("CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY)");

    for (const day of ["01", "02", "03", "04", "05"]) {
      backupDatabase(db, { dir, now: new Date(`2026-09-${day}T00:00:00.000Z`), keep: 3 });
    }

    const remaining = listBackups(dir).map((backup) => backup.name);
    assert.equal(remaining.length, 3);
    assert.deepEqual(remaining, [
      "sharesies-2026-09-05T00-00-00Z.db",
      "sharesies-2026-09-04T00-00-00Z.db",
      "sharesies-2026-09-03T00-00-00Z.db",
    ]);

    // Pruning is by name order, which is also chronological for this format.
    assert.deepEqual(pruneBackups(dir, 1).length, 2);
    assert.equal(listBackups(dir).length, 1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a path with a quote cannot break out of the SQL literal", () => {
    const dir = mkdtempSync(join(tmpdir(), "sharesies-quote-"));
    const db = openDb({ path: join(dir, "live.db") });
    db.exec("CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY)");

    // "it's" would terminate a naive string literal; doubling the quote is the
    // documented escape and must produce a file, not a syntax error.
    const awkward = join(dir, "it's a backup");
    const result = backupDatabase(db, { dir: awkward, now: new Date("2026-09-28T00:00:00.000Z") });

    assert.ok(existsSync(result.path));
    assert.equal(result.integrity, "ok");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
