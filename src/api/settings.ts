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
import { hasExternalContributions, latestHoldings } from "../db/repo.ts";
import { blendAssumedReturn, type ReturnBlend } from "../domain/fund-returns.ts";
import {
  parseBasis,
  resolveBasis,
  type ContributionsBasis,
  type RequestedBasis,
} from "../domain/contributions-basis.ts";

export const SETTING_KEYS = {
  annualReturn: "assumed_annual_return",
  monthlyContribution: "assumed_monthly_contribution",
  contributionsBasis: "contributions_basis",
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

// ------------------------------------------------------- what counts as a contribution

/** Where the basis in use came from. */
export type BasisSource = "setting" | "environment" | "auto";

export interface BasisResolution {
  /** The basis actually applied. */
  basis: ContributionsBasis;
  /** What was asked for, which is "auto" unless someone chose explicitly. */
  requested: RequestedBasis;
  source: BasisSource;
  /** Whether any in-scope row is an external flow, which is what "auto" keys off. */
  hasExternalRows: boolean;
}

/**
 * Which rows count as contributions.
 *
 * Same resolution order as the return assumption (setting, then environment), but the
 * fallback is a decision rather than a constant: with no explicit choice, external
 * flows win when there are any, and buys are the proxy when there are not. Reported
 * rather than assumed, so the card can say which it is using.
 */
export function resolveContributionsBasis(db: DatabaseSync): BasisResolution {
  const stored = parseBasis(getSetting(db, SETTING_KEYS.contributionsBasis));
  const fromEnv = parseBasis(process.env["CONTRIBUTIONS_BASIS"]);
  const requested: RequestedBasis = stored ?? fromEnv ?? "auto";
  // The source describes where the basis *in force* came from, not which layer held
  // the request: a stored "auto" means the rule decided, and reporting that as
  // "setting" would read as though someone had chosen the basis by hand.
  const source: BasisSource = requested === "auto" ? "auto" : stored !== null ? "setting" : "environment";
  const hasExternalRows = hasExternalContributions(db);
  return { basis: resolveBasis(requested, { hasExternalRows }), requested, source, hasExternalRows };
}

export function setContributionsBasis(db: DatabaseSync, value: RequestedBasis): BasisResolution {
  setSetting(db, SETTING_KEYS.contributionsBasis, value);
  return resolveContributionsBasis(db);
}

/**
 * One sentence for the card, describing what the contributions line counts.
 *
 * The caveat about the platform boundary is deliberate. A transfer goes to Sharesies
 * as a whole while the goal may track one account of several, so "money sent" and
 * "money arrived here" are not always the same thing, and the figure should not be
 * labelled as though they were.
 */
export function describeContributionsBasis(basis: ContributionsBasis): string {
  if (basis === "external") {
    return "Contributions count money sent to Sharesies: deposits, withdrawals, and transfers detected in the bank feed. Buys, sells, dividends and fees inside the account are logged but not counted, because they move money that has already been counted.";
  }
  return "No external transfers have been logged, so buys into the account stand in as a proxy for money in. Log a deposit, or run the bank-transfer scan, to switch to the stricter figure.";
}

/** The same thing as a response shape, so the routes report it identically. */
export interface BasisPayload {
  basis: ContributionsBasis;
  requested: RequestedBasis;
  source: BasisSource;
  hasExternalRows: boolean;
  note: string;
}

export function basisPayload(resolution: BasisResolution): BasisPayload {
  return {
    basis: resolution.basis,
    requested: resolution.requested,
    source: resolution.source,
    hasExternalRows: resolution.hasExternalRows,
    note: describeContributionsBasis(resolution.basis),
  };
}
