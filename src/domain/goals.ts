/**
 * Goal progress and the pace indicator (plan section 7).
 *
 * Pace compares the current value against a straight line drawn from the first
 * snapshot to the goal on its target date. It is deliberately simple and
 * explainable: no compounding, no market assumptions.
 */
import { daysBetween } from "./dates.ts";
import type { ValuePoint } from "./milestones.ts";
import { requiredMonthlyContribution } from "./projection.ts";

export type ProgressBasis = "value" | "contributions";
export type PaceStatus = "ahead" | "on_track" | "behind" | "unknown";

export interface Goal {
  id: number;
  name: string;
  targetAmountNzd: number;
  targetDate: string | null;
  progressBasis: ProgressBasis;
  isActive: boolean;
  createdAt: string;
  /** "demo" marks the goal the seeder creates, so `seed:demo:reset` can remove it. */
  source: "manual" | "demo";
}

/** Percentage-point band around the straight-line path treated as "on track". */
export const PACE_TOLERANCE_PCT = 2;

export interface GoalProgressInput {
  goal: Goal;
  /** Portfolio value today. */
  currentValue: number;
  series: ValuePoint[];
  /** Net deposits, used when progressBasis is 'contributions'. */
  netContributions?: number;
  /** 'YYYY-MM-DD' today. */
  today: string;
  /** Assumed annual return, for the required-contribution figure. */
  annualReturn: number;
}

export interface Pace {
  status: PaceStatus;
  /** Value the straight line expects today. */
  expectedValue: number | null;
  /** currentValue - expectedValue. */
  delta: number | null;
  deltaPct: number | null;
  /** 'YYYY-MM-DD' the straight line starts from (first snapshot). */
  baselineDate: string | null;
  baselineValue: number | null;
}

export interface GoalProgress {
  goal: Goal;
  currentValue: number;
  /** The figure the progress bar is based on (value or contributions). */
  progressValue: number;
  progressBasis: ProgressBasis;
  progressPct: number;
  remaining: number;
  pace: Pace;
  requiredMonthly: number | null;
  targetPassed: boolean;
}

export function computePace(
  goal: Goal,
  series: ValuePoint[],
  currentValue: number,
  today: string,
): Pace {
  const baseline = series[0];
  const empty: Pace = {
    status: "unknown",
    expectedValue: null,
    delta: null,
    deltaPct: null,
    baselineDate: baseline?.date ?? null,
    baselineValue: baseline?.value ?? null,
  };

  if (!goal.targetDate || !baseline) return empty;

  const totalDays = daysBetween(baseline.date, goal.targetDate);
  if (totalDays <= 0) return empty;

  const elapsedDays = daysBetween(baseline.date, today);
  const fraction = Math.min(1, Math.max(0, elapsedDays / totalDays));
  const expected = baseline.value + (goal.targetAmountNzd - baseline.value) * fraction;

  // A baseline of zero makes a percentage comparison meaningless.
  if (expected === 0) return { ...empty, status: "unknown", expectedValue: 0 };

  const delta = currentValue - expected;
  const deltaPct = (delta / expected) * 100;

  return {
    status: Math.abs(deltaPct) < PACE_TOLERANCE_PCT ? "on_track" : deltaPct > 0 ? "ahead" : "behind",
    expectedValue: Math.round(expected * 100) / 100,
    delta: Math.round(delta * 100) / 100,
    deltaPct: Math.round(deltaPct * 10) / 10,
    baselineDate: baseline.date,
    baselineValue: baseline.value,
  };
}

export function computeGoalProgress(input: GoalProgressInput): GoalProgress {
  const { goal, currentValue, series, today } = input;
  const progressValue = goal.progressBasis === "contributions"
    ? (input.netContributions ?? 0)
    : currentValue;

  const progressPct = goal.targetAmountNzd > 0
    ? Math.round((progressValue / goal.targetAmountNzd) * 1000) / 10
    : 0;

  const required = goal.targetDate
    ? requiredMonthlyContribution({
      startValue: progressValue,
      fromDate: today,
      targetAmount: goal.targetAmountNzd,
      targetDate: goal.targetDate,
      annualReturn: input.annualReturn,
    })
    : null;

  return {
    goal,
    currentValue,
    progressValue,
    progressBasis: goal.progressBasis,
    progressPct,
    remaining: Math.max(0, Math.round((goal.targetAmountNzd - progressValue) * 100) / 100),
    pace: computePace(goal, series, progressValue, today),
    requiredMonthly: required?.monthly ?? null,
    targetPassed: required?.targetPassed ?? false,
  };
}
