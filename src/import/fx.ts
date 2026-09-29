/**
 * Currency conversion for imported transactions.
 *
 * A Sharesies transaction report is not single-currency: a real one held NZD, USD
 * and AUD rows in the same file, and the importer was adding all three into
 * `amount_nzd` unconverted — a silent ~1.76x overstatement on every USD row. This
 * module is what turns "amount in the row's currency" into "amount in NZD", with
 * the rate and the date it came from kept for the audit trail.
 *
 * Three properties worth stating, because each is a way this could be wrong:
 *
 *   1. **It fails visibly.** A rate that could not be found leaves the row
 *      un-imported and reported, rather than silently assuming 1.0.
 *   2. **It says which date the rate is from.** The ECB publishes on business days
 *      only, so a trade on a Sunday uses Friday's rate; the resolution carries both
 *      the date asked about and the date actually used.
 *   3. **It is cached in the database.** Re-importing the same report, or running
 *      offline later, reproduces the same numbers instead of re-fetching or
 *      drifting with the market.
 *
 * The default source is the ECB's reference rates through the free, keyless
 * frankfurter.dev API. It costs one request per currency pair per import: the
 * time-series endpoint returns the whole range at once.
 */
import type { DatabaseSync } from "node:sqlite";
import { getFxRate, listFxRates, publishedFxRateOnOrBefore, upsertFxRate } from "../db/repo.ts";

export const FX_SOURCE_ECB = "ecb-frankfurter";

/** One published rate. */
export interface FxPoint {
  date: string;
  rate: number;
}

export interface FxProvider {
  readonly name: string;
  /**
   * Every published rate for `base`/`quote` between two dates, in one request.
   * Returning a partial range is allowed: the caller asks for a padded window.
   */
  fetchRange(base: string, quote: string, from: string, to: string): Promise<FxPoint[]>;
}

/** A rate resolved for a specific date. */
export interface FxResolution {
  /** The date asked about. */
  asOfDate: string;
  rate: number;
  /** The date the rate is published for. Differs from `asOfDate` on weekends. */
  rateDate: string;
  /** True when a rate exists for that exact date. */
  exact: boolean;
  source: string;
}

export interface FxLookup {
  base: string;
  quote: string;
  source: string;
  resolve(date: string): FxResolution | null;
  /** Dates that have no rate, so their rows cannot be converted. */
  unavailable: string[];
  /** Requests actually made to the provider. */
  requests: number;
  /** What went wrong, if the provider could not be reached. */
  errors: string[];
}

export interface LoadFxOptions {
  base: string;
  quote?: string;
  /** The trade dates that need a rate. */
  dates: string[];
  /** Pass null to disable fetching entirely (offline, or tests). */
  provider?: FxProvider | null;
}

/** The frankfurter.dev ECB rate API: free, keyless, historical. */
export class FrankfurterProvider implements FxProvider {
  readonly name = FX_SOURCE_ECB;
  readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env["FX_API_BASE"]?.trim() ?? "https://api.frankfurter.dev/v1")
      .replace(/\/+$/, "");
  }

  async fetchRange(base: string, quote: string, from: string, to: string): Promise<FxPoint[]> {
    const url = `${this.baseUrl}/${from}..${to}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new Error(`FX provider returned HTTP ${response.status} for ${base}/${quote}`);
    }

    const body = (await response.json()) as { rates?: Record<string, Record<string, number>> };
    const rates = body.rates ?? {};
    const points: FxPoint[] = [];
    for (const [date, quoted] of Object.entries(rates)) {
      const rate = quoted[quote];
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
        points.push({ date, rate });
      }
    }
    return points.sort((left, right) => left.date.localeCompare(right.date));
  }
}

/** The provider to use, or null when conversion is switched off. */
export function resolveFxProvider(): FxProvider | null {
  const requested = process.env["FX_PROVIDER"]?.trim().toLowerCase();
  if (requested === "none" || requested === "off" || requested === "disabled") return null;
  if (process.env["FX_ENABLED"]?.trim().toLowerCase() === "false") return null;
  return new FrankfurterProvider();
}

const DAY_MS = 86_400_000;

/** `date` shifted by whole days, as 'YYYY-MM-DD'. */
function shiftDate(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return date;
  return new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
}

/** An identity lookup, for a row already in the target currency. */
function identityLookup(quote: string): FxLookup {
  return {
    base: quote,
    quote,
    source: "identity",
    resolve: (date) => ({ asOfDate: date, rate: 1, rateDate: date, exact: true, source: "identity" }),
    unavailable: [],
    requests: 0,
    errors: [],
  };
}

/**
 * Resolve a rate for each date, from the cache first and the provider second.
 *
 * The window is padded a week before the earliest date asked about: a trade on a
 * Sunday or a public holiday must find the previous published rate, and without the
 * pad the fetch would start after the only rate that applies.
 */
export async function loadFxRates(db: DatabaseSync, options: LoadFxOptions): Promise<FxLookup> {
  const base = options.base.trim().toUpperCase();
  const quote = (options.quote ?? "NZD").trim().toUpperCase();
  if (base === "" || base === quote) return identityLookup(quote);

  const dates = [...new Set(options.dates.filter(Boolean))].sort();
  const answers = new Map<string, FxResolution>();
  const errors: string[] = [];
  let requests = 0;

  if (dates.length === 0) {
    return { base, quote, source: "none", resolve: () => null, unavailable: [], requests, errors };
  }

  const source = options.provider ? options.provider.name : "none";

  const resolveFromCache = (date: string): FxResolution | null => {
    const exact = getFxRate(db, base, quote, date);
    if (exact) {
      return { asOfDate: date, rate: exact.rate, rateDate: exact.rateDate, exact: exact.rateDate === date, source: exact.source };
    }
    // Carry the newest published rate forward, and remember the answer for this
    // date so the next import is an exact cache hit.
    const carried = publishedFxRateOnOrBefore(db, base, quote, date);
    if (!carried) return null;
    upsertFxRate(db, {
      base, quote, asOfDate: date, rate: carried.rate, rateDate: carried.rateDate, source: carried.source,
    });
    return { asOfDate: date, rate: carried.rate, rateDate: carried.rateDate, exact: false, source: carried.source };
  };

  for (const date of dates) {
    const resolution = resolveFromCache(date);
    if (resolution) answers.set(date, resolution);
  }

  const missing = dates.filter((date) => !answers.has(date));
  let fetched = false;

  if (missing.length > 0 && options.provider) {
    const from = shiftDate(missing[0]!, -7);
    const to = missing.at(-1)!;
    try {
      requests += 1;
      fetched = true;
      const points = await options.provider.fetchRange(base, quote, from, to);
      for (const point of points) {
        // A published point is its own answer, which is what makes carry-forward
        // possible without another request.
        upsertFxRate(db, {
          base, quote, asOfDate: point.date, rate: point.rate, rateDate: point.date, source: options.provider.name,
        });
      }
      if (points.length === 0) {
        errors.push(`No ${base}/${quote} rates were returned for ${from} to ${to}.`);
      }
    } catch (error) {
      fetched = false;
      errors.push(
        `Could not reach the ${options.provider.name} rate service: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (fetched) {
    for (const date of missing) {
      const resolution = resolveFromCache(date);
      if (resolution) answers.set(date, resolution);
    }
  }

  // A cached series that does not reach back far enough is worth one more attempt
  // over a wider window, which is the common case for the first import of an old
  // report after an unrelated one has already cached a recent window.
  const stillMissing = dates.filter((date) => !answers.has(date));
  if (stillMissing.length > 0 && options.provider && !fetched) {
    try {
      requests += 1;
      const from = shiftDate(stillMissing[0]!, -7);
      const to = stillMissing.at(-1)!;
      const points = await options.provider.fetchRange(base, quote, from, to);
      for (const point of points) {
        upsertFxRate(db, {
          base, quote, asOfDate: point.date, rate: point.rate, rateDate: point.date, source: options.provider.name,
        });
      }
      for (const date of stillMissing) {
        const resolution = resolveFromCache(date);
        if (resolution) answers.set(date, resolution);
      }
    } catch (error) {
      errors.push(
        `Could not reach the ${options.provider.name} rate service: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const unavailable = dates.filter((date) => !answers.has(date));

  return {
    base,
    quote,
    source,
    resolve: (date) => answers.get(date) ?? null,
    unavailable,
    requests,
    errors,
  };
}

/** How many rates are cached for a pair, for the settings/import report. */
export function cachedRateCount(db: DatabaseSync, base: string, quote = "NZD"): number {
  return listFxRates(db, { base, quote }).length;
}
