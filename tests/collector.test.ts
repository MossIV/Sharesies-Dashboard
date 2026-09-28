import { test } from "node:test";
import assert from "node:assert/strict";
import { collectOnce } from "../src/collector/collect.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import { createGoal, createMilestone, listMilestones, listSnapshots, latestHoldings, latestSyncRun, recentSyncRuns } from "../src/db/repo.ts";
import { loadFixture, testDb } from "./helpers.ts";

function fakeSource(fixture: string, name = "akahu"): PortfolioSource {
  const raw = loadFixture(fixture);
  return {
    name,
    fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
  };
}

function failingSource(message = "boom"): PortfolioSource {
  return {
    name: "akahu",
    fetchAccounts: async () => {
      throw new Error(message);
    },
  };
}

/** A one-account source with a given value and refresh timestamp. */
function valueSource(value: number, sourceRefreshedAt: string | null = "2026-09-20T02:00:00.000Z"): PortfolioSource {
  return {
    name: "akahu",
    fetchAccounts: async () => ({
      endpoint: "/accounts",
      raw: { success: true, items: [] },
      accounts: [
        {
          accountId: "acc_fixed",
          accountName: "Sharesies",
          connectionName: "Sharesies",
          accountType: "INVESTMENT",
          valueNzd: value,
          currency: "NZD",
          status: "ACTIVE",
          sourceRefreshedAt,
          holdings: [],
          raw: { _id: "acc_fixed" },
        },
      ],
    }),
  };
}

const staleSource = (): PortfolioSource => valueSource(1000, "2026-09-20T02:00:00.000Z");

const NOW = new Date("2026-09-28T04:00:00.000Z");

test("collects a snapshot per matching account and stores holdings", async () => {
  const db = testDb();
  const result = await collectOnce(db, { source: fakeSource("accounts.sharesies-portfolio.sample.json"), now: NOW });

  assert.equal(result.status, "ok");
  assert.equal(result.snapshotDate, "2026-09-28");
  assert.equal(result.accountsSeen, 3);
  assert.equal(result.snapshotsWritten, 2, "ANZ is not a Sharesies account");
  assert.equal(result.value, 18844.7);
  assert.equal(result.stale, false);

  const snapshots = listSnapshots(db);
  assert.deepEqual(snapshots.map((s) => s.valueNzd), [18432.55, 412.15]);
  assert.equal(snapshots[0]?.sourceRefreshedAt, "2026-09-28T02:11:04.000Z");
  assert.equal(snapshots[0]?.source, "akahu");

  // Only the INVESTMENT account carries meta.portfolio.
  assert.equal(latestHoldings(db).length, 3);

  const run = latestSyncRun(db);
  assert.equal(run?.status, "ok");
  assert.equal(run?.snapshotsWritten, 2);
  assert.ok(run?.finishedAt);

  db.close();
});

test("the raw payload is stored before anything is derived from it", async () => {
  const db = testDb();
  await collectOnce(db, { source: fakeSource("accounts.sharesies-portfolio.sample.json"), now: NOW });

  const rows = db.prepare("SELECT endpoint, account_id FROM raw_fetches ORDER BY id").all() as {
    endpoint: string;
    account_id: string | null;
  }[];

  // One row for the whole response, then one per selected account.
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.endpoint, "/accounts");
  assert.equal(rows[0]?.account_id, null);
  assert.equal(rows[1]?.account_id, "acc_sharesies_investment_0001");
  assert.equal(rows[2]?.account_id, "acc_sharesies_wallet_0001");

  const payload = db.prepare("SELECT payload_json FROM raw_fetches WHERE id = 1").get() as { payload_json: string };
  assert.equal(JSON.parse(payload.payload_json).success, true);

  db.close();
});

test("running twice in one day updates the day's row instead of duplicating it", async () => {
  const db = testDb();
  const source = fakeSource("accounts.sharesies-portfolio.sample.json");

  await collectOnce(db, { source, now: NOW });
  await collectOnce(db, { source, now: NOW });
  await collectOnce(db, { source, now: NOW });

  assert.equal(listSnapshots(db).length, 2);
  assert.equal(recentSyncRuns(db).length, 3);
  db.close();
});

test("an INACTIVE account is flagged as stale with a reconnect hint", async () => {
  const db = testDb();
  const result = await collectOnce(db, {
    source: fakeSource("accounts.sharesies-regressions.sample.json"),
    now: NOW,
  });

  assert.equal(result.stale, true);
  assert.match(result.staleReason ?? "", /INACTIVE/);
  // The cached value is still recorded; only its freshness is in question.
  assert.equal(result.snapshotsWritten, 3);
  db.close();
});

test("data older than 48 hours is flagged as stale", async () => {
  const db = testDb();
  const result = await collectOnce(db, { source: staleSource(), now: NOW });
  assert.equal(result.stale, true);
  assert.match(result.staleReason ?? "", /hours old/);
  db.close();
});

test("a source failure is recorded rather than thrown", async () => {
  const db = testDb();
  const result = await collectOnce(db, { source: failingSource("Akahu request failed: 500"), now: NOW });

  assert.equal(result.status, "error");
  assert.equal(result.error, "Akahu request failed: 500");
  assert.equal(result.snapshotsWritten, 0);

  const run = latestSyncRun(db);
  assert.equal(run?.status, "error");
  assert.match(run?.error ?? "", /500/);
  db.close();
});

test("milestones are stamped with the first date the value reached them", async () => {
  const db = testDb();
  const goal = createGoal(db, { name: "House deposit", targetAmountNzd: 20000 });
  createMilestone(db, { goalId: goal.id, label: "$1k", amountNzd: 1000 });
  createMilestone(db, { goalId: goal.id, label: "$10k", amountNzd: 10000 });
  createMilestone(db, { goalId: goal.id, label: "$1m", amountNzd: 1_000_000 });

  // Day one of history: 1000 is already passed, 10000 is not reached yet.
  await collectOnce(db, {
    source: {
      name: "manual",
      fetchAccounts: async () => ({
        endpoint: "manual",
        raw: {},
        accounts: [
          {
            accountId: "manual:sharesies",
            accountName: "Sharesies",
            connectionName: "Sharesies",
            accountType: "INVESTMENT",
            valueNzd: 5000,
            currency: "NZD",
            status: "ACTIVE",
            sourceRefreshedAt: NOW.toISOString(),
            holdings: [],
            raw: {},
          },
        ],
      }),
    },
    now: new Date("2026-09-01T04:00:00.000Z"),
  });

  let milestones = listMilestones(db, goal.id);
  assert.equal(milestones.find((m) => m.amountNzd === 1000)?.firstReachedOn, "2026-09-01");
  assert.equal(milestones.find((m) => m.amountNzd === 10000)?.firstReachedOn, null);

  // Later the value clears 10000, and the new date is stamped.
  await collectOnce(db, {
    source: valueSource(15000, NOW.toISOString()),
    now: NOW,
    snapshotDate: "2026-09-15",
  });
  milestones = listMilestones(db, goal.id);
  assert.equal(milestones.find((m) => m.amountNzd === 10000)?.firstReachedOn, "2026-09-15");

  // 1m is never reached.
  assert.equal(milestones.find((m) => m.amountNzd === 1_000_000)?.firstReachedOn, null);

  db.close();
});
