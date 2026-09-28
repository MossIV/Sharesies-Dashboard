import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildImportPlan,
  classifyRow,
  detectColumns,
  detectDateFormat,
  importableRows,
  normaliseHeader,
  parseAmountCell,
  parseCsv,
  parseDateCell,
} from "../src/import/csv.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const read = (name: string): string => readFileSync(resolve(REPO_ROOT, "fixtures", name), "utf8");

describe("parseCsv", () => {
  test("reads quoted fields, embedded commas and doubled quotes", () => {
    const parsed = parseCsv('a,b\n"one, two","say ""hi"""\n');
    assert.deepEqual(parsed.header, ["a", "b"]);
    assert.deepEqual(parsed.rows, [["one, two", 'say "hi"']]);
    assert.equal(parsed.delimiter, ",");
  });

  test("sniffs a semicolon delimiter and tolerates commas inside values", () => {
    const parsed = parseCsv("a;b\n1;1,234.56\n");
    assert.equal(parsed.delimiter, ";");
    assert.deepEqual(parsed.rows, [["1", "1,234.56"]]);
  });

  test("handles CRLF, a BOM and a trailing blank line", () => {
    const parsed = parseCsv("\uFEFFdate,amount\r\n2026-01-15,500.00\r\n\r\n");
    assert.deepEqual(parsed.header, ["date", "amount"]);
    assert.equal(parsed.rows.length, 1);
  });

  test("handles a newline inside a quoted field", () => {
    const parsed = parseCsv('a,b\n"line one\nline two",2\n');
    assert.deepEqual(parsed.rows, [["line one\nline two", "2"]]);
  });

  test("counts ragged rows rather than silently padding them", () => {
    const parsed = parseCsv("a,b,c\n1,2,3\n4,5\n");
    assert.equal(parsed.raggedRows, 1);
  });
});

describe("detectColumns", () => {
  test("matches the sample report's headers", () => {
    const parsed = parseCsv(read("sharesies-transaction-report.sample.csv"));
    const columns = detectColumns(parsed.header);
    assert.equal(columns.date, 0);
    assert.equal(columns.type, 1);
    assert.equal(columns.description, 2);
    assert.equal(columns.amount, 3);
    assert.equal(columns.balance, 4);
    assert.equal(columns.units, 5);
    assert.equal(columns.price, 6);
    assert.equal(columns.symbol, 7);
  });

  test("matches a different layout and a decorated header", () => {
    const columns = detectColumns(["Transaction amount (NZD)", "Date/time", "Details"]);
    assert.equal(columns.amount, 0);
    assert.equal(columns.date, 1);
    assert.equal(columns.description, 2);
  });

  test("normalises punctuation and case", () => {
    assert.equal(normaliseHeader("Transaction Date "), "transactiondate");
    assert.equal(normaliseHeader("Amount ($)"), "amount");
  });
});

describe("classifyRow", () => {
  test("classifies the categories the report actually contains", () => {
    assert.equal(classifyRow("Top up", "Top up from bank account").category, "deposit");
    assert.equal(classifyRow("Buy", "Buy Vanguard").category, "buy");
    assert.equal(classifyRow("Order Buy", "Market buy – Vanguard").category, "buy");
    assert.equal(classifyRow("Sell", "Sell Smartshares").category, "sell");
    assert.equal(classifyRow("Dividend", "Dividend reinvestment").category, "dividend");
    assert.equal(classifyRow("Fee", "Annual fund charge").category, "fee");
    assert.equal(classifyRow("Withdrawal", "Withdrawal to bank account").category, "withdrawal");
    assert.equal(classifyRow("Interest payment", "Interest on cash").category, "interest");
  });

  test("'Deposit' outranks 'transfer' keywords in the same string", () => {
    // "Transfer in" is a deposit; a bare "transfer" is a movement.
    assert.equal(classifyRow("Deposit", "Transfer in from bank").category, "deposit");
    assert.equal(classifyRow("Transfer", "Wallet to investment").category, "transfer");
  });

  test("an unrecognised row is unknown, not a guess", () => {
    const result = classifyRow("Mystery", "something else entirely");
    assert.equal(result.category, "unknown");
    assert.equal(result.matched, null);
  });

  test("reports which keyword matched", () => {
    assert.equal(classifyRow("Top up", "").matched, "top up");
  });

  test("keywords match whole words, not fragments", () => {
    // "invest" must not match inside "investment".
    assert.equal(classifyRow("Transfer", "Wallet to investment").category, "transfer");
    assert.equal(classifyRow("Order", "Auto-invest order").category, "buy");
    // ...and "interest" must not match inside "interested", though a plural
    // "fees" should still be a fee.
    assert.equal(classifyRow("Note", "customer interested in interest").category, "interest");
    assert.equal(classifyRow("Note", "management fees applied").category, "fee");
    assert.equal(classifyRow("Note", "deposits received").category, "deposit");
  });
});

describe("detectDateFormat and parseDateCell", () => {
  test("ISO dates are unambiguous", () => {
    assert.deepEqual(detectDateFormat(["2026-01-15", "2026-02-15"]), { format: "iso", ambiguous: false });
    assert.deepEqual(parseDateCell("2026-01-15", "iso"), { date: "2026-01-15", ambiguous: false });
  });

  test("a day above 12 proves day/month/year", () => {
    assert.deepEqual(detectDateFormat(["03/04/2026", "18/04/2026"]), { format: "dmy", ambiguous: false });
    assert.deepEqual(parseDateCell("18/04/2026", "dmy"), { date: "2026-04-18", ambiguous: false });
  });

  test("a first field above 12 proves month/day/year", () => {
    assert.deepEqual(detectDateFormat(["03/04/2026", "04/18/2026"]), { format: "mdy", ambiguous: false });
    assert.deepEqual(parseDateCell("04/18/2026", "mdy"), { date: "2026-04-18", ambiguous: false });
  });

  test("an all-ambiguous file defaults to day/month/year AND says so", () => {
    const detected = detectDateFormat(["03/04/2026", "05/04/2026"]);
    assert.deepEqual(detected, { format: "dmy", ambiguous: true });
    // 03/04/2026 is 3 April under the NZ convention.
    assert.equal(parseDateCell("03/04/2026", "dmy").date, "2026-04-03");
  });

  test("reads month names and two-digit years", () => {
    assert.equal(parseDateCell("3 Apr 2026", "named").date, "2026-04-03");
    assert.equal(parseDateCell("15-Jan-26", "named").date, "2026-01-15");
  });

  test("rejects an impossible calendar date", () => {
    assert.equal(parseDateCell("31/02/2026", "dmy").date, null);
  });

  test("returns null rather than a guess for junk", () => {
    assert.equal(parseDateCell("not a date", "dmy").date, null);
    assert.equal(parseDateCell("", "dmy").date, null);
  });
});

describe("parseAmountCell", () => {
  test("reads the formats an export is likely to use", () => {
    assert.equal(parseAmountCell("500.00"), 500);
    assert.equal(parseAmountCell("-250.00"), -250);
    assert.equal(parseAmountCell("1,234.56"), 1234.56);
    assert.equal(parseAmountCell("$1,234.56"), 1234.56);
    assert.equal(parseAmountCell("(350.00)"), -350, "brackets mean negative");
    assert.equal(parseAmountCell("−350.00"), -350, "unicode minus");
  });

  test("returns null for anything it cannot read", () => {
    assert.equal(parseAmountCell(""), null);
    assert.equal(parseAmountCell("n/a"), null);
  });
});

describe("buildImportPlan on the sample report", () => {
  const parsed = parseCsv(read("sharesies-transaction-report.sample.csv"));
  const plan = buildImportPlan(parsed);

  test("counts every category present in the file", () => {
    assert.equal(plan.counts.deposit, 4);
    assert.equal(plan.counts.buy, 2);
    assert.equal(plan.counts.dividend, 1);
    assert.equal(plan.counts.fee, 1);
    assert.equal(plan.counts.withdrawal, 1);
  });

  test("imports deposits only, by default", () => {
    const rows = importableRows(plan);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.amountNzd), [500, 500, 500, 750]);
    assert.deepEqual(rows.map((row) => row.date), [
      "2026-01-15", "2026-02-15", "2026-03-15", "2026-05-15",
    ]);
  });

  test("imports buys as positive contributions when asked explicitly", () => {
    const rows = importableRows(plan, { categories: ["deposit", "buy"] });
    assert.equal(rows.length, 6);
    const buy = rows.find((row) => row.category === "buy");
    assert.equal(buy?.amountNzd, 250, "a -250 buy becomes a 250 contribution");
  });

  test("references are stable across re-imports of the same file", () => {
    const again = buildImportPlan(parseCsv(read("sharesies-transaction-report.sample.csv")));
    assert.deepEqual(
      again.candidates.map((candidate) => candidate.externalRef),
      plan.candidates.map((candidate) => candidate.externalRef),
    );
  });

  test("references differ between rows that differ", () => {
    const refs = new Set(plan.candidates.map((candidate) => candidate.externalRef));
    assert.equal(refs.size, plan.candidates.length);
  });

  test("no row is marked as a problem in a well-formed file", () => {
    assert.deepEqual(plan.candidates.filter((candidate) => candidate.problem !== null), []);
  });
});

describe("buildImportPlan warnings", () => {
  test("says so when there are no deposits at all", () => {
    const csv = 'Date,Type,Description,Amount\n2026-02-18,Buy,Buy Vanguard,-250.00\n';
    const plan = buildImportPlan(parseCsv(csv));
    assert.equal(importableRows(plan).length, 0);
    assert.ok(
      plan.warnings.some((warning) => warning.includes("covers buy and sell transactions")),
      plan.warnings.join(" | "),
    );
  });

  test("flags an all-ambiguous date column", () => {
    const plan = buildImportPlan(parseCsv(read("sharesies-report-variant.sample.csv")));
    assert.equal(plan.dateFormat, "dmy");
    assert.equal(plan.dateAmbiguous, true);
    assert.ok(plan.warnings.some((warning) => warning.includes("ambiguous")), plan.warnings.join(" | "));
  });

  test("an explicit dateFormat silences the ambiguity and changes the dates", () => {
    const parsed = parseCsv(read("sharesies-report-variant.sample.csv"));
    const plan = buildImportPlan(parsed, { dateFormat: "mdy" });
    assert.equal(plan.dateAmbiguous, false);
    assert.equal(plan.candidates[0]?.date, "2026-03-04", "03/04 read as March 4");
  });

  test("warns when the columns needed to do anything are missing", () => {
    const plan = buildImportPlan(parseCsv("Foo,Bar\n1,2\n"));
    assert.equal(plan.columns.date, undefined);
    assert.ok(plan.warnings.some((warning) => warning.includes("No date column")));
    assert.ok(plan.warnings.some((warning) => warning.includes("No amount column")));
    assert.deepEqual(plan.unrecognisedColumns, ["Foo", "Bar"]);
  });

  test("flags ragged rows", () => {
    const plan = buildImportPlan(parseCsv("Date,Type,Description,Amount\n2026-01-15,Top up,Top up,500\n2026-01-16,Top up\n"));
    assert.equal(plan.raggedRows, 1);
    assert.ok(plan.warnings.some((warning) => warning.includes("same number of columns")));
  });

  test("a row with an unreadable date is reported, not imported", () => {
    const csv = "Date,Type,Description,Amount\nnot-a-date,Top up,Top up,500.00\n";
    const plan = buildImportPlan(parseCsv(csv));
    assert.equal(importableRows(plan).length, 0);
    assert.equal(plan.candidates[0]?.problem, "Could not read the date.");
  });
});

describe("buildImportPlan on the variant layout", () => {
  const plan = buildImportPlan(parseCsv(read("sharesies-report-variant.sample.csv")));

  test("finds the deposits through the different column names", () => {
    const rows = importableRows(plan);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.date), ["2026-04-03", "2026-04-07"]);
    assert.deepEqual(rows.map((row) => row.amountNzd), [400, 400]);
  });

  test("a bracketed negative is read as a negative, and the buy is not a deposit", () => {
    const buy = plan.candidates.find((candidate) => candidate.category === "buy");
    assert.equal(buy?.amountNzd, 350);
    assert.equal(buy?.date, "2026-04-05");
  });

  test("a semicolon inside a quoted narrative does not split the row", () => {
    const buy = plan.candidates.find((candidate) => candidate.category === "buy");
    assert.ok(buy?.description.includes("settled T+2"), buy?.description);
  });
});
