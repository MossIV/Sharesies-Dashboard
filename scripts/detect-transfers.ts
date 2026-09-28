/**
 * Propose contributions from the bank feed (plan section 6, option 1).
 *
 *   npm run detect-transfers
 *   npm run detect-transfers -- --from 2026-01-01 --to 2026-09-30
 *   npm run detect-transfers -- --apply          # record the high-confidence ones
 *   npm run detect-transfers -- --apply --min-confidence high --direction in
 *
 * Read-only unless --apply is passed.
 */
import { openDb, todayNz } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { findContributionByRef, importContribution, listAccounts } from "../src/db/repo.ts";
import { AkahuSource } from "../src/sources/AkahuSource.ts";
import { normalizeTransactions } from "../src/sources/parse-transactions.ts";
import { detectTransfers, defaultKeywords, type Confidence } from "../src/import/detect-transfers.ts";
import { nzd } from "../src/format.ts";

interface Args {
  from: string;
  to: string;
  apply: boolean;
  minConfidence: Confidence;
  direction: "in" | "out" | "both";
}

function parseArgs(argv: string[], today: string): Args {
  const args: Args = {
    from: new Date(Date.parse(`${today}T00:00:00.000Z`) - 90 * 86_400_000).toISOString().slice(0, 10),
    to: today,
    apply: false,
    minConfidence: "high",
    direction: "both",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const next = argv[index + 1];

    if (arg === "--apply") args.apply = true;
    else if (arg === "--from" && next) {
      args.from = next;
      index += 1;
    } else if (arg === "--to" && next) {
      args.to = next;
      index += 1;
    } else if (arg === "--min-confidence" && next) {
      if (next !== "high" && next !== "medium") throw new Error("--min-confidence must be high or medium");
      args.minConfidence = next;
      index += 1;
    } else if (arg === "--direction" && next) {
      if (next !== "in" && next !== "out" && next !== "both") {
        throw new Error("--direction must be in, out or both");
      }
      args.direction = next;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const today = todayNz();
  const args = parseArgs(process.argv.slice(2), today);

  if (!AkahuSource.isConfigured()) {
    console.error(
      "Bank transfer detection needs Akahu.\n" +
        "Set AKAHU_APP_TOKEN and AKAHU_USER_TOKEN in .env (see .env.example), or use " +
        "`npm run import:csv` with a Sharesies report instead.",
    );
    process.exit(1);
  }

  const db = openDb();
  migrate(db);

  const source = new AkahuSource({ log: (message) => console.log(`  · ${message}`) });
  console.log(`\nScanning ${args.from} to ${args.to} for ${defaultKeywords().join(" / ")}…`);

  const page = await source.fetchTransactions({ from: args.from, to: args.to });
  const transactions = normalizeTransactions({ items: page.items });

  const accounts = listAccounts(db);
  const result = detectTransfers(transactions, {
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      accountName: account.accountName,
      connectionName: account.connectionName,
    })),
  });

  console.log(
    `  ${transactions.length} transaction(s) over ${page.pages} page(s) · ` +
      `${result.candidates.length} mention ${result.keywords.join(" / ")}`,
  );

  const selected = result.candidates.filter(
    (candidate) =>
      !candidate.alreadyImported &&
      (args.direction === "both" || candidate.direction === args.direction) &&
      (args.minConfidence === "medium" || candidate.confidence === "high"),
  );

  for (const candidate of result.candidates) {
    const imported = findContributionByRef(db, candidate.externalRef) !== null;
    const marker = imported ? "logged" : candidate.confidence;
    console.log(
      `    ${candidate.date}  ${nzd(candidate.amountNzd).padStart(11)}  ` +
        `${candidate.direction === "in" ? "into" : "out of"}  ` +
        `${marker.padEnd(7)}  ${candidate.description}`,
    );
  }

  const alreadyLogged = result.candidates.filter((c) => findContributionByRef(db, c.externalRef) !== null).length;
  console.log(
    `\n  ${result.summary.matched} matched · ${alreadyLogged} already logged · ` +
      `${result.summary.internal} internal to the provider · ${result.summary.unmatched} unrelated`,
  );

  for (const warning of result.warnings) console.log(`\n  ! ${warning}`);

  if (args.apply) {
    let imported = 0;
    let skipped = 0;
    for (const candidate of selected) {
      const outcome = importContribution(db, {
        contributionDate: candidate.date,
        amountNzd: candidate.contributionAmount,
        note: `Bank transfer: ${candidate.description}`.slice(0, 300),
        source: "bank",
        externalRef: candidate.externalRef,
      });
      if (outcome.skipped) skipped += 1;
      else imported += 1;
    }
    console.log(
      `\n  Applied: ${imported} imported, ${skipped} already present ` +
        `(min confidence ${args.minConfidence}, direction ${args.direction}).\n`,
    );
  } else {
    console.log(
      `\n  Preview only. ${selected.length} row(s) would be imported with --apply ` +
        `(min confidence ${args.minConfidence}, direction ${args.direction}).\n`,
    );
  }

  db.close();
}

await main();
