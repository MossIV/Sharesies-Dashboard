/**
 * Milestone logic (plan section 7).
 *
 * Reached semantics: the *first* snapshot date at or above the amount is kept
 * forever, even if the value later dips. A dip shows as `currentlyBelow`, it
 * does not un-achieve the milestone.
 */

export type MilestoneKind = "custom" | "percent";
export type MilestoneState = "reached" | "next" | "future";

export interface Milestone {
  id: number;
  goalId: number;
  label: string;
  amountNzd: number;
  kind: MilestoneKind;
  percent: number | null;
  firstReachedOn: string | null;
  notes: string | null;
}

export interface MilestoneInput {
  label: string;
  amountNzd: number;
  kind?: MilestoneKind;
  percent?: number | null;
  firstReachedOn?: string | null;
  notes?: string | null;
}

export interface ValuePoint {
  date: string;
  value: number;
}

export interface EvaluatedMilestone extends Milestone {
  state: MilestoneState;
  /** Effective first-reached date: derived from the series, else persisted. */
  firstReachedOn: string | null;
  currentlyBelow: boolean;
  /** amount - currentValue. Negative once passed. */
  gap: number;
  /** currentValue / amount, capped at 100 for presentation. */
  progressPct: number;
}

/** Earliest date in `series` whose value is at or above `amount`. */
export function firstReachedOn(series: ValuePoint[], amount: number): string | null {
  let best: string | null = null;
  for (const point of series) {
    if (point.value >= amount && (best === null || point.date < best)) best = point.date;
  }
  return best;
}

/**
 * Auto-generated percentage milestones (25 / 50 / 75 / 100% by default).
 * `percent` is stored alongside the amount so the set can be regenerated when
 * the goal target changes.
 */
export const DEFAULT_MILESTONE_PERCENTS = [25, 50, 75, 100];

export function percentMilestones(
  targetAmount: number,
  percents: number[] = DEFAULT_MILESTONE_PERCENTS,
): MilestoneInput[] {
  return percents.map((percent) => ({
    label: `${percent}% of goal`,
    amountNzd: Math.round(((targetAmount * percent) / 100) * 100) / 100,
    kind: "percent" as const,
    percent,
  }));
}

export function evaluateMilestones(
  milestones: Milestone[],
  series: ValuePoint[],
  currentValue: number,
): EvaluatedMilestone[] {
  const ordered = [...milestones].sort((a, b) => a.amountNzd - b.amountNzd);

  const evaluated = ordered.map((milestone) => {
    const derived = firstReachedOn(series, milestone.amountNzd);
    const reachedOn = derived ?? milestone.firstReachedOn;
    return {
      ...milestone,
      state: "future" as MilestoneState,
      firstReachedOn: reachedOn,
      currentlyBelow: reachedOn !== null && currentValue < milestone.amountNzd,
      gap: Math.round((milestone.amountNzd - currentValue) * 100) / 100,
      progressPct: Math.min(100, Math.round((currentValue / milestone.amountNzd) * 1000) / 10),
    };
  });

  // Exactly one unreached milestone is "next": the lowest unreached amount.
  let nextFound = false;
  for (const milestone of evaluated) {
    if (milestone.firstReachedOn !== null) {
      milestone.state = "reached";
    } else if (!nextFound) {
      milestone.state = "next";
      nextFound = true;
    }
  }

  return evaluated;
}

/** Lowest unreached milestone, which is the one to render in the progress bar. */
export function nextMilestone(evaluated: EvaluatedMilestone[]): EvaluatedMilestone | null {
  return evaluated.find((milestone) => milestone.state === "next") ?? null;
}
