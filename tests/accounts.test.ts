import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/server.ts";
import { collectOnce } from "../src/collector/collect.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import { listAccounts, scopedAccountIds, setAccountScope, totalSeries } from "../src/db/repo.ts";
import { loadFixture, testDb } from "./helpers.ts";

process.env["QUIET"] = "1";

const NOW = new Date("2026-09-28T04:00:00.000Z");

/** Sharesies investment + wallet, plus a KiwiSaver account at another provider. */
function sourceWithKiwisaver(): PortfolioSource {
  const raw = loadFixture("accounts.sharesies-portfolio.sample.json") as { items: unknown[] };
  raw.items.push({
    _id: "acc_ks_provider_0001",
    name: "KiwiSaver Growth",
    status: "ACTIVE",
    type: "KIWISAVER",
    connection: { _id: "conn_ks", name: "Simplicity" },
    balance: { current: 41000, currency: "NZD" },
    refreshed: { balance: "2026-09-28T02:11:04.000Z" },
  });
  return {
    name: "akahu",
    fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
  };
}

test("only accounts matching the default rule are in scope on first sight", async () => {
  const db = testDb();
  await collectOnce(db, { source: sourceWithKiwisaver(), now: NOW });

  const accounts = listAccounts(db);
  assert.equal(accounts.length, 4, "every account seen is registered, not just the selected ones");
  assert.deepEqual(
    accounts.filter((account) => account.inScope).map((account) => account.accountId).sort(),
    ["acc_sharesies_investment_0001", "acc_sharesies_wallet_0001"],
  );
  // The KiwiSaver account and the ANZ one are registered but excluded.
  assert.equal(accounts.find((a) => a.accountId === "acc_ks_provider_0001")?.inScope, false);
  assert.equal(accounts.find((a) => a.accountId === "acc_anz_everyday_0001")?.inScope, false);

  db.close();
});

test("including an account adds it to the goal total and the collection", async () => {
  const db = testDb();
  const source = sourceWithKiwisaver();

  await collectOnce(db, { source, now: NOW });
  assert.equal(totalSeries(db).at(-1)?.value, 18844.7);

  // Widen the goal (plan section 14.1): now KiwiSaver counts too.
  setAccountScope(db, "acc_ks_provider_0001", true);
  await collectOnce(db, { source, now: NOW, snapshotDate: "2026-09-29" });

  assert.equal(totalSeries(db).at(-1)?.value, 59844.7);
  assert.deepEqual(scopedAccountIds(db).sort(), [
    "acc_ks_provider_0001",
    "acc_sharesies_investment_0001",
    "acc_sharesies_wallet_0001",
  ]);

  db.close();
});

test("an exclusion survives later collections", async () => {
  const db = testDb();
  const source = sourceWithKiwisaver();

  await collectOnce(db, { source, now: NOW });
  setAccountScope(db, "acc_sharesies_wallet_0001", false);

  // Two more runs: the collector must not quietly put it back in scope.
  await collectOnce(db, { source, now: NOW, snapshotDate: "2026-09-29" });
  await collectOnce(db, { source, now: NOW, snapshotDate: "2026-09-30" });

  assert.equal(listAccounts(db).find((a) => a.accountId === "acc_sharesies_wallet_0001")?.inScope, false);
  assert.equal(totalSeries(db).at(-1)?.value, 18432.55);
  // Snapshots are still written for in-scope accounts only.
  assert.equal(totalSeries(db).length, 3);

  db.close();
});

test("excluding everything is reported as a scope problem, not a silent zero", async () => {
  const db = testDb();
  await collectOnce(db, { source: sourceWithKiwisaver(), now: NOW });
  for (const account of listAccounts(db)) setAccountScope(db, account.accountId, false);

  const result = await collectOnce(db, { source: sourceWithKiwisaver(), now: NOW, snapshotDate: "2026-09-29" });
  // Snapshots are still recorded for every account; only the total is empty.
  assert.equal(result.snapshotsWritten, 4);
  assert.equal(result.value, null);
  assert.ok(result.warnings.some((warning) => warning.includes("goal scope")), result.warnings.join(" | "));

  db.close();
});

test("GET /api/accounts lists scope with the default rule, PATCH flips it", async () => {
  const db = testDb();
  await collectOnce(db, { source: sourceWithKiwisaver(), now: NOW });
  const app = createApp(db);

  const listed = await (await app.request("/api/accounts")).json() as any;
  assert.equal(listed.accounts.length, 4);
  assert.equal(listed.inScopeCount, 2);
  assert.equal(listed.defaultRule.connectionMatch, "sharesies");
  assert.deepEqual(listed.defaultRule.accountTypes, ["INVESTMENT", "WALLET"]);

  const kiwisaver = listed.accounts.find((account: any) => account.accountId === "acc_ks_provider_0001");
  assert.equal(kiwisaver.latestValue, 41000);
  assert.equal(kiwisaver.latestSnapshotDate, "2026-09-28");
  assert.equal(kiwisaver.inScope, false);

  const patched = await app.request("/api/accounts/acc_ks_provider_0001", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inScope: true }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json() as any).account.inScope, true);

  const summary = await (await app.request("/api/summary")).json() as any;
  assert.equal(summary.currentValue, 59844.7);
  assert.equal(summary.syncHealth.excludedAccounts.length, 1);

  const bad = await app.request("/api/accounts/acc_ks_provider_0001", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);

  const missing = await app.request("/api/accounts/nope", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inScope: true }),
  });
  assert.equal(missing.status, 404);

  db.close();
});

test("a stale excluded account does not mark the goal data stale", async () => {
  const db = testDb();
  await collectOnce(db, { source: sourceWithKiwisaver(), now: NOW });

  // Backdate the excluded KiwiSaver account's refresh well past the threshold.
  db.prepare("UPDATE snapshots SET source_refreshed_at = '2026-08-01T00:00:00.000Z' WHERE account_id = ?")
    .run("acc_ks_provider_0001");

  const app = createApp(db, { today: "2026-09-28", now: NOW });
  const summary = await (await app.request("/api/summary")).json() as any;
  assert.equal(summary.syncHealth.stale, false);
  // It is still visible in the strip, flagged as out of scope.
  const kiwisaver = summary.syncHealth.accounts.find((account: any) => account.accountId === "acc_ks_provider_0001");
  assert.equal(kiwisaver.inScope, false);
  assert.ok(kiwisaver.ageHours > 48);

  db.close();
});
