/**
 * The Sharesies transaction report importer (plan section 6, option 2).
 *
 * Parsing and classification live in `csv.ts`; this file is the part that writes
 * to the database, and it writes only what the caller selected.
 *
 * Two deliberate properties:
 *
 *   - Dry run is the default. A preview returns exactly the rows an apply would
 *     insert, so the UI can show them before anything changes.
 *   - Importing the same file twice adds nothing. Each row gets a content hash as
 *     its `external_ref`, and `importContribution` skips a reference it has
 *     already seen.
 */
import type { DatabaseSync } from "node:sqlite";
import { importContribution, recordImport } from "../db/repo.ts";
import {
  buildImportPlan,
  importableRows,
  parseCsv,
  type DateFormat,
  type ImportPlan,
  type ParsedCsv,
  type RowCategory,
} from "./csv.ts";

export interface ReportOptions {
  categories?: RowCategory[];
  dateFormat?: DateFormat;
}

export interface ReportTransaction {
  rowNumber: number;
  date: string | null;
  description: string;
  category: RowCategory;
  amountNzd: number;
  balance: number | null;
  externalRef: string;
}

export interface ImportOutcome {
  plan: ImportPlan;
  /** All rows in the file, whether or not they are wanted as contributions. */
  transactions: ReportTransaction[];
  /** The rows an apply would insert (or did insert, when `mode` is "apply"). */
  selected: ReportTransaction[];
  imported: number;
  skipped: number;
  importId: number | null;
  warnings: string[];
}

/**
 * Turn a plan into typed transactions, picking up the balance column on the way.
 *
 * Kept separate from the plan so `csv.ts` does not need to know about balances,
 * which only the CSV source cares about.
 */
export function splitRows(plan: ImportPlan, parsed: ParsedCsv): ReportTransaction[] {
  const balanceIndex = plan.columns.balance;

  return plan.candidates.map((candidate, index) => {
    const row = parsed.rows[index] ?? [];
    const rawBalance = balanceIndex === undefined ? "" : (row[balanceIndex] ?? "").trim();
    const balance = rawBalance === "" ? null : Number(rawBalance.replace(/[,\s$]/g, ""));

    return {
      rowNumber: candidate.rowNumber,
      date: candidate.date,
      description: candidate.description,
      category: candidate.category,
      amountNzd: candidate.amountNzd,
      balance: balance !== null && Number.isFinite(balance) ? balance : null,
      externalRef: candidate.externalRef,
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

/**
 * Preview or apply a report.
 *
 * `mode: "preview"` never writes. `mode: "apply"` writes the selected rows and
 * records the run in the `imports` table either way.
 */
export function importSharesiesReport(
  db: DatabaseSync,
  input: {
    csv: string;
    filename?: string | null;
    mode?: "preview" | "apply";
    options?: ReportOptions;
  },
): ImportOutcome {
  const mode = input.mode ?? "preview";
  const options = input.options ?? {};
  const parsed = parseCsv(input.csv);

  // The plan must be built with the caller's category selection so that its
  // warnings reflect what they asked for.
  const plan = buildImportPlan(parsed, options);
  const transactions = splitRows(plan, parsed);

  const selectedRefs = new Set(
    importableRows(plan, options).map((candidate) => candidate.externalRef),
  );
  const selected = transactions.filter((transaction) => selectedRefs.has(transaction.externalRef));

  const warnings = [...plan.warnings];

  if (mode === "preview") {
    return { plan, transactions, selected, imported: 0, skipped: 0, importId: null, warnings };
  }

  let imported = 0;
  let skipped = 0;

  for (const transaction of selected) {
    const result = importContribution(db, {
      contributionDate: transaction.date!,
      amountNzd: transaction.amountNzd,
      note: `Sharesies report: ${transaction.description}`.slice(0, 300),
      source: "csv",
      externalRef: transaction.externalRef,
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
    },
  });

  if (skipped > 0) {
    warnings.push(
      `${skipped} row(s) were already in the log and were skipped, so importing the same file twice is safe.`,
    );
  }

  return { plan, transactions, selected, imported, skipped, importId, warnings };
}