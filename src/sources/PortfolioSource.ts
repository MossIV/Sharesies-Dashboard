/**
 * The adapter boundary (plan section 3): everything upstream of storage talks to
 * this interface, so ManualSource / CsvSource can be added without touching the
 * collector, the domain layer or the API.
 */

export type AccountStatus = "ACTIVE" | "INACTIVE";

export interface Holding {
  name: string | null;
  symbol: string | null;
  units: number | null;
  value: number | null;
  raw: unknown;
}

export interface NormalizedAccount {
  accountId: string;
  accountName: string;
  /** connection.name — the collector matches on this, never a hard-coded id. */
  connectionName: string | null;
  /** Akahu account type: INVESTMENT, WALLET, SAVINGS, ... */
  accountType: string | null;
  /** balance.current, in the account's own currency (see `currency`). */
  valueNzd: number;
  currency: string;
  status: AccountStatus;
  /** account.refreshed.balance — tells the UI how stale the cached value is. */
  sourceRefreshedAt: string | null;
  holdings: Holding[];
  /** The untouched provider object for this account. */
  raw: unknown;
}

export interface FetchResult {
  endpoint: string;
  /** The whole response, stored verbatim in raw_fetches. */
  raw: unknown;
  accounts: NormalizedAccount[];
}

export interface PortfolioSource {
  readonly name: string;
  fetchAccounts(): Promise<FetchResult>;
}
