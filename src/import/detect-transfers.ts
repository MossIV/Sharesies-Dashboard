/**
 * Bank transfer detection (plan section 6, option 1).
 *
 * The idea: a Sharesies top up leaves the bank account as a debit with
 * "SHARESIES" somewhere in the description, so the bank feed can propose
 * contributions instead of the user typing them in every month.
 *
 * Two rules keep this honest:
 *
 *   1. It only ever *proposes*. Nothing is written until the user confirms a
 *      candidate, because a keyword match is evidence, not proof.
 *   2. Movements on the Sharesies connection itself are excluded. A wallet to
 *      investment transfer is not money entering the portfolio, and counting it
 *      would double every contribution.
 *
 * Pure module: no database, no network.
 */
import type { NormalizedTransaction } from "../sources/parse-transactions.ts";

/** Types that move money out of a bank account, in either direction. */
const DEBIT_TYPES = new Set([
  "DEBIT", "PAYMENT", "DIRECT DEBIT", "STANDING ORDER", "TRANSFER", "EFTPOS", "CREDIT CARD", "ATM", "LOAN",
]);
const CREDIT_TYPES = new Set(["CREDIT", "DIRECT CREDIT", "INTEREST", "REFUND", "DEPOSIT"]);

export type Confidence = "high" | "medium";

export interface TransferCandidate {
  /** Idempotency key: the same bank transaction can only be imported once. */
  externalRef: string;
  transactionId: string | null;
  date: string;
  description: string;
  /** Absolute amount, as shown to the user. */
  amountNzd: number;
  /** "in" is money into Sharesies (a contribution); "out" is a withdrawal. */
  direction: "in" | "out";
  /** The amount to record: negative for a withdrawal. */
  contributionAmount: number;
  type: string | null;
  merchant: string | null;
  category: string | null;
  accountName: string | null;
  confidence: Confidence;
  reason: string;
  alreadyImported: boolean;
}

export interface SkippedTransaction {
  transactionId: string | null;
  date: string | null;
  description: string;
  amount: number | null;
  reason: string;
}

export interface AccountRef {
  accountId: string;
  accountName: string;
  connectionName: string | null;
}

export interface DetectOptions {
  /** Words that identify a transfer to your provider. Default: sharesies. */
  keywords?: string[];
  /** Connections to ignore because they are the provider itself. */
  excludeConnections?: string[];
  /** The accounts registry, used to resolve an account and to spot the provider. */
  accounts?: AccountRef[];
}

export interface DetectResult {
  candidates: TransferCandidate[];
  skipped: SkippedTransaction[];
  summary: {
    examined: number;
    matched: number;
    internal: number;
    unmatched: number;
    unusable: number;
  };
  keywords: string[];
  warnings: string[];
}

export function defaultKeywords(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env["TRANSFER_KEYWORDS"]?.trim();
  if (configured) {
    return configured.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
  }
  return ["sharesies"];
}

export function defaultExcludedConnections(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env["TRANSFER_EXCLUDE_CONNECTIONS"]?.trim();
  if (configured) {
    return configured.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
  }
  // Same default as the goal scope: the Sharesies connection is the portfolio.
  return [env["AKAHU_CONNECTION_MATCH"]?.trim().toLowerCase() || "sharesies"];
}

function normalise(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[\s_*]+/g, " ").trim();
}

/** Does the keyword appear as a whole word? "sharesies" must not match "shares". */
export function matchesKeyword(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

/**
 * Propose contributions from a list of bank transactions.
 *
 * @param transactions already-parsed rows from `GET /transactions`
 * @param options.accounts the accounts registry from `GET /accounts`
 */
export function detectTransfers(
  transactions: NormalizedTransaction[],
  options: DetectOptions = {},
): DetectResult {
  const keywords = options.keywords ?? defaultKeywords();
  const excluded = (options.excludeConnections ?? defaultExcludedConnections()).map((entry) => entry.toLowerCase());
  const byAccountId = new Map((options.accounts ?? []).map((account) => [account.accountId, account]));

  const candidates: TransferCandidate[] = [];
  const skipped: SkippedTransaction[] = [];
  const summary = { examined: transactions.length, matched: 0, internal: 0, unmatched: 0, unusable: 0 };

  for (const transaction of transactions) {
    const description = transaction.description;
    const account = transaction.accountId ? byAccountId.get(transaction.accountId) : undefined;

    const base = {
      transactionId: transaction.transactionId,
      date: transaction.date,
      description,
      amount: transaction.amount,
    };

    if (transaction.date === null || transaction.amount === null) {
      summary.unusable += 1;
      skipped.push({ ...base, reason: "No usable date or amount." });
      continue;
    }
    if (transaction.amount === 0) {
      summary.unusable += 1;
      skipped.push({ ...base, reason: "Zero amount." });
      continue;
    }

    // A row on the provider's own connection is an internal movement (wallet to
    // investment), not money arriving from a bank. Counting it would double
    // every contribution.
    if (account !== undefined && account.connectionName !== null &&
        excluded.some((keyword) => matchesKeyword(normalise(account.connectionName), keyword))) {
      summary.internal += 1;
      skipped.push({
        ...base,
        reason: `Movement inside ${account.connectionName}, not a bank transfer.`,
      });
      continue;
    }

    const haystack = normalise(
      [transaction.description, transaction.merchant, transaction.category, transaction.type]
        .filter(Boolean)
        .join(" "),
    );
    const matched = keywords.find((keyword) => matchesKeyword(haystack, keyword));

    if (matched === undefined) {
      summary.unmatched += 1;
      skipped.push({ ...base, reason: `No keyword (${keywords.join(", ")}) in the description.` });
      continue;
    }

    const type = (transaction.type ?? "").toUpperCase();
    const debitish = DEBIT_TYPES.has(type);
    const creditish = CREDIT_TYPES.has(type);
    const direction: "in" | "out" = transaction.amount < 0 ? "in" : "out";

    // A matched keyword with a type that agrees with the sign is strong
    // evidence; a mismatch (an unenriched or oddly-typed row) is weaker but
    // still worth showing.
    const agrees = (direction === "in" && debitish) || (direction === "out" && creditish);
    const confidence: Confidence = agrees ? "high" : "medium";
    const magnitude = Math.round(Math.abs(transaction.amount) * 100) / 100;

    summary.matched += 1;
    candidates.push({
      externalRef: `akahu:${transaction.transactionId ?? `${transaction.date}|${transaction.amount}|${description}`}`,
      transactionId: transaction.transactionId,
      date: transaction.date,
      description,
      amountNzd: magnitude,
      direction,
      contributionAmount: direction === "in" ? magnitude : -magnitude,
      type: transaction.type,
      merchant: transaction.merchant,
      category: transaction.category,
      accountName: account?.accountName ?? null,
      confidence,
      reason:
        `"${matched}" in "${description}" · type ${type || "unknown"}` +
        (agrees ? "" : " does not agree with the sign"),
      alreadyImported: false,
    });
  }

  // Newest first: the recent months are what the user is checking.
  candidates.sort((left, right) => right.date.localeCompare(left.date));

  const warnings: string[] = [];
  if (transactions.length === 0) {
    warnings.push(
      "No transactions were returned for this window. Akahu only returns what it has already " +
        "refreshed, and personal apps have a one hour rest period between refreshes.",
    );
  } else if (summary.matched === 0) {
    warnings.push(
      `No transaction in this window mentions ${keywords.join(" or ")}. ` +
        "Set TRANSFER_KEYWORDS to whatever appears on your bank statement, or log the deposits by hand.",
    );
  }

  return { candidates, skipped, summary, keywords, warnings };
}
