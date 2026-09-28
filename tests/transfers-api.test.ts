import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/server.ts";
import { collectOnce } from "../src/collector/collect.ts";
import { normalizeAccounts } from "../src/sources/parse-akahu.ts";
import { listContributions, netContributions } from "../src/db/repo.ts";
import type { PortfolioSource } from "../src/sources/PortfolioSource.ts";
import { loadFixture, testDb } from "./helpers.ts";

process.env["QUIET"] = "1";

const BANK_FIXTURE = loadFixture("transactions.bank.sample.json");
const NOW = new Date("2026-09-28T04:00:00.000Z");
const TODAY = "2026-09-28";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["AKAHU_APP_TOKEN"];
  delete process.env["AKAHU_USER_TOKEN"];
});

/**
 * AkahuSource reads tokens and `globalThis.fetch` at construction, so stubbing
 * both is enough to exercise the real client, the real pagination and the real
 * route without a network.
 */
function stubAkahu(payload: unknown = BANK_FIXTURE): { calls: string[] } {
  process.env["AKAHU_APP_TOKEN"] = "app-token-for-tests";
  process.env["AKAHU_USER_TOKEN"] = "user-token-for-tests";
  const calls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { calls };
}

function portfolioSource(fixture: string): PortfolioSource {
  const raw = loadFixture(fixture);
  return {
    name: "akahu",
    fetchAccounts: async () => ({ endpoint: "/accounts", raw, accounts: normalizeAccounts(raw) }),
  };
}

/** An app whose accounts registry already knows the ANZ and Sharesies accounts. */
async function seededApp() {
  const db = testDb();
  await collectOnce(db, { source: portfolioSource("accounts.sharesies-portfolio.sample.json"), now: NOW });
  return { db, app: createApp(db, { today: TODAY }) };
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  const response = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

describe("POST /api/transfers/scan", () => {
  test("proposes the bank transfers and says why", async () => {
    const { db, app } = await seededApp();
    const { calls } = stubAkahu();

    const result = await post(app, "/api/transfers/scan", { from: "2026-09-01", to: "2026-09-30" });

    assert.equal(result.status, 200);
    assert.equal(result.body.summary.matched, 5);
    assert.equal(result.body.summary.internal, 2, "wallet-to-investment movements are not transfers");
    assert.equal(result.body.summary.new, 5);
    assert.equal(result.body.candidates[0].alreadyImported, false);
    assert.match(result.body.candidates[0].reason, /"sharesies" in/);

    // The window and the keyword list are echoed back so the UI can show them.
    assert.deepEqual(result.body.window, { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(result.body.keywords, ["sharesies"]);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /\/transactions\?start=2026-09-01&end=2026-09-30/);

    db.close();
  });

  test("defaults to the last 90 days when no window is given", async () => {
    const { db, app } = await seededApp();
    const { calls } = stubAkahu();

    const result = await post(app, "/api/transfers/scan", {});
    assert.deepEqual(result.body.window, { from: "2026-06-30", to: TODAY });
    assert.match(calls[0]!, /start=2026-06-30&end=2026-09-28/);

    db.close();
  });

  test("an already-imported transaction is flagged, not hidden", async () => {
    const { db, app } = await seededApp();
    stubAkahu();

    const scan = await post(app, "/api/transfers/scan", {});
    const confirmed = await post(app, "/api/transfers/confirm", {
      transactions: [{
        externalRef: scan.body.candidates[0].externalRef,
        date: scan.body.candidates[0].date,
        amountNzd: scan.body.candidates[0].contributionAmount,
        description: scan.body.candidates[0].description,
      }],
    });
    assert.equal(confirmed.body.imported, 1);

    const again = await post(app, "/api/transfers/scan", {});
    const previously = again.body.candidates.find(
      (candidate: any) => candidate.externalRef === scan.body.candidates[0].externalRef,
    );
    assert.equal(previously.alreadyImported, true);
    assert.equal(again.body.summary.alreadyImported, 1);
    assert.equal(again.body.summary.new, 4);

    db.close();
  });

  test("needs Akahu, and says what to do instead", async () => {
    const { db, app } = await seededApp();
    const result = await post(app, "/api/transfers/scan", {});
    assert.equal(result.status, 400);
    assert.match(result.body.error, /needs Akahu/);
    db.close();
  });

  test("rejects an inverted or absurd window", async () => {
    const { db, app } = await seededApp();
    stubAkahu();

    const inverted = await post(app, "/api/transfers/scan", { from: "2026-09-30", to: "2026-09-01" });
    assert.equal(inverted.status, 400);
    assert.match(inverted.body.error, /from must not be after to/);

    const wide = await post(app, "/api/transfers/scan", { from: "2010-01-01", to: "2026-09-30" });
    assert.equal(wide.status, 400);
    assert.match(wide.body.error, /at most 730 days/);

    db.close();
  });
});

describe("POST /api/transfers/confirm", () => {
  test("records the confirmed rows as bank contributions", async () => {
    const { db, app } = await seededApp();
    stubAkahu();

    const scan = await post(app, "/api/transfers/scan", {});
    const deposits = scan.body.candidates.filter((candidate: any) => candidate.direction === "in");

    const result = await post(app, "/api/transfers/confirm", {
      transactions: deposits.map((candidate: any) => ({
        externalRef: candidate.externalRef,
        date: candidate.date,
        amountNzd: candidate.contributionAmount,
        description: candidate.description,
      })),
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.imported, 4);
    assert.equal(result.body.skipped, 0);

    const contributions = listContributions(db);
    assert.equal(contributions.length, 4);
    assert.ok(contributions.every((row) => row.source === "bank"));
    assert.equal(netContributions(db), 1100, "400 + 250 + 400 + 50");
    assert.ok(contributions[0]?.note?.startsWith("Bank transfer:"), contributions[0]?.note ?? "");

    db.close();
  });

  test("a withdrawal is recorded as a negative contribution", async () => {
    const { db, app } = await seededApp();
    stubAkahu();

    const scan = await post(app, "/api/transfers/scan", {});
    const withdrawal = scan.body.candidates.find((candidate: any) => candidate.direction === "out");

    await post(app, "/api/transfers/confirm", {
      transactions: [{
        externalRef: withdrawal.externalRef,
        date: withdrawal.date,
        amountNzd: withdrawal.contributionAmount,
        description: withdrawal.description,
      }],
    });

    assert.equal(netContributions(db), -120.75, "money leaving the portfolio reduces net contributions");

    db.close();
  });

  test("confirming twice does not double-count", async () => {
    const { db, app } = await seededApp();
    stubAkahu();

    const scan = await post(app, "/api/transfers/scan", {});
    const rows = scan.body.candidates.slice(0, 2).map((candidate: any) => ({
      externalRef: candidate.externalRef,
      date: candidate.date,
      amountNzd: candidate.contributionAmount,
      description: candidate.description,
    }));

    assert.equal((await post(app, "/api/transfers/confirm", { transactions: rows })).body.imported, 2);
    const second = await post(app, "/api/transfers/confirm", { transactions: rows });
    assert.equal(second.body.imported, 0);
    assert.equal(second.body.skipped, 2);
    assert.equal(listContributions(db).length, 2, "the reference is the idempotency key");

    db.close();
  });

  test("rejects a reference that did not come from the bank feed", async () => {
    const { db, app } = await seededApp();
    const result = await post(app, "/api/transfers/confirm", {
      transactions: [{ externalRef: "csv:abc", date: "2026-09-01", amountNzd: 100 }],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /akahu:/);
    assert.equal(listContributions(db).length, 0);
    db.close();
  });

  test("rejects an empty list, a bad date and a missing amount", async () => {
    const { db, app } = await seededApp();
    assert.equal((await post(app, "/api/transfers/confirm", { transactions: [] })).status, 400);
    assert.equal(
      (await post(app, "/api/transfers/confirm", {
        transactions: [{ externalRef: "akahu:x", date: "01/09/2026", amountNzd: 10 }],
      })).status,
      400,
    );
    assert.equal(
      (await post(app, "/api/transfers/confirm", {
        transactions: [{ externalRef: "akahu:x", date: "2026-09-01" }],
      })).status,
      400,
    );
    db.close();
  });
});
