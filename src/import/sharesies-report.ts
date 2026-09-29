/**
 * The Sharesies transaction report importer (plan section 6, option 2).
 *
 * Parsing and classification live in `csv.ts`; this file is the part that decides
 * what each row is worth in NZD, which account it belongs to, and what gets
 * written. Four properties, each of which is a way this was got wrong before:
 *
 *   1. **Dry run is the default.** A preview returns exactly the rows an apply
 *      would insert — converted amounts included, so the preview is not a
 *      different calculation from the write.
 *   2. **Re-importing the same file adds nothing.** Each row is keyed by the
 *      report's own Trade ID where it has one, and by a content hash otherwise.
 *   3. **Currency is converted, not assumed.** A real report held NZD, USD and AUD
 *      rows in one file; the conversion uses the rate published for the row's own
 *      trade date and stores the rate and its date on the row. A row whose rate
 *      cannot be found is reported and left out, rather than counted at par.
 *   4. **Rows are attributed to a portfolio.** The report's Portfolio column names
 *      the account, and it is matched to the accounts Akahu registers. Without it
 *      the goal's contributions summed every portfolio in the report — 8,657.60 of
 *      deposits against a tracked value of 214.33 — and the chart comparing them
 *      was meaningless.
 */
import type { DatabaseSync } from "node:sqlite";
import { importContribution, listAccounts, recordImport } from "../db/repo.ts";
import {
  buildImportPlan,
  importableRows,
  parseCsv,
  type DateFormat,
  type ImportPlan,
  type ParsedCsv,
  type RowCategory,
} from "./csv.ts";
import { matchPortfolios, type PortfolioMatch } from "./account-match.ts";
import { loadFxRates, resolveFxProvider, type FxLookup, type FxProvider } from "./fx.ts";

export interface ReportOptions {
  categories?: RowCategory[];
  dateFormat?: DateFormat;
  /**
   * The rate source. Omitted resolves from the environment; `null` disables
   * fetching, which is what an offline run and every test want.
   */
  fxProvider?: FxProvider | null;
}

export interface ReportTransaction {
  rowNumber: number;
  date: string | null;
  description: string;
  category: RowCategory;
  /** The signed amount in the row's own currency. */
  amount: number;
  /** The same figure in NZD. Null when the row could not be converted. */
  amountNzd: number | null;
  currency: string;
  /** NZD per one unit of `currency`, when a rate was applied. */
  fxRate: number | null;
  /** The date the rate is published for; differs from the trade date on weekends. */
  rateDate: string | null;
  balance: number | null;
  externalRef: string;
  /** What the report's Portfolio column said. */
  portfolio: string | null;
  accountId: string | null;
  accountName: string | null;
  /** Whether the matched account is inside the goal, so the UI can say so. */
  accountInScope: boolean;
  fee: number | null;
}

export interface CurrencyTotal {
  currency: string;
  rows: number;
  /** Sum in the row currency. */
  amount: number;
  /** Sum in NZD, after conversion. */
  nzd: number;
  /** Every rate applied, so the conversion can be spot-checked. */
  rates: number[];
}

export interface FxReport {
  /** The provider used, or "none" when fetching was disabled. */
  source: string;
  requests: number;
  /** Rows whose currency had no usable rate, so they were not imported. */
  unconverted: number;
  errors: string[];
}

export interface ImportOutcome {
  plan: ImportPlan;
  /** All rows in the file, whether or not they are wanted as contributions. */
  transactions: ReportTransaction[];
  /** The rows an apply would insert (or did insert, when `mode` is "apply"). */
  selected: ReportTransaction[];
  /** The report's Portfolio values and the account each resolved to. */
  accounts: PortfolioMatch[];
  /** Row counts and sums per currency. */
  currencyTotals: CurrencyTotal[];
  fx: FxReport;
  /** Selected rows attributed to an account outside the goal. */
  outsideGoal: number;
  /** Selected rows with no account at all, which also stay out of the goal. */
  unattributed: number;
  /** Rows attributed to the goal's sole account because the file named no portfolio. */
  attributedByDefault: number;
  imported: number;
  skipped: number;
  importId: number | null;
  warnings: string[];
}

/**
 * Turn a plan into typed transactions, picking up the balance column on the way.
 *
 * No conversion happens here: this function is pure and has no rate to apply, so
 * `amountNzd` is only filled in for rows already in NZD. `importSharesiesReport`
 * applies the rates.
 */
export function splitRows(plan: ImportPlan, parsed: ParsedCsv): ReportTransaction[] {
  const balanceIndex = plan.columns.balance;

  return plan.candidates.map((candidate, index) => {
    const row = parsed.rows[index] ?? [];
    const rawBalance = balanceIndex === undefined ? "" : (row[balanceIndex] ?? "").trim();
    const balance = rawBalance === "" ? null : Number(rawBalance.replace(/[,\s$]/g, ""));
    const inTargetCurrency = candidate.currency === "NZD";

    return {
      rowNumber: candidate.rowNumber,
      date: candidate.date,
      description: candidate.description,
      category: candidate.category,
      amount: candidate.amount,
      amountNzd: inTargetCurrency ? candidate.amount : null,
      currency: candidate.currency,
      fxRate: inTargetCurrency ? 1 : null,
      rateDate: inTargetCurrency ? candidate.date : null,
      balance: balance !== null && Number.isFinite(balance) ? balance : null,
      externalRef: candidate.externalRef,
      portfolio: candidate.portfolio,
      accountId: null,
      accountName: null,
      accountInScope: false,
      fee: candidate.fee,
    };
  });
}

/** The portfolio balance implied by a report: the newest row that carries one. */
export function latestBalance(transactions: ReportTransaction[]): number | null {
  const withBalance = transactions
    .filter((transaction) => transaction.balance !== null && transaction.date !== null)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  const last = withBalance.at(-1);
  return last?.balance ?? null;
}

/** Apply a resolved rate to a row, in place. */
function applyRate(transaction: ReportTransaction, lookup: FxLookup): void {
  const resolution = transaction.date === null ? null : lookup.resolve(transaction.date);
  if (!resolution) return;
  transaction.fxRate = resolution.rate;
  transaction.rateDate = resolution.rateDate;
  transaction.amountNzd = Math.round(transaction.amount * resolution.rate * 100) / 100;
}

/** Attach the matched account to a row. */
function applyAccount(
  transaction: ReportTransaction,
  matches: Map<string, PortfolioMatch>,
  inScope: Set<string>,
): void {
  if (transaction.portfolio === null) return;
  const match = matches.get(transaction.portfolio);
  if (!match || match.accountId === null) return;
  transaction.accountId = match.accountId;
  transaction.accountName = match.accountName;
  transaction.accountInScope = inScope.has(match.accountId);
}

/**
 * The account to use when a file names no portfolio at all.
 *
 * Only when the goal tracks exactly one account. Then there is nothing in the file
 * to contradict the assumption, and the alternative — importing deposits that
 * silently do not count — is worse and harder to notice. When a file *does* name a
 * portfolio that matches no account, no fallback applies: that is a file making a
 * statement, not staying silent, and guessing over it is how the wrong total got in.
 */
function soleInScopeAccount(accounts: { accountId: string; accountName: string; inScope: boolean }[]) {
  const scoped = accounts.filter((account) => account.inScope);
  return scoped.length === 1 ? scoped[0]! : null;
}

/** Row counts and sums per currency, over the rows that would be written. */
function totals(transactions: ReportTransaction[]): CurrencyTotal[] {
  const byCurrency = new Map<string, CurrencyTotal>();
  for (const transaction of transactions) {
    const entry = byCurrency.get(transaction.currency) ?? {
      currency: transaction.currency, rows: 0, amount: 0, nzd: 0, rates: [],
    };
    entry.rows += 1;
    entry.amount += transaction.amount;
    entry.nzd += transaction.amountNzd ?? 0;
    if (transaction.fxRate !== null && transaction.fxRate !== 1) entry.rates.push(transaction.fxRate);
    byCurrency.set(transaction.currency, entry);
  }
  return [...byCurrency.values()]
    .map((entry) => ({
      ...entry,
      amount: Math.round(entry.amount * 100) / 100,
      nzd: Math.round(entry.nzd * 100) / 100,
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

/**
 * Preview or apply a report.
 *
 * `mode: "preview"` never writes. `mode: "apply"` writes the selected rows and
 * records the run in the `imports` table either way. Preview fetches rates too: a
 * preview showing unconverted amounts would be describing a different calculation
 * from the one an apply performs.
 */
export async function importSharesiesReport(
  db: DatabaseSync,
  input: {
    csv: string;
    filename?: string | null;
    mode?: "preview" | "apply";
    options?: ReportOptions;
  },
): Promise<ImportOutcome> {
  const mode = input.mode ?? "preview";
  const options = input.options ?? {};
  const parsed = parseCsv(input.csv);

  // The plan must be built with the caller's category selection so that its
  // warnings reflect what they asked for.
  const plan = buildImportPlan(parsed, options);
  const accounts = listAccounts(db);
  const matches = matchPortfolios(plan.portfolios, accounts);
  const matchesByPortfolio = new Map(matches.map((match) => [match.portfolio, match]));
  const inScope = new Set(accounts.filter((account) => account.inScope).map((account) => account.accountId));

  const transactions = splitRows(plan, parsed);
  for (const transaction of transactions) applyAccount(transaction, matchesByPortfolio, inScope);

  // A file with no portfolio column says nothing about which account its rows belong
  // to, so they follow the goal's single account rather than disappearing from it.
  const namesNoPortfolio = plan.columns.portfolio === undefined;
  const fallback = namesNoPortfolio ? soleInScopeAccount(accounts) : null;
  if (fallback) {
    for (const transaction of transactions) {
      if (transaction.accountId !== null) continue;
      transaction.accountId = fallback.accountId;
      transaction.accountName = fallback.accountName;
      transaction.accountInScope = true;
    }
  }

  const selectedRefs = new Set(
    importableRows(plan, options).map((candidate) => candidate.externalRef),
  );
  const selected = transactions.filter((transaction) => selectedRefs.has(transaction.externalRef));

  const warnings = [...plan.warnings];
  const fx: FxReport = { source: "none", requests: 0, unconverted: 0, errors: [] };

  // Only the rows that would be written need a rate: converting rows the caller did
  // not select would mean network requests for rows that go nowhere.
  const foreign = selected.filter((transaction) => transaction.currency !== "NZD" && transaction.date !== null);
  if (foreign.length > 0) {
    const provider = options.fxProvider === undefined ? resolveFxProvider() : options.fxProvider;
    const byCurrency = new Map<string, ReportTransaction[]>();
    for (const transaction of foreign) {
      byCurrency.set(transaction.currency, [...(byCurrency.get(transaction.currency) ?? []), transaction]);
    }

    for (const [currency, rows] of byCurrency) {
      const lookup = await loadFxRates(db, {
        base: currency,
        quote: "NZD",
        dates: rows.map((row) => row.date!),
        provider,
      });
      fx.source = provider ? provider.name : "none";
      fx.requests += lookup.requests;
      fx.errors.push(...lookup.errors);
      for (const row of rows) applyRate(row, lookup);
    }

    const unconverted = foreign.filter((transaction) => transaction.amountNzd === null);
    fx.unconverted = unconverted.length;
    if (unconverted.length > 0) {
      const currencies = [...new Set(unconverted.map((row) => row.currency))].join(", ");
      warnings.push(
        `${unconverted.length} row(s) are in ${currencies} and no rate could be found for their trade date, so ` +
          "they were left out rather than counted as NZD at par. Rates already cached are reused, so importing " +
          "again later fills the gap instead of guessing now.",
      );
    }
  }

  const convertible = selected.filter((transaction) => transaction.amountNzd !== null);
  const outsideGoal = convertible.filter(
    (transaction) => transaction.accountId !== null && !transaction.accountInScope,
  ).length;
  const unattributed = convertible.filter((transaction) => transaction.accountId === null).length;
  // Counted over the rows that would actually be written: a file's other rows are
  // reported in the counts above, and adding them here would overstate what the
  // goal is about to take on.
  const attributedByDefault = fallback === null
    ? 0
    : convertible.filter((transaction) => transaction.portfolio === null).length;

  for (const match of matches.filter((entry) => entry.accountId === null)) {
    const detail = match.status === "ambiguous"
      ? `could mean any of ${match.candidates.join(", ")}`
      : "matches no account Akahu has registered";
    warnings.push(
      `The report's portfolio "${match.portfolio}" ${detail}. Its rows keep that portfolio name but no account, ` +
        "so they do not count toward the goal until you set one on them.",
    );
  }
  if (attributedByDefault > 0 && fallback) {
    warnings.push(
      `${attributedByDefault} row(s) were attributed to "${fallback.accountName}", the only account in the goal, ` +
        "because this file names no portfolio. If these rows belong to a different account, the goal's " +
        "contributions are overstated by their total.",
    );
  }
  if (outsideGoal > 0) {
    warnings.push(
      `${outsideGoal} row(s) belong to an account outside the goal. They are logged, so the history is complete, ` +
        "and left out of the goal's contributions — which is what keeps the headline figure comparable to the " +
        "portfolio the goal tracks.",
    );
  }

  const currencyTotals = totals(convertible);
  const preview: ImportOutcome = {
    plan,
    transactions,
    selected: convertible,
    accounts: matches,
    currencyTotals,
    fx,
    outsideGoal,
    unattributed,
    attributedByDefault,
    imported: 0,
    skipped: 0,
    importId: null,
    warnings,
  };

  if (mode === "preview") return preview;

  let imported = 0;
  let skipped = 0;

  for (const transaction of convertible) {
    const result = importContribution(db, {
      contributionDate: transaction.date!,
      amountNzd: transaction.amountNzd!,
      note: `Sharesies report: ${transaction.description}`.slice(0, 300),
      source: "csv",
      externalRef: transaction.externalRef,
      accountId: transaction.accountId,
      currency: transaction.currency,
      amountOriginal: transaction.amount,
      fxRate: transaction.fxRate,
      category: transaction.category,
    });
    if (result.skipped) skipped += 1;
    else imported += 1;
  }

  const importId = recordImport(db, {
    kind: "sharesies_report",
    filename: input.filename ?? null,
    rowsSeen: transactions.length,
    rowsImported: imported,
    rowsSkipped: skipped,
    report: {
      delimiter: plan.delimiter,
      dateFormat: plan.dateFormat,
      dateAmbiguous: plan.dateAmbiguous,
      counts: plan.counts,
      categories: options.categories ?? ["deposit"],
      currencies: plan.currencies,
      portfolios: matches.map((match) => ({
        portfolio: match.portfolio,
        accountId: match.accountId,
        accountName: match.accountName,
        status: match.status,
      })),
      fx: { source: fx.source, requests: fx.requests, errors: fx.errors },
      currencyTotals,
      outsideGoal,
      unattributed,
      attributedByDefault,
    },
  });

  if (skipped > 0) {
    warnings.push(
      `${skipped} row(s) were already in the log and were skipped, so importing the same file twice is safe.`,
    );
  }

  return { ...preview, imported, skipped, importId, warnings };
}
