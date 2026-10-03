import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/server.ts";
import { collectOnce } from "../src/collector/collect.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import { loadFixture, testDb } from "./helpers.ts";

// The request logger would otherwise spam the test reporter.
process.env["QUIET"] = "1";
// No Akahu tokens in tests, so the collector falls back to the manual source.
delete process.env["PORTFOLIO_SOURCE"];
delete process.env["AKAHU_APP_TOKEN"];
delete process.env["AKAHU_USER_TOKEN"];

const NOW = new Date("2026-09-28T04:00:00.000Z");
/** The calendar date the seeded history lands on, so the summary can be judged against it. */
const TODAY = "2026-09-28";

function fakeSource(fixture: string): PortfolioSource {
  const raw = loadFixture(fixture);
  return {
    name: "akahu",
    fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
  };
}

/** An app backed by an in-memory database already holding one day of history. */
async function seededApp() {
  const db = testDb();
  await collectOnce(db, { source: fakeSource("accounts.sharesies-portfolio.sample.json"), now: NOW });
  // The clock is pinned so "stale" means what the test means by it: staleness is
  // measured in hours since the source refreshed, so a fixture refreshed on a fixed
  // date goes stale simply because the suite is run later.
  return { db, app: createApp(db, { today: TODAY, now: NOW }) };
}

async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("GET /api/summary reports value, goal, milestones and sync health", async () => {
  const { db, app } = await seededApp();

  const created = await app.request("/api/goals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "House deposit",
      targetAmountNzd: 100000,
      targetDate: "2028-01-01",
      withPercentMilestones: true,
    }),
  });
  assert.equal(created.status, 201);

  const response = await app.request("/api/summary");
  assert.equal(response.status, 200);
  const summary = await json(response);

  assert.equal(summary.currentValue, 18844.7);
  assert.equal(summary.currency, "NZD");
  assert.equal(summary.goal.name, "House deposit");
  assert.equal(summary.goal.progressPct, 18.8);
  assert.equal(summary.goal.remaining, 81155.3);
  assert.equal(summary.milestones.length, 4);
  assert.equal(summary.nextMilestone.amountNzd, 25000);
  assert.equal(summary.nextMilestone.state, "next");

  assert.equal(summary.syncHealth.stale, false);
  assert.equal(summary.syncHealth.lastSnapshotDate, "2026-09-28");
  // All three accounts are listed, including the ANZ one that is out of scope.
  assert.equal(summary.syncHealth.accounts.length, 3);
  assert.equal(summary.syncHealth.excludedAccounts.length, 1);
  assert.equal(summary.syncHealth.daysCollected, 1);
  assert.equal(summary.dataMode, "akahu");

  db.close();
});

test("GET /api/snapshots returns the totalled series", async () => {
  const { db, app } = await seededApp();

  const series = await json(await app.request("/api/snapshots"));
  assert.equal(series.points.length, 1);
  assert.equal(series.points[0].value, 18844.7);
  assert.equal(series.last, 18844.7);

  const perAccount = await json(await app.request("/api/snapshots?perAccount=1"));
  assert.equal(perAccount.snapshots.length, 2);

  db.close();
});

test("GET /api/holdings/latest reports allocation and the unavailable case", async () => {
  const { db, app } = await seededApp();

  const holdings = await json(await app.request("/api/holdings/latest"));
  assert.equal(holdings.available, true);
  assert.equal(holdings.holdings.length, 3);
  assert.equal(holdings.totalValue, 18432.55);
  assert.equal(holdings.holdings[0].symbol, "USF");
  assert.equal(holdings.holdings[0].sharePct, 55.6);

  // A balance-only payload leaves the donut with nothing to draw.
  const empty = await json(
    await app.request("/api/holdings/latest?unused=", { method: "GET" }),
  );
  assert.equal(empty.available, true);

  db.close();
});

test("goal and milestone CRUD round-trips", async () => {
  const { db, app } = await seededApp();

  const post = async (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const goalResponse = await post("/api/goals", { name: "First 50k", targetAmountNzd: 50000 });
  const { goal } = await json(goalResponse);
  assert.equal(goal.progressBasis, "value");
  assert.equal(goal.targetDate, null);

  const milestoneResponse = await post(`/api/goals/${goal.id}/milestones`, {
    label: "Emergency buffer",
    amountNzd: 25000,
    notes: "6 months of expenses",
  });
  const { milestone } = await json(milestoneResponse);
  assert.equal(milestone.kind, "custom");
  assert.equal(milestone.firstReachedOn, null);

  const patched = await json(
    await app.request(`/api/milestones/${milestone.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Buffer", amountNzd: 26000 }),
    }),
  );
  assert.equal(patched.milestone.label, "Buffer");
  assert.equal(patched.milestone.amountNzd, 26000);

  const goalPatch = await json(
    await app.request(`/api/goals/${goal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetDate: "2027-06-30", progressBasis: "contributions" }),
    }),
  );
  assert.equal(goalPatch.goal.targetDate, "2027-06-30");
  assert.equal(goalPatch.goal.progressBasis, "contributions");

  const deleted = await app.request(`/api/milestones/${milestone.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);

  const gone = await app.request(`/api/milestones/${milestone.id}`, { method: "DELETE" });
  assert.equal(gone.status, 404);

  const goalDeleted = await app.request(`/api/goals/${goal.id}`, { method: "DELETE" });
  assert.equal(goalDeleted.status, 200);

  db.close();
});

test("percent milestones can be generated as a set", async () => {
  const { db, app } = await seededApp();

  const { goal } = await json(
    await app.request("/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "100k", targetAmountNzd: 100000 }),
    }),
  );

  const response = await app.request(`/api/goals/${goal.id}/milestones`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ percent: [25, 50, 100] }),
  });
  assert.equal(response.status, 201);

  const { milestones } = await json(response);
  assert.deepEqual(milestones.map((m: { amountNzd: number }) => m.amountNzd), [25000, 50000, 100000]);
  assert.deepEqual(milestones.map((m: { kind: string }) => m.kind), ["percent", "percent", "percent"]);

  db.close();
});

test("contributions can be logged and totalled", async () => {
  const { db, app } = await seededApp();

  const add = (body: unknown) =>
    app.request("/api/contributions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await add({ contributionDate: "2026-07-01", amountNzd: 1000 })).status, 201);
  assert.equal((await add({ contributionDate: "2026-08-01", amountNzd: 250, source: "csv" })).status, 201);

  const listed = await json(await app.request("/api/contributions"));
  assert.equal(listed.contributions.length, 2);
  assert.equal(listed.totalAllTime, 1250);
  assert.equal(listed.contributions[1].source, "csv");

  const ranged = await json(await app.request("/api/contributions?from=2026-08-01"));
  assert.equal(ranged.total, 250);

  db.close();
});

test("GET /api/projection returns three scenarios and per-milestone ETAs", async () => {
  const { db, app } = await seededApp();

  const { goal } = await json(
    await app.request("/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "100k by 2030",
        targetAmountNzd: 100000,
        targetDate: "2030-09-28",
        withPercentMilestones: true,
      }),
    }),
  );

  const projection = await json(await app.request("/api/projection?return=0.07&monthly=1000&months=60"));

  assert.match(projection.disclaimer, /not predictions or financial advice/);
  assert.equal(projection.assumptions.startValue, 18844.7);
  assert.equal(projection.assumptions.months, 60);

  assert.deepEqual(projection.scenarios.map((s: { key: string }) => s.key), ["low", "base", "high"]);
  assert.deepEqual(projection.scenarios.map((s: { annualReturn: number }) => s.annualReturn), [0.05, 0.07, 0.09]);
  assert.equal(projection.scenarios[1].points.length, 61);

  const first = projection.milestones[0];
  assert.equal(first.label, "25% of goal");
  assert.ok(first.etaDates.low && first.etaDates.high);
  // A higher assumed return can only bring the date forward.
  assert.ok(first.etaDates.high <= first.etaDates.low);

  assert.equal(projection.goal.id, goal.id);
  assert.ok(projection.goal.requiredMonthly > 0);

  // Query overrides are reflected, and the horizon is clamped.
  const clamped = await json(await app.request("/api/projection?months=99999"));
  assert.equal(clamped.assumptions.months, 600);

  db.close();
});

test("settings expose and update the projection assumptions", async () => {
  const { db, app } = await seededApp();

  const initial = await json(await app.request("/api/settings"));
  assert.equal(initial.assumptions.annualReturn, 0.07);
  assert.equal(initial.source.effective, "manual");
  assert.equal(initial.source.akahuConfigured, false);
  assert.equal(initial.source.connectionMatch, "sharesies");

  const updated = await json(
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ annualReturn: 0.08 }),
    }),
  );
  assert.equal(updated.assumptions.annualReturn, 0.08);
  assert.equal(updated.assumptions.monthlyContribution, 500);

  const outOfRange = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ annualReturn: 12 }),
  });
  assert.equal(outOfRange.status, 400);

  const empty = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);

  db.close();
});

test("POST /api/manual-value records a value and collects a snapshot", async () => {
  const db = testDb();
  const app = createApp(db);

  const response = await app.request("/api/manual-value", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: 4321.5 }),
  });

  assert.equal(response.status, 201);
  const body = await json(response);
  assert.equal(body.manualValueNzd, 4321.5);
  assert.equal(body.collection.status, "ok");
  assert.equal(body.collection.value, 4321.5);

  const summary = await json(await app.request("/api/summary"));
  assert.equal(summary.currentValue, 4321.5);
  assert.equal(summary.dataMode, "manual");

  db.close();
});

test("POST /api/sync is rate limited, and refuses to overlap", async () => {
  const { db, app } = await seededApp();

  // Fresh app, so no sync has been requested yet.
  const first = await app.request("/api/sync", { method: "POST" });
  assert.equal(first.status, 200);

  const second = await app.request("/api/sync", { method: "POST" });
  assert.equal(second.status, 409);
  assert.ok(Number(second.headers.get("retry-after")) > 0);

  db.close();
});

test("POST /api/refresh explains the 1 hour rest period instead of failing blindly", async () => {
  const { db, app } = await seededApp();

  const response = await app.request("/api/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 409);
  const body = await json(response);
  assert.match(body.error, /tokens are not configured/);

  db.close();
});

test("validation errors and unknown endpoints return JSON", async () => {
  const { db, app } = await seededApp();

  const invalid = await app.request("/api/goals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "", targetAmountNzd: -5 }),
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await json(invalid);
  assert.ok(invalidBody.error);
  assert.ok(Object.keys(invalidBody.details).length > 0);

  const notJson = await app.request("/api/goals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  assert.equal(notJson.status, 400);

  const unknown = await app.request("/api/nope");
  assert.equal(unknown.status, 404);
  assert.match((await json(unknown)).error, /No such endpoint/);

  const badGoal = await app.request("/api/goals/999", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  assert.equal(badGoal.status, 404);

  db.close();
});

test("GET /api/health summarises the snapshot store", async () => {
  const { db, app } = await seededApp();

  const health = await json(await app.request("/api/health"));
  assert.equal(health.status, "ok");
  assert.equal(health.snapshotCount, 3);
  assert.equal(health.sync.accounts.length, 3);

  db.close();
});
