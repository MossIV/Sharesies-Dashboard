import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPortfolioAccounts, totalValue } from "../src/collector/select-accounts.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import { loadFixture } from "./helpers.ts";

function accounts() {
  return normalizeAccounts(loadFixture("accounts.sharesies-portfolio.sample.json"));
}

test("selects Sharesies INVESTMENT and WALLET, and ignores other connections", () => {
  const selected = selectPortfolioAccounts(accounts());
  assert.deepEqual(selected.map((a) => a.accountId).sort(), [
    "acc_sharesies_investment_0001",
    "acc_sharesies_wallet_0001",
  ]);
});

test("can be narrowed to a single account type", () => {
  const selected = selectPortfolioAccounts(accounts(), { accountTypes: ["INVESTMENT"] });
  assert.deepEqual(selected.map((a) => a.accountId), ["acc_sharesies_investment_0001"]);
});

test("a malformed connection matcher is escaped rather than thrown", () => {
  assert.equal(selectPortfolioAccounts(accounts(), { connectionMatch: "sharesies(" }).length, 0);
});

test("totalValue sums the selected accounts and reports health", () => {
  const totals = totalValue(selectPortfolioAccounts(accounts()));
  assert.equal(Math.round(totals.value * 100) / 100, 18844.7);
  assert.equal(totals.currency, "NZD");
  assert.equal(totals.hasInactive, false);
  assert.equal(totals.mixedCurrency, false);
  assert.equal(totals.holdings.length, 3);
});

test("totalValue flags an inactive account and a mixed currency", () => {
  const base = normalizeAccounts(loadFixture("accounts.sharesies-regressions.sample.json"));
  const selected = selectPortfolioAccounts(base);

  const totals = totalValue(selected);
  assert.equal(totals.hasInactive, true);

  const withUsd = [{ ...selected[0]!, currency: "USD" }, selected[1]!];
  assert.equal(totalValue(withUsd).mixedCurrency, true);
});
