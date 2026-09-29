import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { buildImportPlan, detectColumns, parseCsv } from "../src/import/csv.ts";
import { importSharesiesReport } from "../src/import/sharesies-report.ts";
import { upsertAccount, listContributions, netContributions } from "../src/db/repo.ts";
import type { FxPoint, FxProvider } from "../src/import/fx.ts";
import { testDb, FIXTURES } from "./helpers.ts";

const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/** A report's trades, as the real export writes them: mixed currency, two portfolios. */
const TRADES = read("sharesies-trade-report.sample.csv");
/** An older report layout: no portfolio column and no currency column. */
const DEPOSITS = read("sharesies-transaction-report.sample.csv");

/** A fixed rate, so a conversion is checked without a network call. */
const RATE_USD = 1.6;

class FixedRates implements FxProvider {
  readonly name = "fixed";
  async fetchRange(_base: string, _quote: string, from: string, to: string): Promise<FxPoint[]> {
    return [{ date: from, rate: RATE_USD }, { date: to, rate: RATE_USD }];
  }
}

class Offline implements FxProvider {
  readonly name = "offline";
  async fetchRange(): Promise<FxPoint[]> {
    throw new Error("getaddrinfo ENOTFOUND api.frankfurter.dev");
  }
}

/**
 * The live shape: a Sharesies connection with two accounts, the smaller one inside
 * the goal. The report's Portfolio column names them without the holder's name.
 */
function seededDb(): DatabaseSync {
  const db = testDb();
  upsertAccount(db, {
    accountId: "acc_investments", accountName: "Ben's Investments", connectionName: "Sharesies",
    accountType: "INVESTMENT", currency: "NZD", status: "ACTIVE", defaultInScope: false,
  });
  upsertAccount(db, {
    accountId: "acc_highgrowth", accountName: "Ben's High-growth portfolio", connectionName: "Sharesies",
    accountType: "INVESTMENT", currency: "NZD", status: "ACTIVE", defaultInScope: true,
  });
  return db;
}

const run = (
  db: DatabaseSync,
  csv: string,
  options: { categories?: string[]; provider?: FxProvider; mode?: "preview" | "apply" } = {},
) =>
  importSharesiesReport(db, {
    csv,
    filename: "report.csv",
    mode: options.mode ?? "apply",
    options: {
      ...(options.categories ? { categories: options.categories as never } : {}),
      fxProvider: options.provider ?? new FixedRates(),
    },
  });

describe("a report that states currency and portfolio", () => {
  test("recognises every column the real export carries", () => {
    const { header } = parseCsv(TRADES);
    const columns = detectColumns(header);

    assert.equal(columns.id, 0, "Trade ID");
    assert.equal(columns.date, 1, "Trade date, which carries a time and a (UTC) suffix");
    assert.equal(columns.symbol, 2, "Instrument code");
    assert.equal(columns.instrument, 3, "Instrument name — not the code beside it");
    assert.equal(columns.type, 7, "Transaction type");
    assert.equal(columns.currency, 8, "Currency");
    assert.equal(columns.amount, 9, "Amount");
    assert.equal(columns.fee, 10, "Transaction fee");
    assert.equal(columns.portfolio, 12, "Portfolio");
  });

  test("counts the rows per category and per currency", () => {
    const plan = buildImportPlan(parseCsv(TRADES), { categories: ["buy", "sell"] });

    assert.equal(plan.counts.buy, 4);
    assert.equal(plan.counts.sell, 2);
    assert.deepEqual(plan.currencies, { NZD: 3, USD: 3 });
    assert.deepEqual(plan.portfolios, ["High-growth portfolio", "Investments"]);
  });

  test("names the instrument in the note instead of its code", () => {
    const plan = buildImportPlan(parseCsv(TRADES), { categories: ["buy", "sell"] });
    const row = plan.candidates[0];

    assert.ok(row?.description.includes("Vanguard International Shares ETF"), row?.description);
    assert.equal(row?.instrumentName, "Vanguard International Shares ETF");
    assert.equal(row?.portfolio, "High-growth portfolio");
    assert.equal(row?.fee, 0.5, "the stated fee is carried for the report");
  });

  test("resolves both portfolios to the accounts they name", async () => {
    const db = seededDb();
    const outcome = await run(db, TRADES, { categories: ["buy", "sell"], mode: "preview" });

    assert.deepEqual(
      outcome.accounts.map((match) => [match.portfolio, match.accountName]),
      [["High-growth portfolio", "Ben's High-growth portfolio"], ["Investments", "Ben's Investments"]],
    );
    db.close();
  });
});

describe("converting and attributing the rows", () => {
  test("a USD row is converted at its own trade date's rate, and the rate is kept", async () => {
    const db = seededDb();
    await run(db, TRADES, { categories: ["buy", "sell"] });

    const usd = listContributions(db, { scope: "all" }).filter((row) => row.currency === "USD");
    assert.equal(usd.length, 3);
    const buy = usd.find((row) => row.category === "buy" && row.amountOriginal === 300);
    assert.equal(buy?.amountNzd, 300 * RATE_USD);
    assert.equal(buy?.amountOriginal, 300);
    assert.equal(buy?.fxRate, RATE_USD);
    assert.equal(buy?.currency, "USD");

    db.close();
  });

  test("buys add to the total and sells subtract from it", async () => {
    const db = seededDb();
    const outcome = await run(db, TRADES, { categories: ["buy", "sell"] });

    const inGoal = listContributions(db).filter((row) => row.accountId === "acc_highgrowth");
    assert.deepEqual(
      inGoal.map((row) => [row.category, row.amountNzd]),
      [["buy", 250], ["sell", -104], ["buy", 3.6]],
    );
    assert.equal(outcome.selected.length, 6, "a sell is importable, which it was not before");
    db.close();
  });

  test("rows for an account outside the goal are logged and kept out of the goal's total", async () => {
    const db = seededDb();
    const outcome = await run(db, TRADES, { categories: ["buy", "sell"] });

    // 250 − 104 + 3.60 in the goal; the other portfolio's 480 − 640 + 48 is everything else.
    assert.equal(netContributions(db), 149.6);
    assert.equal(netContributions(db, { scope: "all" }), 37.6);
    assert.equal(outcome.outsideGoal, 3);
    assert.equal(outcome.unattributed, 0);
    assert.equal(listContributions(db, { scope: "all" }).length, 6, "the log keeps the whole history");
    assert.equal(listContributions(db).length, 3, "the goal's view is the smaller one");
    assert.ok(
      outcome.warnings.some((warning) => warning.includes("outside the goal")),
      outcome.warnings.join(" | "),
    );

    db.close();
  });

  test("re-importing the same file adds nothing, keyed by the report's Trade ID", async () => {
    const db = seededDb();
    await run(db, TRADES, { categories: ["buy", "sell"] });
    const second = await run(db, TRADES, { categories: ["buy", "sell"] });

    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 6);
    assert.equal(listContributions(db, { scope: "all" }).length, 6);
    db.close();
  });

  test("two identical trades both survive, because the Trade ID tells them apart", async () => {
    const db = seededDb();
    const csv = [
      "Trade ID,Trade date,Instrument name,Transaction type,Currency,Amount,Portfolio",
      "id-one,2026-03-02 21:00:00 (UTC),Vanguard International Shares ETF,BUY,nzd,250.00,High-growth portfolio",
      "id-two,2026-03-02 21:00:00 (UTC),Vanguard International Shares ETF,BUY,nzd,250.00,High-growth portfolio",
    ].join("\n");

    const outcome = await run(db, csv, { categories: ["buy"] });
    assert.equal(outcome.imported, 2, "a content hash would have dropped one as a duplicate");
    db.close();
  });
});

describe("when the rate cannot be found", () => {
  test("the row is left out and reported, never counted at par", async () => {
    const db = seededDb();
    const outcome = await run(db, TRADES, { categories: ["buy", "sell"], provider: new Offline() });

    assert.equal(outcome.fx.unconverted, 3, "every USD row");
    assert.equal(outcome.imported, 3, "the NZD rows still import");
    assert.equal(netContributions(db), 149.6, "and nothing was counted at 1 USD = 1 NZD");
    assert.ok(
      outcome.warnings.some((warning) => warning.includes("no rate could be found")),
      outcome.warnings.join(" | "),
    );

    db.close();
  });

  test("a preview fetches rates too, so it describes the same calculation as an apply", async () => {
    const db = seededDb();
    const outcome = await run(db, TRADES, { categories: ["buy", "sell"], mode: "preview" });

    const usd = outcome.selected.filter((row) => row.currency === "USD");
    assert.equal(usd.length, 3);
    assert.ok(usd.every((row) => row.amountNzd === row.amount * RATE_USD));
    assert.equal(listContributions(db, { scope: "all" }).length, 0, "a preview writes nothing");

    db.close();
  });
});

describe("when the file cannot attribute its rows", () => {
  test("a file with no portfolio column follows the goal's single account", async () => {
    const db = seededDb();
    const outcome = await run(db, DEPOSITS, { mode: "apply" });

    assert.equal(outcome.attributedByDefault, 4);
    assert.equal(outcome.unattributed, 0);
    assert.equal(netContributions(db), 2250, "deposits that silently did not count would be worse");
    assert.ok(
      outcome.warnings.some((warning) => warning.includes("the only account in the goal")),
      outcome.warnings.join(" | "),
    );
    db.close();
  });

  test("a portfolio that matches no account is not attributed to the goal", async () => {
    const db = seededDb();
    const csv = [
      "Trade date,Instrument name,Transaction type,Currency,Amount,Portfolio",
      "2026-03-02 21:00:00 (UTC),Apple Inc,BUY,nzd,100.00,Someone Elses Portfolio",
      "2026-03-03 21:00:00 (UTC),Apple Inc,BUY,nzd,50.00,Someone Elses Portfolio",
    ].join("\n");

    const outcome = await run(db, csv, { categories: ["buy"] });

    assert.equal(outcome.unattributed, 2);
    assert.equal(netContributions(db), 0, "a portfolio the app cannot place must not move the goal");
    assert.equal(netContributions(db, { scope: "all" }), 150, "but it is still in the log");
    assert.ok(
      outcome.warnings.some((warning) => warning.includes("matches no account")),
      outcome.warnings.join(" | "),
    );

    const rows = listContributions(db, { scope: "all" });
    assert.equal(rows[0]?.accountId, null);
    assert.ok(rows[0]?.note?.includes("Apple Inc"), rows[0]?.note ?? "");

    db.close();
  });

  test("with no accounts registered at all, an imported report still counts", async () => {
    // A CSV-only install: there is no other portfolio the rows could belong to, so
    // holding them out of the goal would just drop them.
    const db = testDb();
    const outcome = await run(db, DEPOSITS, { mode: "apply" });

    assert.equal(outcome.imported, 4);
    assert.equal(netContributions(db), 2250);
    db.close();
  });
});
