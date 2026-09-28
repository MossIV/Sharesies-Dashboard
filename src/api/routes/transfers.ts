import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { findContributionByRef, importContribution, listAccounts } from "../../db/repo.ts";
import { AkahuSource } from "../../sources/AkahuSource.ts";
import { normalizeTransactions } from "../../sources/parse-transactions.ts";
import { detectTransfers, type AccountRef } from "../../import/detect-transfers.ts";
import { badRequest, optDate, optString, readJson, reqDate, reqNumber } from "../validate.ts";

/** A scan window wider than this is almost certainly a mistake. */
const MAX_WINDOW_DAYS = 730;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

function defaultWindow(today: string): { from: string; to: string } {
  const to = Date.parse(`${today}T00:00:00.000Z`);
  const from = new Date(to - 90 * 86_400_000).toISOString().slice(0, 10);
  return { from, to: today };
}

export function transferRoutes(db: DatabaseSync, today: string) {
  const app = new Hono();

  const accountRefs = (): AccountRef[] =>
    listAccounts(db).map((account) => ({
      accountId: account.accountId,
      accountName: account.accountName,
      connectionName: account.connectionName,
    }));

  /**
   * Scan the bank feed for transfers to Sharesies.
   *
   * Read-only: this never writes a contribution. It returns proposals, each with
   * the reason it was proposed and whether it is already in the log.
   */
  app.post("/transfers/scan", async (c) => {
    const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
    const fallback = defaultWindow(today);
    const from = optDate(body, "from") ?? fallback.from;
    const to = optDate(body, "to") ?? fallback.to;

    if (from > to) throw badRequest("from must not be after to", { from: "after to" });
    if (daysBetween(from, to) > MAX_WINDOW_DAYS) {
      throw badRequest(`the window must be at most ${MAX_WINDOW_DAYS} days`, { from: "window too wide" });
    }

    if (!AkahuSource.isConfigured()) {
      throw badRequest(
        "Bank transfer detection needs Akahu. Set AKAHU_APP_TOKEN and AKAHU_USER_TOKEN in .env, " +
          "or import a Sharesies report instead.",
        { akahu: "not configured" },
      );
    }

    const source = new AkahuSource();
    const page = await source.fetchTransactions({ from, to });
    const transactions = normalizeTransactions({ items: page.items });

    const result = detectTransfers(transactions, { accounts: accountRefs() });

    // Mark what is already in the log, so the UI cannot offer it twice.
    const candidates = result.candidates.map((candidate) => ({
      ...candidate,
      alreadyImported: findContributionByRef(db, candidate.externalRef) !== null,
    }));

    const newOnes = candidates.filter((candidate) => !candidate.alreadyImported);

    return c.json({
      window: { from, to },
      pages: page.pages,
      keywords: result.keywords,
      summary: {
        ...result.summary,
        proposed: candidates.length,
        new: newOnes.length,
        alreadyImported: candidates.length - newOnes.length,
      },
      candidates,
      skipped: result.skipped.slice(0, 50),
      warnings: result.warnings,
    });
  });

  /**
   * Record the candidates the user confirmed.
   *
   * The client sends back the rows it displayed, so what is written is exactly
   * what was on screen. The reference is the idempotency key, so a double click
   * or a re-scan cannot double-count a deposit.
   */
  app.post("/transfers/confirm", async (c) => {
    const body = await readJson(c.req.raw);
    const rows = body["transactions"];

    if (!Array.isArray(rows) || rows.length === 0) {
      throw badRequest("transactions must be a non-empty array", { transactions: "required" });
    }
    if (rows.length > 500) {
      throw badRequest("transactions must contain at most 500 rows", { transactions: "too many" });
    }

    let imported = 0;
    let skipped = 0;
    const recorded: unknown[] = [];

    for (const entry of rows) {
      const row = entry as Record<string, unknown>;
      const externalRef = optString(row, "externalRef");

      if (typeof externalRef !== "string" || !externalRef.startsWith("akahu:")) {
        throw badRequest(
          "every transaction needs an externalRef beginning with \"akahu:\"",
          { externalRef: "invalid" },
        );
      }

      const contributionDate = reqDate(row, "date");
      const amountNzd = reqNumber(row, "amountNzd", { min: -1_000_000, max: 1_000_000 });
      const note = optString(row, "note") ?? `Bank transfer: ${optString(row, "description") ?? "Sharesies"}`;

      const result = importContribution(db, {
        contributionDate,
        amountNzd,
        note: note.slice(0, 300),
        source: "bank",
        externalRef,
      });

      if (result.skipped) skipped += 1;
      else {
        imported += 1;
        recorded.push(result.contribution);
      }
    }

    return c.json({ imported, skipped, recorded }, 201);
  });

  return app;
}
