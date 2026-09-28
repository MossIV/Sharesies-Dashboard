/**
 * `GET /transactions` parsing, kept pure so it can be exercised against recorded
 * payloads (plan section 13: Akahu cannot re-serve past values, so every fetch is
 * stored raw and the parser can be re-run over history).
 *
 * Akahu's documented shape is
 *   { _id, _account, _connection, date, description, amount, balance, type,
 *     merchant, category, meta }
 * with `merchant` and `category` present only when the transaction is enriched,
 * so nothing here depends on them. `_connection` is frequently just an id, which
 * is why connection *names* are resolved from `GET /accounts` by the caller.
 */
import { extractItems, isRecord, num, str } from "./parse-akahu.ts";

export interface NormalizedTransaction {
  transactionId: string | null;
  accountId: string | null;
  connectionId: string | null;
  /** YYYY-MM-DD, taken verbatim from the payload. */
  date: string | null;
  description: string;
  /** Negative is money leaving the account it belongs to. */
  amount: number | null;
  balance: number | null;
  type: string | null;
  merchant: string | null;
  category: string | null;
}

/**
 * Akahu dates arrive as ISO timestamps ("2026-09-01T00:00:00.000Z") where the
 * date part is already the NZ calendar date. Taking the first ten characters
 * avoids shifting a date backwards by parsing it through a timezone.
 */
function dateOnly(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match ? match[1]! : null;
}

/** `merchant` is either a string or `{ name }`; `category` is the same. */
function named(value: unknown): string | null {
  const direct = str(value);
  if (direct) return direct;
  if (isRecord(value)) return str(value["name"]) ?? str(value["label"]);
  return null;
}

export function parseTransaction(raw: unknown): NormalizedTransaction | null {
  if (!isRecord(raw)) return null;

  const type = str(raw["type"]);
  const merchant = named(raw["merchant"]);
  const description = str(raw["description"]) ?? merchant ?? type;
  if (description === null) return null;

  return {
    transactionId: str(raw["_id"]) ?? str(raw["id"]),
    accountId: str(raw["_account"]) ?? str(raw["account"]),
    connectionId: str(raw["_connection"]) ?? str(raw["connection"]),
    date: dateOnly(raw["date"] ?? raw["transaction_date"] ?? raw["created_at"]),
    description,
    amount: num(raw["amount"]),
    balance: num(raw["balance"]),
    type,
    merchant,
    category: named(raw["category"]),
  };
}

export function normalizeTransactions(payload: unknown): NormalizedTransaction[] {
  return extractItems(payload)
    .map(parseTransaction)
    .filter((transaction): transaction is NormalizedTransaction => transaction !== null);
}

/** `cursor.next` for the next page, or null at the end of the list. */
export function nextCursor(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const cursor = payload["cursor"];
  if (typeof cursor === "string") return cursor === "" ? null : cursor;
  if (isRecord(cursor)) {
    const next = cursor["next"];
    return typeof next === "string" && next !== "" ? next : null;
  }
  return null;
}
