/**
 * NormalizedAccount selection and aggregation.
 *
 * A Sharesies connection typically exposes more than one account: an
 * `INVESTMENT` account for holdings and a `WALLET` for uninvested cash. The
 * portfolio value the goal tracks is the sum of both, while `INVESTMENT` alone
 * is what carries `meta.portfolio`.
 */
import type { NormalizedAccount } from "../sources/PortfolioSource.ts";

/** Account types that count toward the portfolio total. */
export const DEFAULT_PORTFOLIO_TYPES = ["INVESTMENT", "WALLET"];

export interface SelectionOptions {
  /** Substring/regex tested against connection.name. Default: "sharesies". */
  connectionMatch?: string;
  accountTypes?: string[];
}

export function selectPortfolioAccounts(
  accounts: NormalizedAccount[],
  options: SelectionOptions = {},
): NormalizedAccount[] {
  const pattern = options.connectionMatch?.trim() || process.env["AKAHU_CONNECTION_MATCH"] || "sharesies";
  const types = new Set(
    (options.accountTypes ?? process.env["AKAHU_ACCOUNT_TYPES"]?.split(",") ?? DEFAULT_PORTFOLIO_TYPES)
      .map((entry) => entry.trim().toUpperCase())
      .filter(Boolean),
  );

  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, "i");
  } catch {
    matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  return accounts.filter((account) => {
    const connection = account.connectionName ?? "";
    const type = (account.accountType ?? "").toUpperCase();
    return matcher.test(connection) && types.has(type);
  });
}

export interface PortfolioTotal {
  /** Sum of the selected accounts, in the account currency. */
  value: number;
  currency: string;
  accounts: NormalizedAccount[];
  /** True when any selected account is INACTIVE or has no fresh timestamp. */
  hasInactive: boolean;
  /** Mixed currencies mean the sum is not meaningful; caller should flag it. */
  mixedCurrency: boolean;
  holdings: NormalizedAccount["holdings"];
}

export function totalValue(accounts: NormalizedAccount[]): PortfolioTotal {
  const currency = accounts[0]?.currency ?? "NZD";
  return {
    value: accounts.reduce((sum, account) => sum + account.valueNzd, 0),
    currency,
    accounts,
    hasInactive: accounts.some((account) => account.status === "INACTIVE"),
    mixedCurrency: accounts.some((account) => account.currency !== currency),
    holdings: accounts.flatMap((account) => account.holdings),
  };
}
