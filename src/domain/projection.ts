/**
 * Projection engine (plan section 7).
 *
 *   V[n+1] = V[n] * (1 + r/12) + c
 *
 * Illustrative assumptions only. Nothing here is financial advice, and every
 * consumer of these numbers is expected to label them as assumptions.
 *
 * Money is rounded to cents at the boundary so charts and JSON stay readable,
 * but the simulation itself carries full precision.
 */
import { addMonths, monthsBetween } from "./dates.ts";

export const DEFAULT_SCENARIO_SPREAD = 0.02;

export interface ProjectionInput {
  /** Portfolio value today. */
  startValue: number;
  /** 'YYYY-MM-DD' the projection starts from. */
  startDate: string;
  /** Assumed annual return as a decimal, e.g. 0.07. */
  annualReturn: number;
  /** Assumed contribution per month, added at the end of each month. */
  monthlyContribution: number;
  /** How many months to simulate. */
  months: number;
}

export interface ProjectionPoint {
  month: number;
  date: string;
  value: number;
  /** Cumulative contributions, so growth can be separated from deposits. */
  contributed: number;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function projectMonths(input: ProjectionInput): ProjectionPoint[] {
  const months = Math.max(0, Math.floor(input.months));
  const monthlyRate = input.annualReturn / 12;
  const points: ProjectionPoint[] = [
    {
      month: 0,
      date: input.startDate,
      value: round2(input.startValue),
      contributed: 0,
    },
  ];

  let value = input.startValue;
  for (let month = 1; month <= months; month++) {
    value = value * (1 + monthlyRate) + input.monthlyContribution;
    points.push({
      month,
      date: addMonths(input.startDate, month),
      value: round2(value),
      contributed: round2(input.monthlyContribution * month),
    });
  }
  return points;
}

/** First date the projected value reaches `target`, or null within the horizon. */
export function etaForTarget(points: ProjectionPoint[], target: number): string | null {
  for (const point of points) {
    if (point.value >= target) return point.date;
  }
  return null;
}

/** Months until the projected value reaches `target`, or null within the horizon. */
export function monthsToTarget(points: ProjectionPoint[], target: number): number | null {
  for (const point of points) {
    if (point.value >= target) return point.month;
  }
  return null;
}

export interface ScenarioInput extends ProjectionInput {
  /** Percentage points added/subtracted for the low and high cases. Default 2pp. */
  spread?: number;
}

export interface Scenario {
  key: "low" | "base" | "high";
  annualReturn: number;
  points: ProjectionPoint[];
  /** Value at the end of the horizon. */
  endValue: number;
}

export function projectScenarios(input: ScenarioInput): Scenario[] {
  const spread = input.spread ?? DEFAULT_SCENARIO_SPREAD;
  // Round the derived rates: 0.07 + 0.02 must not surface as 0.09000000000000001.
  const rate = (value: number): number => Math.round(value * 1e6) / 1e6;
  const build = (key: Scenario["key"], annualReturn: number): Scenario => {
    const points = projectMonths({ ...input, annualReturn });
    return {
      key,
      annualReturn,
      points,
      endValue: points.at(-1)?.value ?? round2(input.startValue),
    };
  };
  return [
    build("low", rate(input.annualReturn - spread)),
    build("base", rate(input.annualReturn)),
    build("high", rate(input.annualReturn + spread)),
  ];
}

export interface RequiredContributionInput {
  startValue: number;
  /** 'YYYY-MM-DD' today. */
  fromDate: string;
  targetAmount: number;
  targetDate: string;
  annualReturn: number;
}

export interface RequiredContributionResult {
  /** Contribution needed each month, or 0 when already on track. */
  monthly: number;
  /** Whole months available. */
  months: number;
  /** True when the target date is today or in the past. */
  targetPassed: boolean;
  /** True when the lump sum alone already reaches the target by the date. */
  alreadyOnTrack: boolean;
}

/**
 * Solve for `c`, the monthly contribution required to hit `targetAmount` by
 * `targetDate`, with contributions at the end of each month:
 *
 *   target = V(1+i)^n + c((1+i)^n - 1)/i        i = r/12
 */
export function requiredMonthlyContribution(
  input: RequiredContributionInput,
): RequiredContributionResult {
  const months = monthsBetween(input.fromDate, input.targetDate);
  if (months <= 0) {
    return {
      monthly: 0,
      months: Math.max(0, months),
      targetPassed: true,
      alreadyOnTrack: input.startValue >= input.targetAmount,
    };
  }

  const i = input.annualReturn / 12;
  const growth = Math.pow(1 + i, months);
  const fromLumpSum = input.startValue * growth;
  const remaining = input.targetAmount - fromLumpSum;

  if (remaining <= 0) {
    return { monthly: 0, months, targetPassed: false, alreadyOnTrack: true };
  }

  const annuityFactor = i === 0 ? months : (growth - 1) / i;
  return {
    monthly: round2(remaining / annuityFactor),
    months,
    targetPassed: false,
    alreadyOnTrack: false,
  };
}
