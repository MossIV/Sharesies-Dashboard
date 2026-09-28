/**
 * The real Akahu response, as captured by the Phase 0 spike (`npm run spike`).
 *
 * The other fixtures were written by hand from the docs; this one is the thing
 * itself, so it is what catches a parser that is only right about the shape we
 * imagined. Redacted before it was written (ids, account numbers and the payment
 * reference are placeholders); the structure, key names and values are untouched.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractItems, normalizeAccounts } from "../src/sources/parse-akahu.ts";
import { selectPortfolioAccounts, totalValue } from "../src/collector/select-accounts.ts";
import { FIXTURES } from "./helpers.ts";

/**
 * The file is git-ignored on purpose: it is a redacted real response, but the
 * balances and holdings are the real ones, so it is a financial statement rather
 * than a fixture. It only exists on a machine that has run `npm run spike`, so
 * these tests skip when it is absent instead of failing a fresh clone.
 */
const REAL_FIXTURE = join(FIXTURES, "akahu-accounts.real.json");
const available = existsSync(REAL_FIXTURE);
const skip = available
  ? false
  : "run `npm run spike` first: the fixture is git-ignored because it holds real balances";

const raw = available ? (JSON.parse(readFileSync(REAL_FIXTURE, "utf8")) as unknown) : { success: true, items: [] };

describe("the real Akahu accounts response", { skip }, () => {
  test("is the two-account Sharesies connection it was captured from", () => {
    const items = extractItems(raw);
    assert.equal(items.length, 2);

    const connections = items.map((item) => (item as Record<string, Record<string, unknown>>)["connection"]?.["name"]);
    assert.deepEqual(connections, ["Sharesies", "Sharesies"], "both accounts come from one connection");
  });

  test("normalizes both accounts with their balances", () => {
    const accounts = normalizeAccounts(raw);
    assert.equal(accounts.length, 2);

    const investments = accounts.find((account) => account.accountName === "Ben's Investments");
    const highGrowth = accounts.find((account) => account.accountName === "Ben's High-growth portfolio");
    assert.ok(investments && highGrowth, "both named accounts must survive normalization");

    assert.equal(investments.accountType, "INVESTMENT");
    assert.equal(investments.status, "ACTIVE");
    assert.equal(investments.currency, "NZD");
    assert.equal(investments.valueNzd, 13400.5);
    assert.equal(highGrowth.valueNzd, 214.33);

    // `balance.current` is the value; `meta.breakdown.returns` must not be mistaken for it.
    assert.notEqual(investments.valueNzd, 4854.79);
  });

  test("reads every holding out of meta.portfolio", () => {
    const accounts = normalizeAccounts(raw);
    const investments = accounts.find((account) => account.accountName === "Ben's Investments")!;
    const highGrowth = accounts.find((account) => account.accountName === "Ben's High-growth portfolio")!;

    assert.equal(investments.holdings.length, 24);
    assert.equal(highGrowth.holdings.length, 7);

    const largest = investments.holdings.reduce((max, holding) =>
      (holding.value ?? 0) > (max.value ?? 0) ? holding : max);
    assert.equal(largest.name, "Smart US 500 ETF");
    assert.equal(largest.symbol, "USF");
    assert.equal(largest.value, 2786.06);
    assert.equal(largest.units, 117.84);

    // The holdings of the smaller account are the index funds it is built from.
    const names = highGrowth.holdings.map((holding) => holding.name);
    assert.ok(names.includes("Smart Total World ETF"), names.join(", "));
  });

  test("carries a refresh timestamp for balance and meta", () => {
    const accounts = normalizeAccounts(raw);
    for (const account of accounts) {
      assert.match(account.sourceRefreshedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test("both accounts are in scope by default, and the total is their sum", () => {
    const accounts = normalizeAccounts(raw);
    const selected = selectPortfolioAccounts(accounts);
    assert.equal(selected.length, 2, "INVESTMENT accounts under a Sharesies connection are in scope");

    const total = totalValue(selected);
    assert.equal(total.value, 13614.83);
    assert.equal(total.currency, "NZD");
    assert.equal(total.mixedCurrency, false);
    assert.equal(total.hasInactive, false);
    assert.equal(total.holdings.length, 31);
  });

  test("the redaction left no account number or payment reference behind", () => {
    const text = JSON.stringify(raw);
    assert.ok(!/\d{2}-\d{4}-\d{7}-\d{2}/.test(text), "no NZ account number pattern");
    assert.ok(!/WW\d{6}/.test(text), "no Sharesies payment reference");
    assert.ok(!/acc_[a-z0-9]{20}/.test(text), "no raw account id");
    assert.ok(!/conn_[a-z0-9]{20}/.test(text), "no raw connection id");
    assert.ok(text.includes("<redacted:"), "the fixture is visibly redacted");
  });
});