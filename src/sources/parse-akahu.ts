/**
 * Defensive parsing of Akahu payloads (plan section 2, consequence 3).
 *
 * Everything here is a pure function over `unknown` so it can be tested against
 * saved fixtures. Akahu's documented shape is:
 *
 *   { success: true, items: [ { _id, name, status, type, connection, balance, refreshed, meta } ] }
 *
 * but `meta` is explicitly "passed straight through from integrations, making
 * [it] very inconsistent", and `meta.portfolio` / `meta.breakdown` "may be
 * unavailable or poorly specified". So: never assume, always fall back.
 */
import type { AccountStatus, Holding, NormalizedAccount } from "./PortfolioSource.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Numbers may arrive as numbers, numeric strings, or `{ amount: n }` wrappers. */
export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[,\s$]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  if (isRecord(value) && "amount" in value) return num(value["amount"]);
  return null;
}

export function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/** Akahu wraps list responses in `{ success, items }`. Tolerate a bare array. */
export function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    for (const key of ["items", "data", "accounts"]) {
      const candidate = payload[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

/** Best-effort read of the value from one of several possible key spellings. */
function firstOf(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

const HOLDING_CONTAINER_KEYS = [
  "portfolio",
  "breakdown",
  "holdings",
  "funds",
  "investments",
  "instruments",
  "positions",
  "allocation",
];

const HOLDING_FIELDS = {
  name: ["name", "title", "label", "fund_name", "instrument_name", "security_name", "description"],
  symbol: ["symbol", "ticker", "code", "instrument_code", "isin"],
  units: ["units", "quantity", "unit_balance", "shares", "balance", "units_held"],
  value: [
    "value",
    "amount",
    "value_nzd",
    "current_value",
    "total_value",
    "market_value",
    "holding_value",
    "converted_value",
  ],
};

/**
 * Walk a meta object looking for a list of holdings, newest shape first.
 * Depth-limited so a pathological payload cannot blow the stack.
 */
function findHoldingArray(value: unknown, depth = 0): unknown[] | null {
  if (depth > 3) return null;

  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    return records.length > 0 ? records : null;
  }

  if (isRecord(value)) {
    // Prefer a well-known container key before descending blindly.
    for (const key of HOLDING_CONTAINER_KEYS) {
      if (key in value) {
        const found = findHoldingArray(value[key], depth + 1);
        if (found) return found;
      }
    }
    // A map of { symbol: { units, value } } is also common.
    const values = Object.values(value);
    if (values.length > 0 && values.every((entry) => isRecord(entry))) {
      return values as unknown[];
    }
    for (const entry of values) {
      const found = findHoldingArray(entry, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

/** Extract holdings from an account's `meta`, or `[]` when nothing is usable. */
export function extractHoldings(meta: unknown): Holding[] {
  if (!isRecord(meta)) return [];
  const candidate = findHoldingArray(meta);
  if (!candidate) return [];

  return candidate.filter(isRecord).map((entry) => ({
    name: str(firstOf(entry, HOLDING_FIELDS.name)),
    symbol: str(firstOf(entry, HOLDING_FIELDS.symbol)),
    units: num(firstOf(entry, HOLDING_FIELDS.units)),
    value: num(firstOf(entry, HOLDING_FIELDS.value)),
    raw: entry,
  }));
}

function parseStatus(value: unknown): AccountStatus {
  return String(value).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE";
}

/** Parse one account object, or return null when it is unusable. */
export function parseAccount(raw: unknown): NormalizedAccount | null {
  if (!isRecord(raw)) return null;

  const accountId = str(raw["_id"]) ?? str(raw["id"]);
  const balance = isRecord(raw["balance"]) ? raw["balance"] : {};
  const value = num(balance["current"]);
  const currency = str(balance["currency"]) ?? str(raw["currency"]) ?? "NZD";
  const connection = isRecord(raw["connection"]) ? raw["connection"] : {};
  const refreshed = isRecord(raw["refreshed"]) ? raw["refreshed"] : {};

  // Without an id we cannot key a snapshot, and without a balance there is
  // nothing to record. Either way the account is not usable.
  if (!accountId || value === null) return null;

  return {
    accountId,
    accountName: str(raw["name"]) ?? accountId,
    connectionName: str(connection["name"]),
    accountType: str(raw["type"]),
    valueNzd: value,
    currency,
    status: parseStatus(raw["status"]),
    sourceRefreshedAt: str(refreshed["balance"]) ?? str(refreshed["meta"]),
    holdings: extractHoldings(raw["meta"]),
    raw,
  };
}

/** Parse every usable account in a `GET /accounts` response. */
export function normalizeAccounts(payload: unknown): NormalizedAccount[] {
  return extractItems(payload)
    .map(parseAccount)
    .filter((account): account is NormalizedAccount => account !== null);
}
