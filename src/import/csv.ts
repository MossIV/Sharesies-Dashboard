/**
 * CSV parsing and classification for the Sharesies transaction report
 * (plan section 6, option 2).
 *
 * Two things worth knowing before reading this:
 *
 *  1. Sharesies documents the export as "a report of all your buy and sell
 *     transactions". It is not a deposit ledger, so rows are *classified* and
 *     only the ones the caller asks for are imported. Guessing that every row is
 *     a contribution would double-count the portfolio.
 *  2. Their export format is not published as a spec, so nothing here is
 *     hard-coded to one column layout. Headers are matched against synonym sets,
 *     unrecognised columns are reported, and the caller can see exactly what was
 *     detected before anything is written.
 *
 * Everything in this file is pure: no database, no filesystem.
 */
import { createHash } from "node:crypto";

export interface ParsedCsv {
  /** Detected delimiter, for the report. */
  delimiter: string;
  header: string[];
  rows: string[][];
  /** Rows that had fewer cells than the header, which usually means a broken file. */
  raggedRows: number;
}

/** Sniff the delimiter from the header line, quoting-aware. */
function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const candidate of candidates) {
    // Count occurrences outside quotes.
    let count = 0;
    let inQuotes = false;
    for (let index = 0; index < firstLine.length; index++) {
      const char = firstLine[index];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/**
 * RFC 4180-style parse: quoted fields, doubled quotes for a literal quote,
 * embedded newlines inside quotes, CRLF or LF, and an optional BOM.
 */
export function parseCsv(input: string, delimiter?: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, "");
  const sep = delimiter ?? sniffDelimiter(text);

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let index = 0;

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    // Skip lines that are entirely empty (common at the end of an export).
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === sep) {
      pushField();
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      pushRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== "" || row.length > 0) pushRow();

  const header = (rows.shift() ?? []).map((cell) => cell.trim());
  const width = header.length;
  const raggedRows = rows.filter((row) => row.length !== width).length;

  return { delimiter: sep, header, rows, raggedRows };
}

/** Normalise a header cell for matching: lowercase, letters and digits only. */
export function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COLUMN_SYNONYMS = {
  date: ["date", "transactiondate", "tradedate", "settlementdate", "createddate", "time", "timestamp"],
  type: ["type", "transactiontype", "ordertype", "action", "activity", "direction"],
  description: ["description", "details", "narrative", "memo", "note", "notes", "transaction", "reason"],
  amount: ["amount", "value", "amountnzd", "nzdamount", "netamount", "total", "transactionamount", "cashamount"],
  balance: ["balance", "runningbalance", "closingbalance", "accountbalance", "portfoliovalue", "totalvalue", "holdingvalue"],
  units: ["units", "quantity", "shares", "unitbalance", "unitsheld"],
  price: ["price", "unitprice", "shareprice", "rate"],
  symbol: ["symbol", "ticker", "code", "instrumentcode", "isin", "fundcode"],
  instrument: ["instrument", "fund", "security", "company", "name", "investment"],
} as const;

export type ColumnRole = keyof typeof COLUMN_SYNONYMS;

export type ColumnMap = Partial<Record<ColumnRole, number>>;

/** Match header cells to roles. First match wins; unmatched columns are ignored. */
export function detectColumns(header: string[]): ColumnMap {
  const normalised = header.map(normaliseHeader);
  const map: ColumnMap = {};

  for (const [role, synonyms] of Object.entries(COLUMN_SYNONYMS) as [ColumnRole, readonly string[]][]) {
    for (const synonym of synonyms) {
      const index = normalised.indexOf(synonym);
      if (index !== -1) {
        map[role] = index;
        break;
      }
    }
  }

  // Loose second pass: a header like "Transaction amount (NZD)" or "Date/time".
  for (const [role, synonyms] of Object.entries(COLUMN_SYNONYMS) as [ColumnRole, readonly string[]][]) {
    if (map[role] !== undefined) continue;
    for (const synonym of synonyms) {
      const index = normalised.findIndex((cell) => cell !== "" && cell.includes(synonym));
      if (index !== -1) {
        map[role] = index;
        break;
      }
    }
  }

  return map;
}

// ------------------------------------------------------------------ categories

export type RowCategory =
  | "deposit"
  | "withdrawal"
  | "buy"
  | "sell"
  | "dividend"
  | "fee"
  | "interest"
  | "transfer"
  | "unknown";

/** Keywords per category, matched against type + description, longest first. */
const CATEGORY_KEYWORDS: [RowCategory, string[]][] = [
  ["deposit", [
    "topup", "top-up", "top up", "deposit", "addfunds", "add funds", "cashin", "cash in",
    "contribution", "paymentreceived", "moneyin", "transferin", "transfer in", "depositreceived",
  ]],
  ["withdrawal", [
    "withdrawal", "withdraw", "cashout", "cash out", "payout", "transferout", "transfer out",
    "moneyout", "redemption to bank", "refundto", "refund to",
  ]],
  ["dividend", ["dividend", "distribution", "returnofcapital", "return of capital"]],
  ["interest", ["interest", "interestpayment"]],
  ["fee", ["fee", "commission", "charges", "charge", "brokerage", "tax", "withholding"]],
  ["sell", ["sell", "sale", "sold", "redemption", "redeem", "disposal", "market sell"]],
  ["buy", ["buy", "purchase", "purchased", "bought", "subscription", "invest", "market buy", "auto-invest"]],
  ["transfer", ["transfer", "swap", "movement", "rebalance"]],
];

export interface Classification {
  category: RowCategory;
  /** The keyword that decided it, for the preview table. */
  matched: string | null;
}

/**
 * Classify from the type and description text. Deliberately text-first: the
 * amount sign alone cannot tell a buy from a deposit.
 *
 * Keywords match on word boundaries, not raw substrings. Without that, the
 * "invest" keyword swallows "Wallet to investment" and a wallet transfer is
 * silently imported as a buy.
 */
export function classifyRow(type: string, description: string): Classification {
  const haystack = `${type} ${description}`.toLowerCase().replace(/\s+/g, " ").trim();

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      // A trailing "s" is allowed so "fees", "deposits" and "top ups" match their
      // singular keywords, while whole-word boundaries keep "invest" out of
      // "investment".
      const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`);
      if (pattern.test(haystack)) return { category, matched: keyword };
    }
  }
  return { category: "unknown", matched: null };
}

// ----------------------------------------------------------------------- dates

export type DateFormat = "iso" | "dmy" | "mdy" | "named" | "unknown";

export interface DateParseResult {
  date: string | null;
  /** "03/04/2026" is the same string in two formats; the caller must be told. */
  ambiguous: boolean;
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isoFromParts(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) return null;
  const candidate = `${year}-${pad(month)}-${pad(day)}`;
  // Reject impossible calendar dates such as 31/02: round-tripping catches them.
  const check = new Date(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== day) return null;
  return candidate;
}

/**
 * Work out the file's date convention from every date-looking cell.
 *
 * Ambiguity is real and not guessable: with NZ data DD/MM/YYYY is the norm, so
 * that is the assumption, but it is reported back so the UI can say so rather
 * than silently mis-dating a year of contributions.
 */
export function detectDateFormat(samples: string[]): { format: DateFormat; ambiguous: boolean } {
  let sawSlashOrDash = false;
  let firstOver12 = false;
  let secondOver12 = false;

  for (const sample of samples) {
    const value = (sample ?? "").trim();
    if (value === "") continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return { format: "iso", ambiguous: false };
    if (/[a-z]{3,}/i.test(value)) return { format: "named", ambiguous: false };

    const match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
    if (!match) continue;
    sawSlashOrDash = true;
    if (Number(match[1]) > 12) firstOver12 = true;
    if (Number(match[2]) > 12) secondOver12 = true;
  }

  if (!sawSlashOrDash) return { format: "unknown", ambiguous: false };
  if (firstOver12 && !secondOver12) return { format: "dmy", ambiguous: false };
  if (secondOver12 && !firstOver12) return { format: "mdy", ambiguous: false };
  // Either nothing exceeded 12, or both did (a malformed file): default to NZ.
  return { format: "dmy", ambiguous: !firstOver12 && !secondOver12 };
}

export function parseDateCell(value: string, format: DateFormat): DateParseResult {
  const text = (value ?? "").trim();
  if (text === "") return { date: null, ambiguous: false };

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return { date: isoFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3])), ambiguous: false };

  const numeric = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(text);
  if (numeric) {
    let year = Number(numeric[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);

    // An explicit month/day/year request is honoured even when the string is
    // ambiguous, otherwise the caller cannot override the NZ default.
    if (format === "mdy") {
      const asMdy = isoFromParts(year, first, second);
      if (asMdy) return { date: asMdy, ambiguous: false };
      return { date: isoFromParts(year, second, first), ambiguous: true };
    }

    // DD/MM/YYYY is the NZ convention and the documented default.
    return {
      date: isoFromParts(year, second, first),
      ambiguous: format === "unknown" && first <= 12 && second <= 12,
    };
  }

  const named = /^(\d{1,2})[\s-]+([a-z]{3,})[\s-]+(\d{2,4})$/i.exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[2]!.slice(0, 3).toLowerCase()) + 1;
    let year = Number(named[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return { date: isoFromParts(year, month, Number(named[1])), ambiguous: false };
  }

  const namedFirst = /^([a-z]{3,})[\s-]+(\d{1,2})[\s-]+(\d{2,4})$/i.exec(text);
  if (namedFirst) {
    const month = MONTHS.indexOf(namedFirst[1]!.slice(0, 3).toLowerCase()) + 1;
    let year = Number(namedFirst[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return { date: isoFromParts(year, month, Number(namedFirst[2])), ambiguous: false };
  }

  return { date: null, ambiguous: false };
}

// ---------------------------------------------------------------------- amounts

/** Money cells may carry currency symbols, thousands separators or brackets. */
export function parseAmountCell(value: string): number | null {
  let text = (value ?? "").trim();
  if (text === "") return null;

  // Spreadsheets, mobile keyboards and PDF extracts emit different minus signs;
  // U+2212 and the en/em dashes all mean "negative" but fail an ASCII test.
  text = text.replace(/[\u2212\u2013\u2014]/g, "-");

  // Brackets and a leading minus are negatives; some exports trail the sign.
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text) || /-\s*$/.test(text);
  const cleaned = text
    .replace(/[()$,\s]/g, "")
    .replace(/^[-+]/, "")
    .replace(/-$/, "")
    .replace(/[^0-9.]/g, "");
  if (cleaned === "" || !/^\d*\.?\d*$/.test(cleaned) || cleaned === ".") return null;

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

export function parseNumberCell(value: string): number | null {
  const text = (value ?? "").trim();
  if (text === "") return null;
  const cleaned = text.replace(/[,\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------- planner

export interface ImportCandidate {
  /** Stable across re-imports of the same file: the idempotency key. */
  externalRef: string;
  rowNumber: number;
  date: string | null;
  description: string;
  category: RowCategory;
  amountNzd: number;
  /** Why the row was classified this way, or why it is unusable. */
  reason: string;
  problem: string | null;
}

export interface ImportPlan {
  delimiter: string;
  columns: ColumnMap;
  /** Header names that matched no known role. */
  unrecognisedColumns: string[];
  dateFormat: DateFormat;
  dateAmbiguous: boolean;
  raggedRows: number;
  counts: Record<RowCategory, number>;
  candidates: ImportCandidate[];
  warnings: string[];
}

const EMPTY_COUNTS = (): Record<RowCategory, number> => ({
  deposit: 0, withdrawal: 0, buy: 0, sell: 0, dividend: 0, fee: 0, interest: 0, transfer: 0, unknown: 0,
});

export interface PlanOptions {
  /** Categories to treat as contributions. Default: deposits only. */
  categories?: RowCategory[];
  /** Force a date convention instead of detecting it. */
  dateFormat?: DateFormat;
}

function hashRef(parts: (string | number)[]): string {
  return `csv:${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

/**
 * Turn a parsed CSV into a plan: what was detected, what each row looks like, and
 * which rows would become contributions. Nothing is written here.
 */
export function buildImportPlan(parsed: ParsedCsv, options: PlanOptions = {}): ImportPlan {
  const wanted = new Set<RowCategory>(options.categories ?? ["deposit"]);
  const columns = detectColumns(parsed.header);
  const warnings: string[] = [];

  const unrecognisedColumns = parsed.header.filter((cell, index) =>
    cell.trim() !== "" &&
    !Object.values(columns).includes(index)
  );

  if (parsed.raggedRows > 0) {
    warnings.push(
      `${parsed.raggedRows} row(s) did not have the same number of columns as the header. ` +
        "Check that the export is complete.",
    );
  }
  if (columns.date === undefined) warnings.push("No date column was recognised; rows cannot be imported.");
  if (columns.amount === undefined) warnings.push("No amount column was recognised; rows cannot be imported.");
  if (columns.type === undefined && columns.description === undefined) {
    warnings.push("Neither a type nor a description column was recognised, so rows cannot be classified.");
  }

  const cellsAt = (row: string[], role: ColumnRole): string => {
    const index = columns[role];
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  // Date convention is decided from the whole file, not row by row.
  const dateSamples = parsed.rows.map((row) => cellsAt(row, "date"));
  const detected = options.dateFormat && options.dateFormat !== "unknown"
    ? { format: options.dateFormat, ambiguous: false }
    : detectDateFormat(dateSamples);

  if (detected.ambiguous) {
    warnings.push(
      "Every date in this file is ambiguous (for example 03/04/2026). " +
        "Day/month/year was assumed, which is the NZ convention. Confirm the dates in the preview, " +
        "or pass dateFormat explicitly.",
    );
  }

  const counts = EMPTY_COUNTS();
  const candidates: ImportCandidate[] = [];
  let sawNonDeposit = false;

  parsed.rows.forEach((row, index) => {
    const type = cellsAt(row, "type");
    const description = cellsAt(row, "description") || type;
    const { category, matched } = classifyRow(type, description);
    counts[category] += 1;
    if (category !== "deposit" && category !== "unknown" && category !== "transfer") sawNonDeposit = true;

    const dateResult = parseDateCell(cellsAt(row, "date"), detected.format);
    const rawAmount = parseAmountCell(cellsAt(row, "amount"));
    const instrument = cellsAt(row, "instrument") || cellsAt(row, "symbol");

    let problem: string | null = null;
    if (dateResult.date === null) problem = "Could not read the date.";
    else if (rawAmount === null) problem = "Could not read the amount.";

    const amountNzd = rawAmount === null ? 0 : Math.round(Math.abs(rawAmount) * 100) / 100;

    candidates.push({
      externalRef: hashRef([
        dateResult.date ?? cellsAt(row, "date"),
        type,
        description,
        rawAmount ?? "",
        instrument,
      ]),
      rowNumber: index + 2, // +2: the header is line 1
      date: dateResult.date,
      description: [description, instrument].filter(Boolean).join(" · ").slice(0, 200),
      category,
      amountNzd,
      reason: matched ? `matched "${matched}"` : "no keyword matched",
      problem,
    });
  });

  if (wanted.has("deposit") && counts.deposit === 0 && sawNonDeposit) {
    warnings.push(
      "No deposits or top ups were found in this file, only buys, sells or other movements. " +
        "The Sharesies transaction report covers buy and sell transactions, so it may not contain " +
        "your deposits at all: log those manually, or import buys deliberately by selecting their " +
        "category explicitly.",
    );
  }

  return {
    delimiter: parsed.delimiter,
    columns,
    unrecognisedColumns,
    dateFormat: detected.format,
    dateAmbiguous: detected.ambiguous,
    raggedRows: parsed.raggedRows,
    counts,
    candidates,
    warnings,
  };
}

/** Rows the plan would turn into contributions, given the wanted categories. */
export function importableRows(plan: ImportPlan, options: PlanOptions = {}): ImportCandidate[] {
  const wanted = new Set<RowCategory>(options.categories ?? ["deposit"]);
  return plan.candidates.filter((candidate) => candidate.problem === null && wanted.has(candidate.category));
}
