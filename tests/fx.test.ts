import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadFxRates, cachedRateCount, type FxPoint, type FxProvider } from "../src/import/fx.ts";
import { testDb } from "./helpers.ts";

/** Stands in for the network: records what was asked for, returns fixed rates. */
class FakeProvider implements FxProvider {
  readonly name = "fake";
  readonly points: FxPoint[];
  readonly calls: string[] = [];

  constructor(points: FxPoint[]) {
    this.points = points;
  }

  async fetchRange(base: string, quote: string, from: string, to: string): Promise<FxPoint[]> {
    this.calls.push(`${base}/${quote} ${from}..${to}`);
    return this.points.filter((point) => point.date >= from && point.date <= to);
  }
}

class OfflineProvider implements FxProvider {
  readonly name = "offline";
  async fetchRange(): Promise<FxPoint[]> {
    throw new Error("getaddrinfo ENOTFOUND");
  }
}

describe("loadFxRates", () => {
  test("a date in the target currency needs no rate and no request", async () => {
    const db = testDb();
    const provider = new FakeProvider([]);
    const lookup = await loadFxRates(db, { base: "NZD", quote: "NZD", dates: ["2026-03-02"], provider });

    assert.equal(lookup.resolve("2026-03-02")?.rate, 1);
    assert.equal(lookup.source, "identity");
    assert.equal(lookup.requests, 0);
    assert.deepEqual(provider.calls, []);

    db.close();
  });

  test("fetches the whole range in one request, and the next import needs none", async () => {
    const db = testDb();
    const provider = new FakeProvider([
      { date: "2026-03-02", rate: 1.60 },
      { date: "2026-03-03", rate: 1.62 },
      { date: "2026-03-04", rate: 1.64 },
    ]);

    const first = await loadFxRates(db, { base: "USD", dates: ["2026-03-02", "2026-03-03", "2026-03-04"], provider });
    assert.equal(provider.calls.length, 1, "three dates, one request");
    assert.equal(first.resolve("2026-03-03")?.rate, 1.62);
    assert.deepEqual(first.unavailable, []);

    // A second import of an overlapping window hits the cache. The provider here
    // would fail, which is the point: nothing should be asked of it.
    const second = await loadFxRates(db, {
      base: "USD",
      dates: ["2026-03-02", "2026-03-04"],
      provider: new OfflineProvider(),
    });
    assert.equal(second.requests, 0);
    assert.equal(second.resolve("2026-03-04")?.rate, 1.64);
    assert.deepEqual(second.errors, []);
    assert.ok(cachedRateCount(db, "USD") >= 3);

    db.close();
  });

  test("a rate published on an earlier day is carried forward, and says which day it is from", async () => {
    const db = testDb();
    // 2026-03-06 is a Friday; the 8th is a Sunday.
    const provider = new FakeProvider([{ date: "2026-03-06", rate: 1.71 }]);
    const lookup = await loadFxRates(db, { base: "USD", dates: ["2026-03-08"], provider });

    const resolved = lookup.resolve("2026-03-08");
    assert.equal(resolved?.rate, 1.71);
    assert.equal(resolved?.rateDate, "2026-03-06", "the rate is Friday's, and the row says so");
    assert.equal(resolved?.exact, false);

    db.close();
  });

  test("the requested window is padded, so a Sunday can find the Friday before it", async () => {
    const db = testDb();
    const provider = new FakeProvider([{ date: "2026-03-06", rate: 1.71 }]);
    await loadFxRates(db, { base: "USD", dates: ["2026-03-08"], provider });

    assert.deepEqual(provider.calls, ["USD/NZD 2026-03-01..2026-03-08"]);

    db.close();
  });

  test("a rate that cannot be found is reported, never assumed to be 1", async () => {
    const db = testDb();
    const lookup = await loadFxRates(db, { base: "USD", dates: ["2026-03-02"], provider: new FakeProvider([]) });

    assert.equal(lookup.resolve("2026-03-02"), null);
    assert.deepEqual(lookup.unavailable, ["2026-03-02"]);
    assert.ok(lookup.errors.some((error) => error.includes("No USD/NZD rates")), lookup.errors.join(" | "));

    db.close();
  });

  test("an unreachable service leaves the dates unresolved rather than converting at par", async () => {
    const db = testDb();
    const lookup = await loadFxRates(db, { base: "USD", dates: ["2026-03-02"], provider: new OfflineProvider() });

    assert.equal(lookup.resolve("2026-03-02"), null);
    assert.deepEqual(lookup.unavailable, ["2026-03-02"]);
    assert.ok(lookup.errors.some((error) => error.includes("getaddrinfo")), lookup.errors.join(" | "));

    db.close();
  });

  test("conversion can be switched off entirely", async () => {
    const db = testDb();
    const lookup = await loadFxRates(db, { base: "USD", dates: ["2026-03-02"], provider: null });

    assert.equal(lookup.requests, 0);
    assert.equal(lookup.source, "none");
    assert.deepEqual(lookup.unavailable, ["2026-03-02"]);

    db.close();
  });
});
