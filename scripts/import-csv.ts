/**
 * Import a Sharesies transaction report from the command line.
 *
 *   npm run import:csv -- --file path/to/report.csv
 *   npm run import:csv -- --file report.csv --apply
 *   npm run import:csv -- --file report.csv --apply --categories deposit,buy
 *   npm run import:csv -- --file report.csv --date-format mdy
 *
 * Previews by default: nothing is written without --apply.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { importSharesiesReport } from "../src/import/sharesies-report.ts";
import type { DateFormat, RowCategory } from "../src/import/csv.ts";
import { nzd } from "../src/format.ts";

const DATE_FORMATS = ["iso", "dmy", "mdy", "named"] as const;

interface Args {
  file: string | null;
  apply: boolean;
  categories: RowCategory[] | null;
  dateFormat: DateFormat | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: null, apply: false, categories: null, dateFormat: null };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const next = argv[index + 1];

    if (arg === "--apply") args.apply = true;
    else if (arg === "--file" && next) {
      args.file = next;
      index += 1;
    } else if (arg.startsWith("--file=")) args.file = arg.slice("--file=".length);
    else if (arg === "--categories" && next) {
      args.categories = next.split(",").map((entry) => entry.trim()).filter(Boolean) as RowCategory[];
      index += 1;
    } else if (arg === "--date-format" && next) {
      if (!DATE_FORMATS.includes(next as DateFormat)) {
        throw new Error(`--date-format must be one of: ${DATE_FORMATS.join(", ")}`);
      }
      args.dateFormat = next as DateFormat;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (args.file === null) {
      args.file = arg;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("Usage: npm run import:csv -- --file <report.csv> [--apply] [--categories deposit,buy]");
    process.exit(1);
  }

  const filePath = resolve(args.file);
  const csv = readFileSync(filePath, "utf8");

  const db = openDb();
  migrate(db);

  const outcome = await importSharesiesReport(db, {
    csv,
    filename: filePath,
    mode: args.apply ? "apply" : "preview",
    options: {
      ...(args.categories ? { categories: args.categories } : {}),
      ...(args.dateFormat ? { dateFormat: args.dateFormat } : {}),
    },
  });

  console.log(`\n${filePath}`);
  console.log(
    `  delimiter ${JSON.stringify(outcome.plan.delimiter)} · dates ${outcome.plan.dateFormat}` +
      (outcome.plan.dateAmbiguous ? " (ambiguous, assumed day/month/year)" : "") +
      ` · ${outcome.transactions.length} row(s)`,
  );

  const counts = Object.entries(outcome.plan.counts).filter(([, count]) => count > 0);
  console.log(`  found: ${counts.map(([category, count]) => `${category} ${count}`).join(", ") || "nothing"}`);

  const currencies = Object.entries(outcome.plan.currencies);
  if (currencies.length > 0) {
    console.log(`  currencies: ${currencies.map(([code, count]) => `${code} ${count}`).join(", ")}` +
      (outcome.fx.source === "none" ? "" : ` (converted via ${outcome.fx.source}, ${outcome.fx.requests} request(s))`));
  }

  if (outcome.accounts.length > 0) {
    console.log("  portfolios:");
    for (const match of outcome.accounts) {
      const where = match.accountId === null
        ? `NO MATCH (${match.status}${match.candidates.length > 0 ? `: ${match.candidates.join(", ")}` : ""})`
        : match.accountName;
      console.log(`    ${match.portfolio.padEnd(24)} -> ${where}`);
    }
  }

  if (outcome.plan.unrecognisedColumns.length > 0) {
    console.log(`  ignored columns: ${outcome.plan.unrecognisedColumns.join(", ")}`);
  }

  console.log("\n  rows that would become contributions:");
  if (outcome.selected.length === 0) console.log("    (none)");
  for (const row of outcome.selected) {
    const amount = row.currency === "NZD" || row.amountNzd === null ? { value: row.amountNzd ?? row.amount, text: "" } : { value: row.amountNzd, text: `${row.currency} ${row.amount} @ ${row.fxRate}` };
    const target = row.accountName ? `  ${row.accountName}${row.accountInScope ? "" : " (outside the goal)"}` : "  (unattributed)";
    console.log(
      `    ${row.date ?? "??????????"}  ${nzd(amount.value).padStart(11)}  ` +
        `${row.category.padEnd(7)}  ${row.description}${target}${amount.text ? `  [${amount.text}]` : ""}`,
    );
  }

  if (outcome.fx.unconverted > 0) {
    console.log(`\n  ${outcome.fx.unconverted} row(s) could not be converted and were left out.`);
  }
  if (outcome.outsideGoal > 0) console.log(`  ${outcome.outsideGoal} row(s) belong to an account outside the goal.`);

  const ignored = outcome.transactions.length - outcome.selected.length;
  if (ignored > 0) console.log(`\n  ${ignored} row(s) not selected for import.`);

  for (const warning of outcome.warnings) console.log(`\n  ! ${warning}`);

  if (args.apply) {
    console.log(
      `\n  Applied: ${outcome.imported} imported, ${outcome.skipped} already present ` +
        `(import #${outcome.importId}).\n`,
    );
  } else {
    console.log("\n  Preview only. Re-run with --apply to write these rows.\n");
  }

  db.close();
}

await main();
