/**
 * What counts as a contribution.
 *
 * Two bases, answering different questions about the same log.
 *
 * **external** — money crossing the boundary of your own finances: a top up from the
 * bank, a withdrawal back to it, or a transfer detected in the bank feed either way.
 * A buy funded by that top up is the same money changing shelf inside the platform,
 * not a second contribution, and a sell is not money out, because the cash stays
 * inside Sharesies until it is actually withdrawn.
 *
 * **trades** — buys into the account as a proxy for money in, which is what the
 * importer assumed when there was no bank feed to read. It is correct while the
 * report is complete and the money is invested promptly, and it is wrong the moment
 * the same money is also logged as a transfer. That is exactly what happened: one
 * portfolio's cumulative buys read $8,013.91 against a value of $5,211.51, because
 * $5,300 of detected bank transfers and the $2,713.91 of buys they funded were both
 * being counted.
 *
 * The rule reads the source and category the log already carries, so no new data is
 * needed to apply it: `manual` rows are hand-entered external flows, `bank` rows are
 * detected transfers, and a `csv` row is external only when its category says so.
 * A source this does not recognise is *not* treated as external — an unknown row is
 * better left out of a total than assumed into it.
 */
export type ContributionsBasis = "external" | "trades";

/** What the caller asked for: one of the two, or "auto" to pick by what is there. */
export type RequestedBasis = ContributionsBasis | "auto";

/**
 * Categories that describe money crossing the platform boundary.
 *
 * Deliberately narrow. `transfer` is *not* here: the classifier buckets
 * "wallet to investment" and its synonyms under it, which is a movement inside
 * Sharesies, not money arriving from outside. Nor are buy, sell, dividend, fee or
 * interest: a dividend is income earned inside the platform and a fee is a cost
 * inside it, so both belong on the growth side rather than in what you put in.
 *
 * Bank-detected transfers do not need to be listed — they are external by source.
 */
export const EXTERNAL_CATEGORIES: readonly string[] = ["deposit", "withdrawal"];

export interface BasisRow {
  source: string;
  /** Null on older rows, which the importers written since always populate. */
  category: string | null;
}

/** True when the row is money crossing the platform boundary. */
export function isExternalFlow(row: BasisRow): boolean {
  if (row.source === "manual" || row.source === "bank") return true;
  if (row.source === "csv") {
    return row.category !== null && EXTERNAL_CATEGORIES.includes(row.category);
  }
  return false;
}

export interface BasisContext {
  /** Whether any row in scope is an external flow, which is what "auto" keys off. */
  hasExternalRows: boolean;
}

/**
 * The basis to use.
 *
 * "auto" prefers external flows and falls back to trades when there are none, because
 * a portfolio whose history predates the bank feed has only trades to count, and
 * showing zero contributions would be less honest than showing the proxy and saying
 * that is what it is.
 */
export function resolveBasis(requested: RequestedBasis, context: BasisContext): ContributionsBasis {
  if (requested === "external" || requested === "trades") return requested;
  return context.hasExternalRows ? "external" : "trades";
}

export function parseBasis(value: string | undefined | null): RequestedBasis | null {
  const text = value?.trim().toLowerCase();
  if (text === "external" || text === "trades" || text === "auto") return text;
  return null;
}
