/**
 * The rule that decides which logged rows count as contributions.
 *
 * The case these were written against is real: one portfolio showed $8,013.91 of
 * contributions against a value of $5,211.51, because $5,300 of detected bank
 * transfers and the $2,713.91 of buys they funded were both being counted. The same
 * money, twice.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_CATEGORIES,
  isExternalFlow,
  parseBasis,
  resolveBasis,
} from "../src/domain/contributions-basis.ts";

describe("isExternalFlow", () => {
  test("hand-entered and bank-detected rows are external, whatever they say", () => {
    assert.equal(isExternalFlow({ source: "manual", category: null }), true);
    assert.equal(isExternalFlow({ source: "bank", category: null }), true);
    assert.equal(isExternalFlow({ source: "bank", category: "transfer" }), true);
  });

  test("a report row is external only when its category crosses the boundary", () => {
    for (const category of EXTERNAL_CATEGORIES) {
      assert.equal(isExternalFlow({ source: "csv", category }), true, category);
    }
    for (const category of ["buy", "sell", "dividend", "fee", "interest", "transfer"]) {
      assert.equal(isExternalFlow({ source: "csv", category }), false, category);
    }
  });

  test("a wallet-to-investment movement is internal, not a contribution", () => {
    // The classifier buckets "Wallet to investment" as a transfer, and counting it
    // would add a movement between two of your own pockets to what you put in.
    assert.ok(!EXTERNAL_CATEGORIES.includes("transfer"));
    assert.equal(isExternalFlow({ source: "csv", category: "transfer" }), false);
  });

  test("a report row with no category is not assumed to be external", () => {
    // Rows from the importer written before categories existed. Guessing "deposit"
    // would put trades into the contributions total, which is the bug being fixed.
    assert.equal(isExternalFlow({ source: "csv", category: null }), false);
  });

  test("an unrecognised source is not counted as external", () => {
    assert.equal(isExternalFlow({ source: "demo", category: "deposit" }), false);
    assert.equal(isExternalFlow({ source: "unknown", category: null }), false);
  });
});

describe("resolveBasis", () => {
  test("an explicit choice is honoured", () => {
    assert.equal(resolveBasis("external", { hasExternalRows: false }), "external");
    assert.equal(resolveBasis("trades", { hasExternalRows: true }), "trades");
  });

  test("auto prefers external flows when there are any", () => {
    assert.equal(resolveBasis("auto", { hasExternalRows: true }), "external");
  });

  test("auto falls back to trades when there is nothing external to count", () => {
    // A history that predates the bank feed: buys are all there is, and showing zero
    // contributions would be worse than showing the proxy.
    assert.equal(resolveBasis("auto", { hasExternalRows: false }), "trades");
  });
});

describe("parseBasis", () => {
  test("reads the three accepted values, and nothing else", () => {
    assert.equal(parseBasis("external"), "external");
    assert.equal(parseBasis(" TRADES "), "trades");
    assert.equal(parseBasis("auto"), "auto");
    assert.equal(parseBasis(""), null);
    assert.equal(parseBasis(undefined), null);
    assert.equal(parseBasis("cash"), null);
  });
});

describe("the case this exists for", () => {
  /** The real rows: eight detected bank transfers, and the report buys they funded. */
  const transfers = Array.from({ length: 8 }, () => ({ source: "bank", category: null }));
  const buys = Array.from({ length: 38 }, () => ({ source: "csv", category: "buy" }));

  test("under the external basis the transfers count and the buys they funded do not", () => {
    const counted = [...transfers, ...buys].filter(isExternalFlow);
    assert.equal(counted.length, 8, "the eight transfers, and none of the buys");
    assert.ok(counted.every((row) => row.source === "bank"));
  });

  test("under the trades basis there is no extra filter, which is how both came to count", () => {
    // The trades basis is the existing behaviour: everything in scope counts, so
    // $5,300 of transfers and the $2,713.91 of buys they funded both landed in the
    // total. That is the $8,013.91 shown against a $5,211.51 value.
    assert.equal([...transfers, ...buys].length, 46);
    assert.equal([...transfers, ...buys].filter(isExternalFlow).length, 8);
  });

  test("a sell is not money out, because the cash stays inside the platform", () => {
    assert.equal(isExternalFlow({ source: "csv", category: "sell" }), false);
    assert.equal(isExternalFlow({ source: "csv", category: "withdrawal" }), true);
    assert.equal(isExternalFlow({ source: "manual", category: null }), true);
  });
});
