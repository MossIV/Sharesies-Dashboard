/**
 * The blend behind the projection's default return.
 *
 * The numbers in these tests are the portfolio's real holdings by value, because the
 * figure the projection uses is an allocation-weighted average and the allocation is
 * the whole point: a flat 7% for a portfolio that is 95% equities and 5% bonds ignores
 * the thing that decides the answer.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_CLASS_RETURNS,
  FUND_OBSERVATIONS,
  OBSERVATIONS_AS_OF,
  blendAssumedReturn,
  findObservation,
} from "../src/domain/fund-returns.ts";
import { replaceHoldings, upsertAccount, upsertSnapshot } from "../src/db/repo.ts";
import { DEFAULT_ANNUAL_RETURN, resolveAnnualReturn, getAssumptions } from "../src/api/settings.ts";
import { setSetting } from "../src/db/client.ts";
import type { DatabaseSync } from "node:sqlite";
import { testDb } from "./helpers.ts";

/** The portfolio from the holdings screen: value per fund, in dollars. */
const PORTFOLIO = [
  { symbol: "TWH", value: 1160.64 },
  { symbol: "TWF", value: 773.92 },
  { symbol: "AUS", value: 322.46 },
  { symbol: "NZG", value: 318.80 },
  { symbol: "AGG", value: 94.98 },
  { symbol: "NZB", value: 33.92 },
  { symbol: "NZC", value: 6.78 },
];

const near = (actual: number | null, expected: number, tolerance = 0.0005): void => {
  assert.ok(actual !== null, "expected a number, got null");
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, got ${actual}`,
  );
};

describe("the observation table", () => {
  test("covers every fund the portfolio holds", () => {
    for (const holding of PORTFOLIO) {
      assert.ok(findObservation(holding.symbol), `${holding.symbol} is missing from the table`);
    }
  });

  test("symbols are unique and uppercase", () => {
    const symbols = FUND_OBSERVATIONS.map((fund) => fund.symbol);
    assert.equal(new Set(symbols).size, symbols.length);
    assert.ok(symbols.every((symbol) => symbol === symbol.toUpperCase()));
  });

  test("returns and volatilities are plausible rates, not percentages", () => {
    for (const fund of FUND_OBSERVATIONS) {
      assert.ok(fund.sinceInception > -1 && fund.sinceInception < 1, `${fund.symbol} sinceInception`);
      assert.ok(fund.volatility > 0 && fund.volatility < 1, `${fund.symbol} volatility`);
      assert.ok(fund.years > 0, `${fund.symbol} years`);
      assert.ok(fund.since < OBSERVATIONS_AS_OF, `${fund.symbol} starts after the as-of date`);
    }
  });

  test("the portfolio's observed return sits above the assumption, which is the point", () => {
    // The two figures are kept separate because recent history is not a forecast. At
    // portfolio level that means the observation is the higher of the two; if someone
    // ever raises the assumption past it, they should have to justify deleting this.
    const blend = blendAssumedReturn(PORTFOLIO);
    assert.ok(blend.rate !== null && blend.observedRate !== null);
    assert.ok(
      blend.rate < blend.observedRate,
      `assumption ${blend.rate} is not below the observed ${blend.observedRate}`,
    );
  });

  test("the assumption is NOT below every fund, which is why it is a class figure", () => {
    // NZG returned 3.4% a year over its observed window: below the 7% equity
    // assumption. A six-year window on one market says little about the next twenty,
    // so the assumption is made per asset class and the per-fund evidence is shown
    // beside it rather than averaged into it.
    const nzg = findObservation("NZG");
    assert.ok(nzg);
    assert.equal(nzg.assetClass, "equity");
    assert.ok(
      nzg.sinceInception < ASSET_CLASS_RETURNS.equity.rate,
      "if NZG now beats the equity assumption, this note is stale and should be revisited",
    );
  });

  test("every asset class has a forward assumption with a reason", () => {
    for (const [name, assumption] of Object.entries(ASSET_CLASS_RETURNS)) {
      assert.ok(assumption.rate > 0 && assumption.rate < 0.2, `${name} rate`);
      assert.ok(assumption.rationale.length > 40, `${name} needs a real rationale`);
    }
  });
});

describe("blendAssumedReturn", () => {
  test("weights the assumption by value", () => {
    const blend = blendAssumedReturn(PORTFOLIO);

    // 95.0% equity at 7%, 4.8% bonds at 3.5%, 0.3% cash at 3%.
    near(blend.rate, 0.0682, 0.0005);
    assert.equal(blend.covered, 1);
    assert.deepEqual(blend.unmatched, []);
  });

  test("reports the observed blend beside the assumption, which is the point of it", () => {
    const blend = blendAssumedReturn(PORTFOLIO);
    near(blend.observedRate, 0.1074, 0.002);
    assert.ok(
      (blend.observedRate ?? 0) > (blend.rate ?? 0) * 1.4,
      "the observed figure should be well above the assumption; if it is not, the rationale changed",
    );
  });

  test("a shift towards bonds lowers the blended figure", () => {
    const conservative = blendAssumedReturn([
      { symbol: "TWH", value: 500 },
      { symbol: "NZB", value: 500 },
    ]);
    near(conservative.rate, (0.07 + 0.035) / 2);
    assert.ok((conservative.rate ?? 0) < (blendAssumedReturn(PORTFOLIO).rate ?? 1));
  });

  test("weights are shares of the matched value and sum to one", () => {
    const blend = blendAssumedReturn(PORTFOLIO);
    const total = blend.holdings.reduce((sum, holding) => sum + holding.weight, 0);
    near(total, 1, 1e-9);
    assert.equal(blend.holdings[0]?.symbol, "TWH", "largest holding first");
    near(blend.holdings[0]?.weight ?? 0, 1160.64 / 2711.5, 0.0001);
  });

  test("each holding carries both the assumption and the observation", () => {
    const blend = blendAssumedReturn(PORTFOLIO);
    const twh = blend.holdings.find((holding) => holding.symbol === "TWH");
    assert.equal(twh?.assetClass, "equity");
    assert.equal(twh?.assumedReturn, ASSET_CLASS_RETURNS.equity.rate);
    assert.equal(twh?.observedReturn, 0.129);
  });

  test("an unknown fund does not drag the answer down, and lowers the coverage", () => {
    // Treating an unknown symbol as 0% would quietly understate the projection.
    const blend = blendAssumedReturn([...PORTFOLIO, { symbol: "XYZ", value: 1000 }]);
    near(blend.rate, 0.0682, 0.0005);
    assert.ok(blend.covered < 1);
    near(blend.covered, 2711.5 / 3711.5, 0.001);
    assert.deepEqual(blend.unmatched, ["XYZ"]);
  });

  test("a holding with no symbol is reported, not silently dropped", () => {
    const blend = blendAssumedReturn([{ symbol: "TWF", value: 100 }, { symbol: null, value: 100 }]);
    near(blend.rate, 0.07);
    assert.equal(blend.covered, 0.5);
    assert.deepEqual(blend.unmatched, ["(no symbol)"]);
  });

  test("no holdings, or no valued holdings, gives no rate rather than a guess", () => {
    for (const holdings of [[], [{ symbol: "TWF", value: null }], [{ symbol: "TWF", value: 0 }]]) {
      const blend = blendAssumedReturn(holdings);
      assert.equal(blend.rate, null);
      assert.equal(blend.observedRate, null);
      assert.equal(blend.covered, 0);
      assert.deepEqual(blend.holdings, []);
    }
  });

  test("lower case symbols still match", () => {
    near(blendAssumedReturn([{ symbol: "twf", value: 100 }]).rate, 0.07);
  });

  test("the volatility blend is a rate, not a percentage, and sits between its parts", () => {
    const blend = blendAssumedReturn(PORTFOLIO);
    const parts = blend.holdings.map((holding) => holding.weight * (findObservation(holding.symbol)?.volatility ?? 0));
    near(blend.volatility, parts.reduce((a, b) => a + b, 0), 1e-9);
    assert.ok((blend.volatility ?? 0) > 0.05 && (blend.volatility ?? 0) < 0.25);
  });
});

/** A database holding the portfolio's funds, so the resolution has something to weight. */
function dbWithHoldings(): DatabaseSync {
  const db = testDb();
  upsertAccount(db, {
    accountId: "acc_goal", accountName: "High-growth portfolio", connectionName: "Sharesies",
    accountType: "INVESTMENT", currency: "NZD", status: "ACTIVE", defaultInScope: true,
  });
  const snapshotId = upsertSnapshot(db, {
    snapshotDate: OBSERVATIONS_AS_OF, accountId: "acc_goal", accountName: "High-growth portfolio",
    valueNzd: 2711.5, currency: "NZD", sourceRefreshedAt: null, status: "ACTIVE",
    source: "akahu", createdAt: `${OBSERVATIONS_AS_OF}T00:00:00.000Z`,
  });
  replaceHoldings(db, snapshotId, PORTFOLIO.map((holding) => ({
    symbol: holding.symbol,
    name: findObservation(holding.symbol)?.name ?? holding.symbol,
    units: 1,
    value: holding.value,
  })));
  return db;
}

describe("the return the projection actually uses", () => {
  test("with holdings and nothing set, it is derived from the allocation", () => {
    delete process.env["ASSUMED_ANNUAL_RETURN"];
    const db = dbWithHoldings();
    const resolution = resolveAnnualReturn(db);

    assert.equal(resolution.source, "derived");
    near(resolution.rate, 0.0682, 0.0001);
    near(resolution.derived, 0.0682, 0.0001);
    near(resolution.observed, 0.1074, 0.002);
    assert.equal(resolution.covered, 1);
    // getAssumptions is the door everything else uses, so it has to agree.
    near(getAssumptions(db).annualReturn, resolution.rate, 1e-9);

    db.close();
  });

  test("with no holdings at all, it falls back to the built-in default and says so", () => {
    delete process.env["ASSUMED_ANNUAL_RETURN"];
    const db = testDb();
    const resolution = resolveAnnualReturn(db);

    assert.equal(resolution.source, "default");
    assert.equal(resolution.rate, DEFAULT_ANNUAL_RETURN);
    assert.equal(resolution.derived, null);
    assert.equal(resolution.observed, null);
    assert.equal(resolution.covered, 0);

    db.close();
  });

  test("a figure the user set wins over the derived one", () => {
    delete process.env["ASSUMED_ANNUAL_RETURN"];
    const db = dbWithHoldings();
    setSetting(db, "assumed_annual_return", "0.05");

    const resolution = resolveAnnualReturn(db);
    assert.equal(resolution.source, "setting");
    assert.equal(resolution.rate, 0.05);
    // The derived figure is still reported, so the UI can show what was overridden.
    near(resolution.derived, 0.0682, 0.0001);

    db.close();
  });

  test("the environment beats the derived figure but loses to a setting", () => {
    const db = dbWithHoldings();

    process.env["ASSUMED_ANNUAL_RETURN"] = "0.09";
    assert.equal(resolveAnnualReturn(db).source, "environment");
    assert.equal(resolveAnnualReturn(db).rate, 0.09);

    setSetting(db, "assumed_annual_return", "0.04");
    assert.equal(resolveAnnualReturn(db).source, "setting");
    assert.equal(resolveAnnualReturn(db).rate, 0.04);

    delete process.env["ASSUMED_ANNUAL_RETURN"];
    db.close();
  });

  test("a blank environment value counts as unset, as it does everywhere else", () => {
    const db = dbWithHoldings();
    process.env["ASSUMED_ANNUAL_RETURN"] = "   ";
    assert.equal(resolveAnnualReturn(db).source, "derived");
    delete process.env["ASSUMED_ANNUAL_RETURN"];
    db.close();
  });
});
