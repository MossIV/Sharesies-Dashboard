/**
 * Phase 0 spike: call Akahu with the real tokens and decide the gate.
 *
 *   npm run spike
 *
 * Read-only. It fetches `GET /me` and `GET /accounts`, prints what is actually
 * there, and writes a redacted fixture to `fixtures/` so the parser keeps being
 * tested against a real shape instead of an invented one.
 *
 * The gate (plan section 11, Phase 0): if `meta.portfolio` carries holdings, the
 * allocation donut has data. If only a balance comes back, the dashboard is
 * value-only and still fully useful for tracking a goal.
 *
 * Redaction is deliberate: ids, names and account numbers are replaced, while the
 * shape, types and key names are preserved. A fixture with the real account number
 * in it would be a leak waiting to be committed.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AkahuSource } from "../src/sources/AkahuSource.ts";
import { extractItems, isRecord, normalizeAccounts } from "../src/sources/parse-akahu.ts";
import { REPO_ROOT } from "../src/db/client.ts";

const REDACT_KEYS = ["_id", "id", "account_number", "accountNumber", "number", "email", "user_id", "reference", "logo"];

function redact(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (typeof value === "string") {
    if (REDACT_KEYS.includes(key)) return `<redacted:${value.length}ch>`;
    // Bank account numbers are 12-16 digits. The bar is set above 6 because
    // Sharesies fund symbols are six-digit codes (450002), and redacting those
    // would leave a fixture that no longer matches the real shape.
    if (/^\d{10,}$/.test(value)) return `<redacted:${value.length}ch>`;
    if (/^[A-Za-z0-9_-]{24,}$/.test(value) && !value.includes(" ")) return `<redacted:${value.length}ch>`;
  }
  return value;
}

function describe(value: unknown, depth = 0, maxDepth = 2): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[] (empty)";
    return `array[${value.length}] of ${describe(value[0], depth + 1, maxDepth)}`;
  }
  if (isRecord(value)) {
    if (depth >= maxDepth) return `object{${Object.keys(value).slice(0, 8).join(", ")}}`;
    return `object{ ${Object.entries(value)
      .map(([k, v]) => `${k}: ${describe(v, depth + 1, maxDepth)}`)
      .join(", ")} }`;
  }
  if (typeof value === "string") return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  return String(value);
}

async function main(): Promise<void> {
  const source = new AkahuSource({ log: (message) => console.log(`  [akahu] ${message}`) });

  if (!AkahuSource.isConfigured()) {
    console.error("AKAHU_APP_TOKEN and AKAHU_USER_TOKEN are not both set in .env.");
    process.exitCode = 1;
    return;
  }

  console.log("\n=== GET /me ===");
  const me = await source.getMe<Record<string, unknown>>();
  const meRecord = (extractItems(me)[0] ?? {}) as Record<string, unknown>;
  console.log(`  keys: ${Object.keys(me).join(", ")}`);
  console.log(`  item: ${describe(meRecord, 0, 2)}`);
  if ("access_granted_at" in meRecord) {
    console.log(`  access granted: ${String(meRecord["access_granted_at"])}`);
  }
  console.log(
    "  note: a personal app's /me carries no profile fields (no name or email),\n" +
      "        so the spike reports shape only. The connections come from /accounts.",
  );

  console.log("\n=== GET /accounts (raw shape) ===");
  const raw = await source.request<unknown>("/accounts");
  const items = extractItems(raw);
  console.log(`  items: ${items.length}`);
  console.log(`  first item: ${describe(items[0], 0, 3)}`);

  console.log("\n=== accounts, as the collector sees them ===");
  const accounts = normalizeAccounts(raw);
  for (const account of accounts) {
    const refreshed = account.sourceRefreshedAt ?? "never";
    console.log(
      `\n  ${account.accountName}\n` +
        `    connection:   ${account.connectionName ?? "?"}\n` +
        `    type:         ${account.accountType ?? "?"}\n` +
        `    status:       ${account.status}\n` +
        `    value:        ${account.valueNzd} ${account.currency}\n` +
        `    refreshed:    ${refreshed}\n` +
        `    holdings:     ${account.holdings.length}`,
    );
    for (const holding of account.holdings) {
      console.log(`      - ${holding.name ?? "?"} ${holding.units ?? "?"} units = ${holding.value ?? "?"}`);
    }
  }

  console.log("\n=== meta, which decides the gate ===");
  for (const item of items) {
    if (!isRecord(item)) continue;
    const meta = item["meta"];
    console.log(`  ${String(item["name"])} -> meta: ${describe(meta, 0, 4)}`);
  }

  const withHoldings = accounts.filter((account) => account.holdings.length > 0);
  const total = accounts.reduce((sum, account) => sum + account.valueNzd, 0);

  console.log("\n=== Phase 0 gate ===");
  console.log(`  accounts seen:   ${accounts.length}`);
  console.log(`  total value:     ${total.toFixed(2)}`);
  console.log(`  with holdings:   ${withHoldings.length}`);
  console.log(
    withHoldings.length > 0
      ? "  VERDICT: holdings are present, so the allocation view has data."
      : "  VERDICT: value-only. No holdings in meta.portfolio, so ignore the allocation card.",
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const fixturePath = join(REPO_ROOT, "fixtures", `akahu-accounts.spike-${stamp}.json`);
  writeFileSync(fixturePath, `${JSON.stringify(redact(raw), null, 2)}\n`);
  console.log(`\n  Redacted fixture written to ${fixturePath}\n`);
}

try {
  await main();
} catch (error) {
  console.error(`\nSpike failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}