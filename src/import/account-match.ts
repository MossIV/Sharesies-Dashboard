/**
 * Matching a report's Portfolio column to the accounts Akahu registers.
 *
 * A real Sharesies report lists `Investments` and `High-growth portfolio`, while
 * the accounts it refers to are called `Ben's Investments` and `Ben's High-growth
 * portfolio`. Exact string equality therefore matches nothing, and the rows would
 * all land unattributed — which is precisely how 986 rows belonging to an account
 * outside the goal ended up in the goal's contributions.
 *
 * So matching is on the normalised name, in either direction, and it refuses to
 * guess: an ambiguous portfolio (one that matches two accounts) or an unknown one
 * resolves to null and is reported instead. Guessing here is what makes a
 * financial total quietly wrong.
 *
 * Pure: no database, no filesystem.
 */

export interface AccountName {
  accountId: string;
  accountName: string;
}

export type MatchStatus =
  /** The normalised names are identical. */
  | "exact"
  /** Exactly one account contains the portfolio name, or vice versa. */
  | "partial"
  /** More than one account could be meant, so none is chosen. */
  | "ambiguous"
  /** No account resembles the portfolio name. */
  | "none";

export interface PortfolioMatch {
  /** The value from the report, as written. */
  portfolio: string;
  accountId: string | null;
  accountName: string | null;
  status: MatchStatus;
  /** Account names that could have been meant, for the preview. */
  candidates: string[];
}

/** Lowercase, letters and digits only: "Ben's Investments" -> "bensinvestments". */
export function normaliseAccountName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Short enough to match almost anything, so it is not used for containment. */
const MIN_CONTAINMENT_LENGTH = 4;

export function matchPortfolio(portfolio: string, accounts: AccountName[]): PortfolioMatch {
  const target = normaliseAccountName(portfolio);

  if (target === "") {
    return { portfolio, accountId: null, accountName: null, status: "none", candidates: [] };
  }

  const exact = accounts.find((account) => normaliseAccountName(account.accountName) === target);
  if (exact) {
    return {
      portfolio,
      accountId: exact.accountId,
      accountName: exact.accountName,
      status: "exact",
      candidates: [exact.accountName],
    };
  }

  if (target.length < MIN_CONTAINMENT_LENGTH) {
    return { portfolio, accountId: null, accountName: null, status: "none", candidates: [] };
  }

  const candidates = accounts.filter((account) => {
    const name = normaliseAccountName(account.accountName);
    return name.includes(target) || target.includes(name);
  });

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return { portfolio, accountId: only.accountId, accountName: only.accountName, status: "partial", candidates: [only.accountName] };
  }
  if (candidates.length > 1) {
    return {
      portfolio,
      accountId: null,
      accountName: null,
      status: "ambiguous",
      candidates: candidates.map((account) => account.accountName),
    };
  }
  return { portfolio, accountId: null, accountName: null, status: "none", candidates: [] };
}

/** Match every distinct portfolio in a report in one pass. */
export function matchPortfolios(portfolios: string[], accounts: AccountName[]): PortfolioMatch[] {
  return [...new Set(portfolios)].filter((name) => name !== "").map((name) => matchPortfolio(name, accounts));
}
