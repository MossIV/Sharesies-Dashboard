import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { contributionSeries } from "../src/domain/contributions.ts";

const points = (...values: number[]) =>
  values.map((value, index) => ({ date: `2026-03-0${index + 1}`, value }));

describe("contributionSeries", () => {
  test("each row satisfies value = contributions + growth", () => {
    const series = contributionSeries({
      points: points(100, 150, 220),
      contributions: [
        { contributionDate: "2026-03-01", amountNzd: 100 },
        { contributionDate: "2026-03-02", amountNzd: 25 },
      ],
    });

    assert.deepEqual(series.rows, [
      { date: "2026-03-01", value: 100, contributions: 100, growth: 0 },
      { date: "2026-03-02", value: 150, contributions: 125, growth: 25 },
      { date: "2026-03-03", value: 220, contributions: 125, growth: 95 },
    ]);
    assert.equal(series.belowContributions, false);
    assert.equal(series.maxShortfall, 0);
  });

  test("contributions after a snapshot are not counted in it", () => {
    const series = contributionSeries({
      points: points(100, 200),
      contributions: [{ contributionDate: "2026-03-02", amountNzd: 100 }],
    });

    assert.equal(series.rows[0]?.contributions, 0, "nothing has arrived yet on day one");
    assert.equal(series.rows[1]?.contributions, 100);
  });

  test("contributions are accumulated once, in date order, whatever order they arrive in", () => {
    const series = contributionSeries({
      points: points(50, 300),
      contributions: [
        { contributionDate: "2026-03-02", amountNzd: 200 },
        { contributionDate: "2026-03-01", amountNzd: 50 },
      ],
    });

    assert.equal(series.rows[0]?.contributions, 50);
    assert.equal(series.rows[1]?.contributions, 250);
  });

  test("a withdrawal is a negative contribution and reduces the running total", () => {
    const series = contributionSeries({
      points: points(100, 60),
      contributions: [
        { contributionDate: "2026-03-01", amountNzd: 100 },
        { contributionDate: "2026-03-02", amountNzd: -40 },
      ],
    });

    assert.equal(series.rows[1]?.contributions, 60);
    assert.equal(series.rows[1]?.growth, 0);
  });

  test("growth below zero is reported, not hidden — a stacked area cannot draw it", () => {
    // The shape that broke the chart: contributions summed across more portfolios
    // than the value covers.
    const series = contributionSeries({
      points: [{ date: "2026-09-29", value: 214.33 }],
      contributions: [{ contributionDate: "2026-09-24", amountNzd: 8657.6 }],
    });

    assert.equal(series.rows[0]?.growth, -8443.27);
    assert.equal(series.belowContributions, true);
    assert.equal(series.maxShortfall, 8443.27);
  });

  test("the largest shortfall is the one reported", () => {
    const series = contributionSeries({
      points: points(10, 5, 90),
      contributions: [
        { contributionDate: "2026-03-01", amountNzd: 100 },
        { contributionDate: "2026-03-03", amountNzd: -100 },
      ],
    });

    // Day 2 is 5 − 100 = −95; day 1 is −90.
    assert.equal(series.maxShortfall, 95);
  });

  test("an empty history is empty rather than a crash", () => {
    const series = contributionSeries({ points: [], contributions: [{ contributionDate: "2026-03-01", amountNzd: 10 }] });
    assert.deepEqual(series.rows, []);
    assert.equal(series.latest, null);
    assert.equal(series.belowContributions, false);
  });

  test("amounts are rounded to cents", () => {
    const series = contributionSeries({
      points: [{ date: "2026-03-01", value: 123.456 }],
      contributions: [{ contributionDate: "2026-03-01", amountNzd: 0.005 }],
    });

    assert.equal(series.rows[0]?.value, 123.46);
    assert.equal(series.rows[0]?.contributions, 0.01);
    assert.equal(series.rows[0]?.growth, 123.45);
  });
});
