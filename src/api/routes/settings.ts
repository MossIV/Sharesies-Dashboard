import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting, todayNz } from "../../db/client.ts";
import { AkahuSource } from "../../sources/AkahuSource.ts";
import { DEFAULT_PORTFOLIO_TYPES } from "../../collector/select-accounts.ts";
import { collectOnce } from "../../collector/collect.ts";
import {
  badRequest,
  optBoolean,
  readJson,
  reqNumber,
} from "../validate.ts";
import {
  ANNUAL_RETURN_RANGE,
  MONTHLY_CONTRIBUTION_RANGE,
  basisPayload,
  getAssumptions,
  resolveContributionsBasis,
  setAssumptions,
  setContributionsBasis,
} from "../settings.ts";
import { parseBasis, type RequestedBasis } from "../../domain/contributions-basis.ts";

export const MANUAL_VALUE_SETTING = "manual_value_nzd";

export function settingsRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  /** Assumptions plus the current data-source configuration. */
  app.get("/settings", (c) => {
    const assumptions = getAssumptions(db);
    const basis = resolveContributionsBasis(db);
    const hasTokens = AkahuSource.isConfigured();
    const requested = process.env["PORTFOLIO_SOURCE"]?.trim().toLowerCase() || null;

    return c.json({
      assumptions,
      contributions: basisPayload(basis),
      source: {
        requested,
        effective: requested === "manual" || (!hasTokens && requested !== "akahu") ? "manual" : "akahu",
        akahuConfigured: hasTokens,
        connectionMatch: process.env["AKAHU_CONNECTION_MATCH"] ?? "sharesies",
        accountTypes: (process.env["AKAHU_ACCOUNT_TYPES"]?.split(",") ?? DEFAULT_PORTFOLIO_TYPES)
          .map((entry) => entry.trim().toUpperCase())
          .filter(Boolean),
      },
      manualValueNzd: getSetting(db, MANUAL_VALUE_SETTING) ?? null,
      limits: {
        annualReturn: ANNUAL_RETURN_RANGE,
        monthlyContribution: MONTHLY_CONTRIBUTION_RANGE,
      },
    });
  });

  /** Update the assumed return, the monthly contribution, and/or what counts as a contribution. */
  app.put("/settings", async (c) => {
    const body = await readJson(c.req.raw);
    const patch: { annualReturn?: number; monthlyContribution?: number } = {};

    if ("annualReturn" in body) {
      patch.annualReturn = reqNumber(body, "annualReturn", ANNUAL_RETURN_RANGE);
    }
    if ("monthlyContribution" in body) {
      patch.monthlyContribution = reqNumber(body, "monthlyContribution", MONTHLY_CONTRIBUTION_RANGE);
    }

    // An explicit "auto" is a real choice too: it returns the decision to the rule
    // rather than pinning whichever basis that rule happened to resolve to today.
    let requestedBasis: RequestedBasis | null = null;
    if ("contributionsBasis" in body) {
      requestedBasis = parseBasis(String(body["contributionsBasis"] ?? ""));
      if (requestedBasis === null) {
        throw badRequest('contributionsBasis must be "external", "trades" or "auto"');
      }
    }

    if (Object.keys(patch).length === 0 && requestedBasis === null) {
      throw badRequest("Provide annualReturn, monthlyContribution and/or contributionsBasis");
    }

    const assumptions = Object.keys(patch).length > 0 ? setAssumptions(db, patch) : getAssumptions(db);
    const basis = requestedBasis === null ? resolveContributionsBasis(db) : setContributionsBasis(db, requestedBasis);

    return c.json({ assumptions, contributions: basisPayload(basis) });
  });

  /**
   * Record a hand-typed portfolio value, for use with the manual source.
   * Optionally collect immediately so a snapshot exists straight away.
   */
  app.post("/manual-value", async (c) => {
    const body = await readJson(c.req.raw);
    const value = reqNumber(body, "value", { min: -1_000_000_000, max: 1_000_000_000 });
    setSetting(db, MANUAL_VALUE_SETTING, String(value));

    const runSync = optBoolean(body, "collect") ?? true;
    const result = runSync ? await collectOnce(db) : null;

    return c.json({
      manualValueNzd: value,
      snapshotDate: result?.snapshotDate ?? todayNz(),
      collection: result,
    }, runSync ? 201 : 200);
  });

  return app;
}
