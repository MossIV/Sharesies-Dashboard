import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { getActiveGoal, getGoal, listMilestones, totalSeries } from "../../db/repo.ts";
import { todayNz } from "../../db/client.ts";
import { projectScenarios, requiredMonthlyContribution, monthsToTarget } from "../../domain/projection.ts";
import { ASSET_CLASS_RETURNS, OBSERVATIONS_AS_OF } from "../../domain/fund-returns.ts";
import {
  ANNUAL_RETURN_RANGE,
  MONTHLY_CONTRIBUTION_RANGE,
  getAssumptions,
  holdingsForBlend,
  resolveAnnualReturn,
} from "../settings.ts";
import { notFound, queryNumber, reqId } from "../validate.ts";

/** Default horizon for the scenario chart. */
const DEFAULT_MONTHS = 120;
const MAX_MONTHS = 600;

const DISCLAIMER =
  "Illustrative assumptions only. These are not predictions or financial advice: " +
  "real returns vary, and past performance does not indicate future results.";

export function projectionRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/projection", (c) => {
    const url = new URL(c.req.url);
    const assumptions = getAssumptions(db);
    // The derivation behind the default, and the per-fund evidence for it.
    const resolution = resolveAnnualReturn(db);
    const blend = holdingsForBlend(db);
    const today = todayNz();
    const series = totalSeries(db);
    const startValue = series.at(-1)?.value ?? 0;

    const annualReturn = queryNumber(url, "return", assumptions.annualReturn);
    const monthlyContribution = queryNumber(url, "monthly", assumptions.monthlyContribution);
    const spread = queryNumber(url, "spread", 0.02);
    const months = Math.min(MAX_MONTHS, Math.max(1, Math.floor(queryNumber(url, "months", DEFAULT_MONTHS))));

    const goalIdParam = url.searchParams.get("goalId");
    const goal = goalIdParam ? getGoal(db, reqId(goalIdParam, "goalId")) : getActiveGoal(db);
    if (goalIdParam && !goal) throw notFound(`No goal with id ${goalIdParam}`);

    const scenarios = projectScenarios({
      startValue,
      startDate: today,
      annualReturn,
      monthlyContribution,
      months,
      spread,
    });

    const milestones = goal
      ? listMilestones(db, goal.id).map((milestone) => ({
        id: milestone.id,
        label: milestone.label,
        amountNzd: milestone.amountNzd,
        kind: milestone.kind,
        alreadyReached: milestone.firstReachedOn !== null,
        firstReachedOn: milestone.firstReachedOn,
        // One projected date per scenario (plan section 11, Phase 3).
        etas: Object.fromEntries(
          scenarios.map((scenario) => [scenario.key, monthsToTarget(scenario.points, milestone.amountNzd)]),
        ) as Record<"low" | "base" | "high", number | null>,
        etaDates: Object.fromEntries(
          scenarios.map((scenario) => {
            const point = scenario.points.find((entry) => entry.value >= milestone.amountNzd);
            return [scenario.key, point?.date ?? null];
          }),
        ) as Record<"low" | "base" | "high", string | null>,
      }))
      : [];

    const goalSummary = goal
      ? {
        id: goal.id,
        name: goal.name,
        targetAmountNzd: goal.targetAmountNzd,
        targetDate: goal.targetDate,
        requiredMonthly: goal.targetDate
          ? requiredMonthlyContribution({
            startValue,
            fromDate: today,
            targetAmount: goal.targetAmountNzd,
            targetDate: goal.targetDate,
            annualReturn,
          }).monthly
          : null,
        targetEta: Object.fromEntries(
          scenarios.map((scenario) => {
            const point = scenario.points.find((entry) => entry.value >= goal.targetAmountNzd);
            return [scenario.key, point?.date ?? null];
          }),
        ) as Record<"low" | "base" | "high", string | null>,
      }
      : null;

    return c.json({
      disclaimer: DISCLAIMER,
      assumptions: {
        startValue: Math.round(startValue * 100) / 100,
        startDate: today,
        annualReturn,
        monthlyContribution,
        spread,
        months,
      },
      /**
       * Where the return came from, and what the portfolio's own funds have actually
       * returned. The projection is arithmetic on an assumption; this is the working,
       * so the UI can show the assumption next to the evidence instead of asking for
       * trust in a number that appeared from nowhere.
       */
      returns: {
        source: url.searchParams.has("return") ? "query" : resolution.source,
        annualReturn,
        derivedAnnualReturn: resolution.derived,
        observedAnnualReturn: blend.observedRate,
        volatility: blend.volatility,
        covered: blend.covered,
        unmatched: blend.unmatched,
        asOf: OBSERVATIONS_AS_OF,
        holdings: blend.holdings,
        assetClasses: ASSET_CLASS_RETURNS,
      },
      scenarios: scenarios.map((scenario) => ({
        key: scenario.key,
        annualReturn: scenario.annualReturn,
        endValue: scenario.endValue,
        points: scenario.points,
      })),
      milestones,
      goal: goalSummary,
    });
  });

  return app;
}

export const PROJECTION_LIMITS = {
  annualReturn: ANNUAL_RETURN_RANGE,
  monthlyContribution: MONTHLY_CONTRIBUTION_RANGE,
  maxMonths: MAX_MONTHS,
};
