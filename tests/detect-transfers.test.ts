import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeTransactions, nextCursor, parseTransaction } from "../src/sources/parse-transactions.ts";
import { detectTransfers, matchesKeyword, type AccountRef } from "../src/import/detect-transfers.ts";
import { loadFixture } from "./helpers.ts";

const RAW = loadFixture("transactions.bank.sample.json");
const TRANSACTIONS = normalizeTransactions(RAW);

const ACCOUNTS: AccountRef[] = [
  { accountId: "acc_anz_everyday_0001", accountName: "ANZ Everyday", connectionName: "ANZ" },
  { accountId: "acc_sharesies_wallet_0001", accountName: "Sharesies Wallet", connectionName: "Sharesies" },
  { accountId: "acc_sharesies_investment_0001", accountName: "Sharesies Investment", connectionName: "Sharesies" },
];

describe("parse transactions", () => {
  test("reads the documented fields and the date part only", () => {
    const [first] = TRANSACTIONS;
    assert.equal(first?.transactionId, "txn_anz_0001");
    assert.equal(first?.accountId, "acc_anz_everyday_0001");
    assert.equal(first?.date, "2026-09-01", "the NZ calendar date, not a shifted timestamp");
    assert.equal(first?.amount, -400);
    assert.equal(first?.type, "DIRECT DEBIT");
  });

  test("reads the cursor for the next page", () => {
    assert.equal(nextCursor(RAW), null);
    assert.equal(nextCursor({ cursor: { next: "abc" } }), "abc");
    assert.equal(nextCursor({ cursor: "abc" }), "abc");
    assert.equal(nextCursor({ cursor: { next: "" } }), null);
    assert.equal(nextCursor({}), null);
  });

  test("survives an enriched row and an unenriched one", () => {
    const enriched = TRANSACTIONS.find((row) => row.transactionId === "txn_anz_0007");
    assert.equal(enriched?.merchant, "Sharesies Limited", "merchant may be an object");
    assert.equal(enriched?.category, "Investments");
    // The description is empty, so the merchant stands in for it.
    assert.equal(enriched?.description, "Sharesies Limited");
  });

  test("returns null rather than a half-built row", () => {
    assert.equal(parseTransaction(null), null);
    assert.equal(parseTransaction("nonsense"), null);
    assert.equal(parseTransaction({ _id: "x" }), null, "a row with no type or description is unusable");
  });
});

describe("matchesKeyword", () => {
  test("matches whole words only", () => {
    assert.equal(matchesKeyword("transfer to sharesies", "sharesies"), true);
    assert.equal(matchesKeyword("sharesies   investments", "sharesies"), true);
    assert.equal(matchesKeyword("sharesies", "sharesies"), true);
    // "shares" and "sharesiesx" are not "sharesies".
    assert.equal(matchesKeyword("bought shares today", "sharesies"), false);
    assert.equal(matchesKeyword("sharesiesx", "sharesies"), false);
  });
});

describe("detectTransfers", () => {
  const result = detectTransfers(TRANSACTIONS, { accounts: ACCOUNTS });

  test("finds the bank transfers in both directions", () => {
    assert.equal(result.summary.examined, 10);
    assert.equal(result.summary.matched, 5, "four debits and one withdrawal");
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.transactionId),
      ["txn_anz_0007", "txn_anz_0006", "txn_anz_0005", "txn_anz_0003", "txn_anz_0001"],
      "newest first",
    );
  });

  test("a debit is a contribution and a credit is a withdrawal", () => {
    const contribution = result.candidates.find((candidate) => candidate.transactionId === "txn_anz_0001");
    assert.equal(contribution?.direction, "in");
    assert.equal(contribution?.amountNzd, 400);
    assert.equal(contribution?.contributionAmount, 400);

    const withdrawal = result.candidates.find((candidate) => candidate.transactionId === "txn_anz_0005");
    assert.equal(withdrawal?.direction, "out");
    assert.equal(withdrawal?.contributionAmount, -120.75, "a withdrawal reduces net contributions");
  });

  test("excludes movements inside the Sharesies connection", () => {
    assert.equal(result.summary.internal, 2);
    const internal = result.skipped.filter((row) => row.reason.includes("inside Sharesies"));
    assert.equal(internal.length, 2);
  });

  test("does not treat an unrelated debit as a transfer", () => {
    const power = result.skipped.find((row) => row.description === "Power bill");
    assert.equal(power?.reason, 'No keyword (sharesies) in the description.');
    assert.equal(result.summary.unmatched, 3);
  });

  test("a matching keyword with a disagreeing type is still proposed, at lower confidence", () => {
    // txn_anz_0005 is a DIRECT CREDIT of +120.75, which agrees. Force a mismatch
    // by asking about a debit typed as a credit.
    const mismatched = detectTransfers(
      [{
        transactionId: "txn_x", accountId: "acc_anz_everyday_0001", connectionId: null,
        date: "2026-09-01", description: "SHARESIES TOP UP", amount: -100,
        balance: null, type: "DIRECT CREDIT", merchant: null, category: null,
      }],
      { accounts: ACCOUNTS },
    );
    assert.equal(mismatched.candidates[0]?.confidence, "medium");
    assert.match(mismatched.candidates[0]?.reason ?? "", /does not agree with the sign/);
    assert.equal(mismatched.candidates[0]?.contributionAmount, 100, "the sign still follows the money");
  });

  test("gives every candidate a stable idempotency key", () => {
    assert.equal(result.candidates[0]?.externalRef, "akahu:txn_anz_0007");
    const refs = new Set(result.candidates.map((candidate) => candidate.externalRef));
    assert.equal(refs.size, result.candidates.length);
  });

  test("records which account the money left", () => {
    assert.equal(result.candidates[0]?.accountName, "ANZ Everyday");
  });

  test("says so when nothing matched", () => {
    const nothing = detectTransfers(TRANSACTIONS, { accounts: ACCOUNTS, keywords: ["not-a-real-payee"] });
    assert.equal(nothing.candidates.length, 0);
    assert.ok(
      nothing.warnings.some((warning) => warning.includes("No transaction in this window")),
      nothing.warnings.join(" | "),
    );
  });

  test("says so when Akahu returned nothing at all", () => {
    const empty = detectTransfers([]);
    assert.equal(empty.candidates.length, 0);
    assert.ok(empty.warnings[0]?.includes("rest period"), empty.warnings.join(" | "));
  });

  test("skips rows with no usable date or amount without inventing one", () => {
    const result = detectTransfers(
      [{
        transactionId: "txn_bad", accountId: null, connectionId: null,
        date: null, description: "SHARESIES", amount: -100,
        balance: null, type: "PAYMENT", merchant: null, category: null,
      }],
      { accounts: ACCOUNTS },
    );
    assert.equal(result.candidates.length, 0);
    assert.equal(result.summary.unusable, 1);
    assert.equal(result.skipped[0]?.reason, "No usable date or amount.");
  });

  test("honours a custom keyword list", () => {
    // The keyword decides what counts, not the sign: a "power" debit is still
    // money leaving the bank, so it becomes a positive contribution.
    const custom = detectTransfers(TRANSACTIONS, { accounts: ACCOUNTS, keywords: ["power"] });
    assert.equal(custom.candidates.length, 1);
    assert.equal(custom.candidates[0]?.description, "Power bill");
    assert.equal(custom.candidates[0]?.direction, "in");
    assert.equal(custom.candidates[0]?.contributionAmount, 180.4);
  });

  test("without the accounts registry a provider movement is proposed instead of excluded", () => {
    // The exclusion depends on knowing which connection an account belongs to.
    // Dropping the registry is the honest failure mode: an internal movement that
    // mentions the provider is then proposed as a transfer, so the caller must
    // pass the registry.
    const internalRow = {
      transactionId: "txn_internal", accountId: "acc_sharesies_wallet_0001", connectionId: null,
      date: "2026-09-14", description: "Sharesies wallet to investment", amount: -400,
      balance: null, type: "TRANSFER", merchant: null, category: null,
    };

    const withRegistry = detectTransfers([internalRow], { accounts: ACCOUNTS });
    assert.equal(withRegistry.candidates.length, 0);
    assert.equal(withRegistry.summary.internal, 1);

    const withoutRegistry = detectTransfers([internalRow], { accounts: [] });
    assert.equal(withoutRegistry.candidates.length, 1, "proposed rather than silently dropped");
    assert.equal(withoutRegistry.summary.internal, 0);
  });
});
