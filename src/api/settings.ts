/**
 * Assumptions and stored settings (plan section 9, item 8).
 * Resolution order: settings table -> environment -> **derived from the holdings** ->
 * built-in default.
 *
 * The derived step is the one that came from doing the arithmetic on the funds this
 * portfolio actually holds: a single blanket rate for a portfolio that is 95% equities
 * ignores the only thing that decides the answer, which is the allocation. When there
 * are holdings to weight, the default becomes the allocation-weighted long-run
 * assumption in `src/domain/fund-returns.ts`, and where the figure came from is
 * reported rather than assumed, so the UI can say which of the four it is.
 */
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../db/client.ts";
import { latestHoldings } from "../db/repo.ts";
import { blendAssumedReturn, type ReturnBlend } from "../domain/fund-returns.ts";

export const SETTING_KEYS = {
  annualReturn: "assumed_annual_return",
  monthlyContribution: "assumed_monthly_contribution",
} as const;

export const DEFAULT_ANNUAL_RETURN = 0.07;
export const DEFAULT_MONTHLY_CONTRIBUTION = 500;

/** Where the return in use came from. */
export type AnnualReturnSource = "setting" | "environment" | "derived" | "default";

export interface AnnualReturnResolution {
  rate: number;
  source: AnnualReturnSource;
  /** The allocation-weighted figure, whether or not it is the one being used. */
  derived: number | null;
  /** The same allocation's observed returns, for the UI to show beside it. */
  observed: number | null;
  /** Share of the portfolio's value the derived figure describes. */
  covered: number;
}

/** Sane guardrails so a typo cannot produce an absurd projection. */
export const ANNUAL_RETURN_RANGE = { min: -0.5, max: 0.5 } as const;
export const MONTHLY_CONTRIBUTION_RANGE = { min: 0, max: 1_000_000 } as const;

export interface Assumptions {
  annualReturn: number;
  monthlyContribution: number;
}

function readNumber(db: DatabaseSync, key: string, envName: string, fallback: number): number {
  const stored = getSetting(db, key);
  if (stored !== undefined) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** The portfolio's holdings, shaped for the blend. */
export function holdingsForBlend(db: DatabaseSync): ReturnBlend {
  return blendAssumedReturn(latestHoldings(db).map((holding) => ({ symbol: holding.symbol, value: holding.value })));
}

/**
 * The return to use, and where it came from. An explicit setting or environment value
 * always wins: a derived figure that silently overrode a number the user typed would be
 * the opposite of the transparency this is for.
 */
export function resolveAnnualReturn(db: DatabaseSync): AnnualReturnResolution {
  const blend = holdingsForBlend(db);
  const derived = blend.rate === null ? null : Math.round(blend.rate * 1e4) / 1e4;
  const context = { derived, observed: blend.observedRate, covered: blend.covered };

  const stored = getSetting(db, SETTING_KEYS.annualReturn);
  if (stored !== undefined) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) return { rate: parsed, source: "setting", ...context };
  }

  const fromEnv = process.env["ASSUMED_ANNUAL_RETURN"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) return { rate: parsed, source: "environment", ...context };
  }

  if (derived !== null) return { rate: derived, source: "derived", ...context };
  return { rate: DEFAULT_ANNUAL_RETURN, source: "default", ...context };
}

export function getAssumptions(db: DatabaseSync): Assumptions {
  return {
    annualReturn: resolveAnnualReturn(db).rate,
    monthlyContribution: readNumber(
      db,
      SETTING_KEYS.monthlyContribution,
      "ASSUMED_MONTHLY_CONTRIBUTION",
      DEFAULT_MONTHLY_CONTRIBUTION,
    ),
  };
}

export function setAssumptions(db: DatabaseSync, patch: Partial<Assumptions>): Assumptions {
  if (patch.annualReturn !== undefined) {
    setSetting(db, SETTING_KEYS.annualReturn, String(patch.annualReturn));
  }
  if (patch.monthlyContribution !== undefined) {
    setSetting(db, SETTING_KEYS.monthlyContribution, String(patch.monthlyContribution));
  }
  return getAssumptions(db);
}
