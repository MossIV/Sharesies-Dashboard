/**
 * The "contributions vs growth" series (plan section 9, view 5).
 *
 * The identity being plotted is `portfolio value = net contributions + growth`,
 * and it only means anything if both sides describe the same accounts: the value
 * is the sum of the accounts *inside the goal*, so the contributions must be too.
 * Summing every portfolio in a transaction report against one portfolio's value is
 * what produced 8,657.60 of "deposits" against a value of 214.33 and a growth line
 * of minus 8,443 — a number with no meaning, drawn as a stacked area, which is why
 * the chart looked broken rather than merely wrong.
 *
 * Two properties this module guarantees, both of which the React component got
 * wrong by computing them itself:
 *
 *   1. Growth can legitimately be negative — a market fall, or a withdrawal —
 *      so the caller is told (`belowContributions`) instead of being handed a
 *      negative slice to stack. A stacked area cannot draw one.
 *   2. Contributions are accumulated once, in date order, rather than re-summing
 *      the whole log per point.
 *
 * Pure: no database, no clock.
 */
import type { ValuePoint } from "./milestones.ts";

export interface ContributionPoint {
  contributionDate: string;
  amountNzd: number;
}

export interface ContributionChartRow {
  date: string;
  /** The portfolio value on that date, across the accounts in the goal. */
  value: number;
  /** Net contributions on or before that date. */
  contributions: number;
  /** value − contributions. Negative is possible and is not a bug. */
  growth: number;
}

export interface ContributionSeries {
  rows: ContributionChartRow[];
  /** True when contributions exceed the value at any point on the chart. */
  belowContributions: boolean;
  /** The largest such excess, so the UI can say how far below. */
  maxShortfall: number;
  /**
   * When the largest excess happened.
   *
   * It is not necessarily the latest point, which is the trap this was reported for: the
   * callout names the newest contributions and value and printed the widest gap beside
   * them, so 8,013.91 against 5,211.51 was described as being "above by 7,800.37". The
   * date is what lets the UI say which gap it means.
   */
  maxShortfallDate: string | null;
  /** The newest row, or null with no history. */
  latest: ContributionChartRow | null;
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function contributionSeries(input: {
  points: ValuePoint[];
  contributions: ContributionPoint[];
}): ContributionSeries {
  const ordered = [...input.contributions].sort((left, right) =>
    left.contributionDate.localeCompare(right.contributionDate)
  );

  const rows: ContributionChartRow[] = [];
  let running = 0;
  let index = 0;

  for (const point of input.points) {
    // Contributions dated after this snapshot do not exist yet; one dated in the
    // future (a scheduled deposit, a mistyped date) must not be back-dated into
    // every earlier point either.
    while (index < ordered.length && ordered[index]!.contributionDate <= point.date) {
      running += ordered[index]!.amountNzd;
      index += 1;
    }
    rows.push({
      date: point.date,
      value: round(point.value),
      contributions: round(running),
      growth: round(point.value - running),
    });
  }

  const shortfalls = rows
    .filter((row) => row.growth < 0)
    .map((row) => ({ amount: -row.growth, date: row.date }));
  const worst = shortfalls.reduce<{ amount: number; date: string | null }>(
    (max, entry) => (entry.amount > max.amount ? entry : max),
    { amount: 0, date: null },
  );

  return {
    rows,
    belowContributions: shortfalls.length > 0,
    maxShortfall: round(worst.amount),
    maxShortfallDate: worst.date,
    latest: rows.at(-1) ?? null,
  };
}
