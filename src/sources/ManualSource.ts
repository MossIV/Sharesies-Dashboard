/**
 * ManualSource — type the current value in yourself.
 *
 * Two jobs:
 *   1. Fallback when Akahu is unavailable (tokens missing, API broken, plan
 *      section 13 risk row "Akahu changes its API or terms").
 *   2. Optional seeding of a starting snapshot before collection begins.
 */
import type { FetchResult, PortfolioSource } from "./PortfolioSource.ts";

export interface ManualSourceOptions {
  /** Where the value comes from. Defaults to MANUAL_VALUE_NZD. */
  getValue?: () => number | null;
  accountName?: string;
  accountId?: string;
  currency?: string;
}

export class ManualSource implements PortfolioSource {
  readonly name = "manual";
  readonly #getValue: () => number | null;
  readonly #accountName: string;
  readonly #accountId: string;
  readonly #currency: string;

  constructor(options: ManualSourceOptions = {}) {
    this.#getValue = options.getValue ?? (() => {
      const raw = process.env["MANUAL_VALUE_NZD"];
      if (!raw || raw.trim() === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    });
    this.#accountName = options.accountName ?? process.env["MANUAL_ACCOUNT_NAME"] ?? "Sharesies (manual)";
    this.#accountId = options.accountId ?? "manual:sharesies";
    this.#currency = options.currency ?? "NZD";
  }

  async fetchAccounts(): Promise<FetchResult> {
    const value = this.#getValue();
    if (value === null || !Number.isFinite(value)) {
      throw new Error(
        "ManualSource has no value. Set MANUAL_VALUE_NZD (or a manual_value_nzd setting) " +
          "in .env, or POST /api/manual-value.",
      );
    }

    const account = {
      accountId: this.#accountId,
      accountName: this.#accountName,
      // Named so the default "sharesies" connection matcher selects it: the
      // manual value is still your Sharesies portfolio, just typed by hand.
      connectionName: "Sharesies",
      accountType: "INVESTMENT",
      valueNzd: value,
      currency: this.#currency,
      status: "ACTIVE" as const,
      // A hand-typed value is "fresh" as of now by definition.
      sourceRefreshedAt: new Date().toISOString(),
      holdings: [],
      raw: { source: "manual", value, currency: this.#currency },
    };

    return {
      endpoint: "manual",
      raw: account.raw,
      accounts: [account],
    };
  }
}
