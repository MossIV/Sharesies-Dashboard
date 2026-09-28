import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHoldings, extractItems, normalizeAccounts, num, str } from "../src/sources/parse-akahu.ts";
import { loadFixture } from "./helpers.ts";

test("num accepts numbers, numeric strings and { amount } wrappers", () => {
  assert.equal(num(12.5), 12.5);
  assert.equal(num("1,234.50"), 1234.5);
  assert.equal(num({ amount: 42 }), 42);
  assert.equal(num(null), null);
  assert.equal(num(""), null);
  assert.equal(num("abc"), null);
});

test("str returns null for empty strings and objects", () => {
  assert.equal(str("x"), "x");
  assert.equal(str("  "), null);
  assert.equal(str(0), "0");
  assert.equal(str({}), null);
});

test("extractItems tolerates the standard envelope and a bare array", () => {
  assert.deepEqual(extractItems({ success: true, items: [1, 2] }), [1, 2]);
  assert.deepEqual(extractItems([1, 2]), [1, 2]);
  assert.deepEqual(extractItems({ success: true }), []);
  assert.deepEqual(extractItems(null), []);
});

test("normalizeAccounts parses the Sharesies fixture", () => {
  const accounts = normalizeAccounts(loadFixture("accounts.sharesies-portfolio.sample.json"));
  assert.equal(accounts.length, 3);

  const investment = accounts.find((a) => a.accountId === "acc_sharesies_investment_0001");
  assert.ok(investment);
  assert.equal(investment.connectionName, "Sharesies");
  assert.equal(investment.accountType, "INVESTMENT");
  assert.equal(investment.valueNzd, 18432.55);
  assert.equal(investment.currency, "NZD");
  assert.equal(investment.status, "ACTIVE");
  assert.equal(investment.sourceRefreshedAt, "2026-09-28T02:11:04.000Z");
  assert.equal(investment.holdings.length, 3);
  assert.equal(investment.holdings[0]?.symbol, "USF");
  assert.equal(investment.holdings[0]?.units, 120.5);
  assert.equal(investment.holdings[0]?.value, 10250.75);
});

test("normalizeAccounts handles the awkward documented shapes", () => {
  const accounts = normalizeAccounts(loadFixture("accounts.sharesies-regressions.sample.json"));

  // An account with no balance has nothing to record and is dropped.
  assert.equal(accounts.length, 3);
  assert.equal(accounts.some((a) => a.accountId === "acc_sharesies_novalue_0001"), false);

  const stringBalance = accounts.find((a) => a.accountId === "acc_sharesies_balance_only_0001");
  assert.equal(stringBalance?.valueNzd, 9402.1);
  // Falls back to refreshed.meta when refreshed.balance is absent.
  assert.equal(stringBalance?.sourceRefreshedAt, "2026-09-28T02:11:04.000Z");
  assert.deepEqual(stringBalance?.holdings, []);

  const inactive = accounts.find((a) => a.accountId === "acc_sharesies_inactive_0001");
  assert.equal(inactive?.status, "INACTIVE");
  assert.equal(inactive?.holdings.length, 1);
  assert.equal(inactive?.holdings[0]?.symbol, "FNZ");
  assert.equal(inactive?.holdings[0]?.name, "Smartshares NZ Top 50 ETF");

  const nested = accounts.find((a) => a.accountId === "acc_sharesies_nested_0001");
  assert.equal(nested?.valueNzd, 1500.5);
  assert.equal(nested?.holdings.length, 1);
  assert.equal(nested?.holdings[0]?.name, "Smartshares US 500 ETF");
});

test("extractHoldings returns [] rather than throwing on unusable meta", () => {
  assert.deepEqual(extractHoldings(undefined), []);
  assert.deepEqual(extractHoldings({ holder: "W WONG" }), []);
  assert.deepEqual(extractHoldings({ portfolio: [] }), []);
  assert.deepEqual(extractHoldings({ portfolio: "nonsense" }), []);
});
