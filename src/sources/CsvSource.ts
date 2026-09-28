/**
 * CsvSource — read a Sharesies transaction report off disk.
 *
 * Scope, stated honestly: the report is a transaction log, not a valuation. It
 * carries a running balance, which is the only number here that can stand in for
 * "what the portfolio was worth on that date". There is no holdings breakdown,
 * because reconstructing one from a transaction log would be guesswork (drp,
 * splits and fees all move units in ways the log does not fully describe).
 *
 * Contributions are the other half of the CSV story and do not come through this
 * interface at all: they go through `src/import/sharesies-report.ts`, because
 * contributions are a separate table with a separate import path (plan section 6).
 */
import { readFileSync } from "node:fs";
import type { FetchResult, PortfolioSource } from "./PortfolioSource.ts";
import { buildImportPlan, parseCsv } from "../import/csv.ts";
import { latestBalance, splitRows } from "../import/sharesies-report.ts";

export interface CsvSourceOptions {
  filePath: string;
  accountName?: string;
  accountId?: string;
  currency?: string;
}

export class CsvSource implements PortfolioSource {
  readonly name = "csv";
  readonly #filePath: string;
  readonly #accountName: string;
  readonly #accountId: string;
  readonly #currency: string;

  constructor(options: CsvSourceOptions) {
    this.#filePath = options.filePath;
    this.#accountName = options.accountName ?? process.env["CSV_ACCOUNT_NAME"] ?? "Sharesies (report)";
    this.#accountId = options.accountId ?? "csv:sharesies";
    this.#currency = options.currency ?? "NZD";
  }

  async fetchAccounts(): Promise<FetchResult> {
    const text = readFileSync(this.#filePath, "utf8");
    const parsed = parseCsv(text);
    const plan = buildImportPlan(parsed);
    const transactions = splitRows(plan, parsed);

    const value = latestBalance(transactions);
    if (value === null) {
      throw new Error(
        `${this.#filePath} has no balance column, so it cannot supply a portfolio value. ` +
          "The Sharesies transaction report lists buy and sell transactions. For the portfolio value, " +
          "use MANUAL_VALUE_NZD, or the Akahu source; use this file for contributions instead " +
          "(POST /api/import/sharesies-csv).",
      );
    }

    const asOf = transactions
      .map((transaction) => transaction.date)
      .filter((date): date is string => date !== null)
      .sort()
      .at(-1) ?? null;

    const account = {
      accountId: this.#accountId,
      accountName: this.#accountName,
      connectionName: "Sharesies",
      accountType: "INVESTMENT",
      valueNzd: value,
      currency: this.#currency,
      status: "ACTIVE" as const,
      // The balance is as current as the report's newest row, not as current as
      // "now" — saying otherwise would make a stale file look fresh.
      sourceRefreshedAt: asOf ? `${asOf}T00:00:00.000Z` : null,
      holdings: [],
      raw: { source: "csv", filePath: this.#filePath, asOf, value, rows: parsed.rows.length },
    };

    return { endpoint: "csv", raw: account.raw, accounts: [account] };
  }
}