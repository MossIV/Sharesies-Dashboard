/**
 * The basis in force, end to end: the rule, the resolution order, and the totals the
 * API reports against it.
 *
 * The case underneath all of this is one portfolio showing $8,013.91 of contributions
 * against a value of $5,211.51, because $5,300 of detected bank transfers and the
 * $2,713.91 of buys they funded were both being counted.
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/server.ts";
import { resolveContributionsBasis, setContributionsBasis } from "../src/api/settings.ts";
import { collectOnce } from "../src/collector/collect.ts";
import { createContribution, listContributions, netContributions } from "../src/db/repo.ts";
import { isExternalFlow } from "../src/domain/contributions-basis.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import { loadFixture, testDb } from "./helpers.ts";

process.env["QUIET"] = "1";
delete process.env["PORTFOLIO_SOURCE"];
delete process.env["AKAHU_APP_TOKEN"];
delete process.env["AKAHU_USER_TOKEN"];
delete process.env["CONTRIBUTIONS_BASIS"];

const NOW = new Date("2026-09-28T04:00:00.000Z");
const TODAY = "2026-09-28";

const savedEnv = process.env["CONTRIBUTIONS_BASIS"];
beforeEach(() => {
  delete process.env["CONTRIBUTIONS_BASIS"];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env["CONTRIBUTIONS_BASIS"];
  else process.env["CONTRIBUTIONS_BASIS"] = savedEnv;
});

function fakeSource(fixture: string): PortfolioSource {
  const raw = loadFixture(fixture);
  return {
    name: "akahu",
    fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
  };
}

async function seededApp() {
  const db = testDb();
  await collectOnce(db, { source: fakeSource("accounts.sharesies-portfolio.sample.json"), now: NOW });
  return { db, app: createApp(db, { today: TODAY, now: NOW }) };
}

interface Logged {
  contributionDate: string;
  amountNzd: number;
  source?: "manual" | "csv" | "bank";
  category?: string | null;
}

/** One of every kind the rule has to tell apart. */
const ROWS: Logged[] = [
  { contributionDate: "2026-07-01", amountNzd: 100, source: "manual" },
  { contributionDate: "2026-07-05", amountNzd: 200, source: "bank" },
  { contributionDate: "2026-07-10", amountNzd: 300, source: "csv", category: "buy" },
  { contributionDate: "2026-07-15", amountNzd: 400, source: "csv", category: "deposit" },
  { contributionDate: "2026-07-20", amountNzd: -50, source: "csv", category: "withdrawal" },
  { contributionDate: "2026-07-25", amountNzd: 60, source: "csv", category: "transfer" },
  { contributionDate: "2026-07-30", amountNzd: 70, source: "csv", category: null },
];

function seed(db: ReturnType<typeof testDb>) {
  for (const row of ROWS) createContribution(db, row);
}

/** 100 manual + 200 bank + 400 deposit - 50 withdrawal. The rest are internal. */
const EXTERNAL_TOTAL = 650;
const TRADES_TOTAL = 1080;

describe("the SQL and the domain rule agree", () => {
  test("exactly the rows the domain calls external are the rows SQL counts", async () => {
    const { db } = await seededApp();
    seed(db);

    const counted = listContributions(db, { scope: "goal", basis: "external" });
    const expected = listContributions(db, { scope: "goal" }).filter(isExternalFlow);

    assert.deepEqual(
      counted.map((row) => row.id),
      expected.map((row) => row.id),
      "two implementations of one rule, so this is what keeps them from drifting",
    );
    assert.equal(netContributions(db, { basis: "external" }), EXTERNAL_TOTAL);
    assert.equal(netContributions(db), TRADES_TOTAL, "the trades basis is the old behaviour, unchanged");
  });
});

describe("resolveContributionsBasis", () => {
  test("auto picks external flows when there are any", async () => {
    const { db } = await seededApp();
    seed(db);
    const resolution = resolveContributionsBasis(db);
    assert.equal(resolution.basis, "external");
    assert.equal(resolution.requested, "auto");
    assert.equal(resolution.source, "auto");
    assert.equal(resolution.hasExternalRows, true);
  });

  test("auto falls back to trades when nothing external has been logged", async () => {
    const { db } = await seededApp();
    createContribution(db, { contributionDate: "2026-07-10", amountNzd: 300, source: "csv", category: "buy" });

    const resolution = resolveContributionsBasis(db);
    assert.equal(resolution.basis, "trades");
    assert.equal(resolution.hasExternalRows, false);
    assert.equal(
      netContributions(db, { basis: resolution.basis }),
      300,
      "a history with no bank feed still has a figure, and the card says it is a proxy",
    );
  });

  test("the environment is used when nothing is stored", async () => {
    const { db } = await seededApp();
    seed(db);
    process.env["CONTRIBUTIONS_BASIS"] = "trades";

    const resolution = resolveContributionsBasis(db);
    assert.equal(resolution.basis, "trades");
    assert.equal(resolution.source, "environment");
  });

  test("a stored setting wins over the environment", async () => {
    const { db } = await seededApp();
    seed(db);
    process.env["CONTRIBUTIONS_BASIS"] = "trades";
    setContributionsBasis(db, "external");

    const resolution = resolveContributionsBasis(db);
    assert.equal(resolution.basis, "external");
    assert.equal(resolution.source, "setting");
  });

  test("an explicit auto hands the decision back to the rule, not to today's answer", async () => {
    const { db } = await seededApp();
    createContribution(db, { contributionDate: "2026-07-10", amountNzd: 300, source: "csv", category: "buy" });
    setContributionsBasis(db, "auto");

    assert.equal(resolveContributionsBasis(db).basis, "trades", "no external rows, so auto stays on the proxy");

    // The same stored setting, once there is something external to count: the rule
    // decides again, rather than the setting having pinned whatever it resolved to
    // when it was saved.
    createContribution(db, { contributionDate: "2026-07-15", amountNzd: 400, source: "csv", category: "deposit" });
    const after = resolveContributionsBasis(db);
    assert.equal(after.basis, "external");
    assert.equal(after.requested, "auto");
    assert.equal(after.source, "auto", "the rule decided, so it is reported as the rule's doing");
  });
});

describe("GET /api/contributions reports what it counted", () => {
  test("the totals, the counts and the per-row flags all follow the basis", async () => {
    const { db, app } = await seededApp();
    seed(db);

    const body = await (await app.request("/api/contributions")).json() as any;

    assert.equal(body.basis, "external");
    assert.equal(body.basisSource, "auto");
    assert.match(body.basisNote, /money sent to Sharesies/);
    assert.equal(body.totalAllTime, EXTERNAL_TOTAL);

    assert.equal(body.counts.all, ROWS.length);
    assert.equal(body.counts.inGoal, ROWS.length);
    assert.equal(body.counts.counted, 4, "manual, bank, deposit, withdrawal");
    assert.equal(body.counts.inGoalNotCounted, 3, "the buy, the wallet transfer and the category-less row");
    assert.equal(body.counts.excluded, 0);

    // The row that caused the original bug: in the goal, and a movement inside the
    // platform rather than money arriving from outside.
    const buy = body.contributions.find((row: any) => row.category === "buy");
    assert.equal(buy.inGoal, true);
    assert.equal(buy.counted, false);
    assert.equal(buy.source, "csv");
  });

  test("the chart series and the headline total describe the same rows", async () => {
    const { db, app } = await seededApp();
    seed(db);

    const body = await (await app.request("/api/contributions")).json() as any;
    assert.equal(
      body.series.latest.contributions,
      body.totalAllTime,
      "a graph and a number that disagree is the bug this whole change came from",
    );
    assert.equal(body.series.latest.contributions, EXTERNAL_TOTAL);
  });

  test("the summary's figure follows the same basis, so the header cannot disagree with the chart", async () => {
    const { db, app } = await seededApp();
    seed(db);

    const summary = await (await app.request("/api/summary")).json() as any;
    const listed = await (await app.request("/api/contributions")).json() as any;
    assert.equal(summary.netContributions, listed.totalAllTime);
    assert.equal(summary.netContributions, EXTERNAL_TOTAL);
  });
});

describe("PUT /api/settings switches the basis", () => {
  test("switching to trades changes the total, and auto returns it to the rule", async () => {
    const { db, app } = await seededApp();
    seed(db);

    const before = await (await app.request("/api/contributions")).json() as any;
    assert.equal(before.totalAllTime, EXTERNAL_TOTAL);

    const switched = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contributionsBasis: "trades" }),
    });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json() as any).contributions.basis, "trades");

    const after = await (await app.request("/api/contributions")).json() as any;
    assert.equal(after.totalAllTime, TRADES_TOTAL);
    assert.equal(after.basisSource, "setting");

    const back = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contributionsBasis: "auto" }),
    });
    assert.equal(back.status, 200);
    const restored = await (await app.request("/api/contributions")).json() as any;
    assert.equal(restored.totalAllTime, EXTERNAL_TOTAL);
    assert.equal(restored.basisSource, "auto");
  });

  test("a nonsense basis is refused rather than stored", async () => {
    const { app } = await seededApp();
    const response = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contributionsBasis: "cash" }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as any).error, /contributionsBasis/);
  });
});
