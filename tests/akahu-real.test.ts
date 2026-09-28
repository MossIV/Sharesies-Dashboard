/**
 * The real Akahu response, as captured by the Phase 0 spike (`npm run spike`).
 *
 * The other fixtures were written by hand from the docs; this one is the thing
 * itself, so it is what catches a parser that is only right about the shape we
 * imagined.
 *
 * Two rules for this file, both deliberate:
 *
 *   1. The fixture is git-ignored — it is a redacted real response, but the
 *      balances and holdings are the real ones, which makes it a financial
 *      statement rather than a fixture. These tests skip when it is absent, so a
 *      fresh clone passes without it.
 *   2. Every expected value is read from the fixture and compared against the
 *      fixture, never written here. Asserting the balances directly would publish
 *      them in a committed file even though the file they came from is ignored.
 *      Deriving both sides tests more, not less: it pins the parser against the
 *      actual payload rather than against a number copied out of it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractItems, normalizeAccounts } from "../src/sources/parse-akahu.ts";
import { selectPortfolioAccounts, totalValue } from "../src/collector/select-accounts.ts";
import { FIXTURES } from "./helpers.ts";

const REAL_FIXTURE = join(FIXTURES, "akahu-accounts.real.json");
const available = existsSync(REAL_FIXTURE);
const skip = available
  ? false
  : "run `npm run spike` first: the fixture is git-ignored because it holds real balances";

interface RawItem {
  name: string;
  type: string;
  status: string;
  balance: { currency: string; current: number };
  connection: { name: string };
  refreshed: { balance?: string; meta?: string };
  meta: {
    portfolio?: { name: string; symbol: string; value: number; shares: number }[];
    breakdown?: { returns?: number };
  };
}

const raw = available
  ? (JSON.parse(readFileSync(REAL_FIXTURE, "utf8")) as { success: boolean; items: RawItem[] })
  : { success: true, items: [] as RawItem[] };

describe("the real Akahu accounts response", { skip }, () => {
  const accounts = normalizeAccounts(raw);

  /** Accounts are matched by the name in the payload, not a hard-coded one. */
  function accountFor(item: RawItem) {
    const account = accounts.find((entry) => entry.accountName === item.name);
    assert.ok(account, `${item.name} must survive normalization`);
    return account;
  }

  test("is the multi-account Sharesies connection it was captured from", () => {
    const items = extractItems(raw);
    assert.ok(items.length >= 2, "a Sharesies connection exposes more than one account");
    assert.deepEqual(
      new Set(items.map((item) => (item as RawItem).connection.name)),
      new Set(["Sharesies"]),
      "every account comes from the one connection",
    );
  });

  test("normalizes every account, with the value taken from balance.current", () => {
    assert.equal(accounts.length, raw.items.length);

    for (const item of raw.items) {
      const account = accountFor(item);
      assert.equal(account.accountType, item.type);
      assert.equal(account.status, item.status);
      assert.equal(account.currency, item.balance.currency);
      assert.equal(account.valueNzd, item.balance.current, "the value is balance.current, nothing else");
    }
  });

  test("does not mistake meta.breakdown.returns for the balance", () => {
    // `returns` sits beside the value in the payload. Reading it as the value
    // would be a plausible mistake, so it is asserted rather than assumed.
    let checked = 0;
    for (const item of raw.items) {
      const returns = item.meta.breakdown?.returns;
      if (returns === undefined) continue;
      checked += 1;
      assert.notEqual(accountFor(item).valueNzd, returns, `${item.name}: returns is not the value`);
    }
    assert.ok(checked > 0, "the fixture should carry meta.breakdown.returns to check");
  });

  test("reads every holding out of meta.portfolio", () => {
    for (const item of raw.items) {
      const expected = item.meta.portfolio ?? [];
      assert.equal(accountFor(item).holdings.length, expected.length, `${item.name}: one holding per entry`);
    }
  });

  test("maps the holding fields the way the payload spells them", () => {
    for (const item of raw.items) {
      const account = accountFor(item);
      for (const [index, source] of (item.meta.portfolio ?? []).entries()) {
        const holding = account.holdings[index]!;
        assert.equal(holding.name, source.name);
        assert.equal(holding.symbol, source.symbol);
        assert.equal(holding.value, source.value);
        assert.equal(holding.units, source.shares, "units come from `shares`");
      }
    }
  });

  test("the holdings never exceed the balance: the difference is uninvested cash", () => {
    // This started as "holdings should add up to the balance" and the real data
    // disproved it: the larger account holds a cash balance, about a sixth of it,
    // that appears in no portfolio entry. So the invariant is one-directional —
    // the holdings can account for less than the balance, never more — and
    // deriving the value from the holdings would under-report. Nothing is dropped
    // by the parser either way.
    for (const item of raw.items) {
      const account = accountFor(item);
      const summed = account.holdings.reduce((total, holding) => total + (holding.value ?? 0), 0);
      assert.ok(
        summed <= account.valueNzd * 1.001,
        `${item.name}: holdings (${summed}) must not exceed the balance (${account.valueNzd})`,
      );
      assert.ok(summed > 0, `${item.name}: a portfolio must produce holding values`);
    }
  });

  test("no holding loses its value to a null", () => {
    // The parser probes several key spellings for each field; a miss shows up as
    // a null rather than an error, so it is asserted explicitly.
    for (const item of raw.items) {
      const account = accountFor(item);
      for (const holding of account.holdings) {
        assert.notEqual(holding.value, null, `${item.name}: ${holding.name} has no value`);
      }
    }
  });

  test("the largest holding is the largest by value in the payload", () => {
    const heaviest = raw.items.reduce((most, item) =>
      (item.meta.portfolio ?? []).length > (most.meta.portfolio ?? []).length ? item : most);
    const expected = (heaviest.meta.portfolio ?? []).reduce((max, entry) =>
      entry.value > max.value ? entry : max);

    const actual = accountFor(heaviest).holdings.reduce((max, holding) =>
      (holding.value ?? 0) > (max.value ?? 0) ? holding : max);

    assert.equal(actual.name, expected.name);
    assert.equal(actual.symbol, expected.symbol);
    assert.equal(actual.value, expected.value);
  });

  test("carries a refresh timestamp on the payload and the normalized account", () => {
    for (const item of raw.items) {
      assert.ok(item.refreshed.balance, "the captured payload should carry refreshed.balance");
      assert.match(accountFor(item).sourceRefreshedAt ?? "", /^\d{4}-\d{2}-\d{2}T/, "ISO timestamp");
    }
  });

  test("every account is in scope by default, and the total is their sum", () => {
    const selected = selectPortfolioAccounts(accounts);
    assert.equal(selected.length, raw.items.length, "INVESTMENT accounts under Sharesies are in scope");

    const total = totalValue(selected);
    const expected = raw.items.reduce((sum, item) => sum + item.balance.current, 0);
    assert.equal(total.value, expected);
    assert.equal(total.currency, raw.items[0]!.balance.currency);
    assert.equal(total.mixedCurrency, false);
    assert.equal(total.hasInactive, false);
    assert.equal(
      total.holdings.length,
      raw.items.reduce((count, item) => count + (item.meta.portfolio ?? []).length, 0),
    );
  });

  test("the redaction left no account number, payment reference or id behind", () => {
    const text = JSON.stringify(raw);
    assert.ok(!/\d{2}-\d{4}-\d{7}-\d{2}/.test(text), "no NZ account number pattern");
    assert.ok(!/WW\d{6}/.test(text), "no Sharesies payment reference");
    assert.ok(!/acc_[a-z0-9]{20}/.test(text), "no raw account id");
    assert.ok(!/conn_[a-z0-9]{20}/.test(text), "no raw connection id");
    assert.ok(!/creds_[a-z0-9]{20}/.test(text), "no raw credentials reference");
    assert.ok(text.includes("<redacted:"), "the fixture is visibly redacted");
  });
});