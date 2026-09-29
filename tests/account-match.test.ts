import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchPortfolio, matchPortfolios, normaliseAccountName } from "../src/import/account-match.ts";

/**
 * The accounts a Sharesies connection exposes through Akahu, as they are named, and
 * the portfolio names the transaction report uses for them.
 */
const ACCOUNTS = [
  { accountId: "acc_investments", accountName: "Ben's Investments" },
  { accountId: "acc_highgrowth", accountName: "Ben's High-growth portfolio" },
];

describe("normaliseAccountName", () => {
  test("keeps letters and digits, so punctuation and case stop mattering", () => {
    assert.equal(normaliseAccountName("Ben's Investments"), "bensinvestments");
    assert.equal(normaliseAccountName("High-growth portfolio"), "highgrowthportfolio");
    assert.equal(normaliseAccountName("  Mixed Case  "), "mixedcase");
  });
});

describe("matchPortfolio", () => {
  test("matches the report's portfolio names to the accounts they mean", () => {
    const investments = matchPortfolio("Investments", ACCOUNTS);
    assert.equal(investments.accountId, "acc_investments");
    assert.equal(investments.accountName, "Ben's Investments");
    assert.equal(investments.status, "partial");

    const highGrowth = matchPortfolio("High-growth portfolio", ACCOUNTS);
    assert.equal(highGrowth.accountId, "acc_highgrowth");
    assert.equal(highGrowth.status, "partial");
  });

  test("prefers an exact name when there is one", () => {
    const match = matchPortfolio("Ben's Investments", ACCOUNTS);
    assert.equal(match.status, "exact");
    assert.equal(match.accountId, "acc_investments");
  });

  test("refuses to guess when two accounts could be meant", () => {
    const match = matchPortfolio("Sharesies", [
      { accountId: "a", accountName: "Sharesies Growth" },
      { accountId: "b", accountName: "Sharesies Income" },
    ]);
    assert.equal(match.accountId, null);
    assert.equal(match.status, "ambiguous");
    assert.deepEqual(match.candidates, ["Sharesies Growth", "Sharesies Income"]);
  });

  test("an unknown portfolio resolves to nothing rather than the closest thing", () => {
    const match = matchPortfolio("KiwiSaver", ACCOUNTS);
    assert.equal(match.accountId, null);
    assert.equal(match.status, "none");
    assert.deepEqual(match.candidates, []);
  });

  test("a very short portfolio name is not used for containment", () => {
    // "In" is contained in both accounts; matching it would be a guess, not a match.
    const match = matchPortfolio("In", ACCOUNTS);
    assert.equal(match.accountId, null);
    assert.equal(match.status, "none");
  });

  test("an empty portfolio is not a match", () => {
    assert.equal(matchPortfolio("", ACCOUNTS).accountId, null);
    assert.equal(matchPortfolio("   ", ACCOUNTS).status, "none");
  });
});

describe("matchPortfolios", () => {
  test("resolves each distinct name once, in the order they appear", () => {
    const matches = matchPortfolios(["Investments", "High-growth portfolio", "Investments"], ACCOUNTS);
    assert.deepEqual(matches.map((match) => match.portfolio), ["Investments", "High-growth portfolio"]);
  });

  test("drops the blank name a file has when a column is present but empty", () => {
    assert.deepEqual(matchPortfolios(["", "Investments"], ACCOUNTS).length, 1);
  });
});
