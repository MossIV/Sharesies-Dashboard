/**
 * Re-derive the fund returns the projection's default is built on.
 *
 *   npm run fund:returns
 *
 * The observations in `src/domain/fund-returns.ts` are committed, because the
 * projection must work offline and must not change under the user's feet between two
 * page loads. This script is how those numbers are obtained, and how they are checked
 * later: it fetches each fund's adjusted closes, computes the same annualised figures,
 * and reports any that have drifted from the committed table by more than half a
 * percentage point.
 *
 * Adjusted closes are used because they include distributions, so these are total
 * returns. Basis: after fund fees (charged inside the fund, so they are in the unit
 * price), before tax.
 *
 * It needs no configuration and reads no database: market data in, a table out.
 */
import { FUND_OBSERVATIONS, OBSERVATIONS_AS_OF, type FundObservation } from "../src/domain/fund-returns.ts";

const DAY_MS = 86_400_000;
/** Trading days in two years: what the volatility figure covers. */
const VOLATILITY_WINDOW = 504;
/** Drift worth reporting, in annualised return terms. */
const DRIFT_TOLERANCE = 0.005;

interface Observation {
  sessionDate: string;
  close: number;
}

interface Computed {
  symbol: string;
  asOf: string;
  since: string;
  years: number;
  sinceInception: number;
  y5: number | null;
  y3: number | null;
  y1: number | null;
  volatility: number;
  points: number;
}

async function fetchSeries(ticker: string): Promise<{ observations: Observation[]; timeZone: string }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=20y&interval=1d&events=div%7Csplit`;
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`${ticker}: HTTP ${response.status}`);

  const body = (await response.json()) as {
    chart?: { result?: { meta?: { exchangeTimezoneName?: string }; timestamp?: number[]; indicators?: { adjclose?: { adjclose?: (number | null)[] }[] } }[] };
  };
  const result = body.chart?.result?.[0];
  if (!result) throw new Error(`${ticker}: no data`);

  const timeZone = result.meta?.exchangeTimezoneName ?? "Pacific/Auckland";
  const timestamps = result.timestamp ?? [];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose ?? [];

  // Bars are stamped at the market open in the exchange's zone, so the calendar date of
  // a session has to be read in that zone: a naive UTC slice names the previous day.
  const format = new Intl.DateTimeFormat("en-CA", { timeZone });
  const observations: Observation[] = [];
  for (let index = 0; index < timestamps.length; index++) {
    const close = adjusted[index];
    if (typeof close !== "number" || !(close > 0)) continue;
    observations.push({ sessionDate: format.format(new Date(timestamps[index]! * 1000)), close });
  }
  return { observations, timeZone };
}

/** Annualised (CAGR) return from the first observation at or after `fromMs`. */
function annualised(observations: Observation[], fromMs: number): { rate: number; years: number; since: string } | null {
  const end = observations.at(-1);
  if (!end) return null;
  const start = observations.find((entry) => Date.parse(`${entry.sessionDate}T00:00:00Z`) >= fromMs);
  if (!start) return null;
  const endMs = Date.parse(`${end.sessionDate}T00:00:00Z`);
  const startMs = Date.parse(`${start.sessionDate}T00:00:00Z`);
  if (endMs <= startMs) return null;
  const years = (endMs - startMs) / (365.25 * DAY_MS);
  return { rate: (end.close / start.close) ** (1 / years) - 1, years, since: start.sessionDate };
}

/** Annualised standard deviation of daily log returns. */
function volatility(observations: Observation[]): number {
  const window = observations.slice(-VOLATILITY_WINDOW);
  const returns: number[] = [];
  for (let index = 1; index < window.length; index++) {
    returns.push(Math.log(window[index]!.close / window[index - 1]!.close));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

async function observe(fund: FundObservation): Promise<Computed> {
  const { observations } = await fetchSeries(`${fund.symbol}.NZ`);
  const end = observations.at(-1)!;
  const endMs = Date.parse(`${end.sessionDate}T00:00:00Z`);
  const since = annualised(observations, 0)!;

  return {
    symbol: fund.symbol,
    asOf: end.sessionDate,
    since: since.since,
    years: since.years,
    sinceInception: since.rate,
    y5: annualised(observations, endMs - 5 * 365.25 * DAY_MS)?.rate ?? null,
    y3: annualised(observations, endMs - 3 * 365.25 * DAY_MS)?.rate ?? null,
    y1: annualised(observations, endMs - 1 * 365.25 * DAY_MS)?.rate ?? null,
    volatility: volatility(observations),
    points: observations.length,
  };
}

const pct = (value: number | null): string => (value === null ? "   n/a" : `${(value * 100).toFixed(1)}%`.padStart(6));
const signed = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;

const computed: Computed[] = [];
for (const fund of FUND_OBSERVATIONS) {
  try {
    computed.push(await observe(fund));
  } catch (error) {
    console.error(`${fund.symbol}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (computed.length === 0) {
  console.error("\nnothing could be fetched: the table was not checked.");
  process.exitCode = 1;
} else {
  const asOf = computed.map((entry) => entry.asOf).sort().at(-1)!;
  console.log(`\nFund returns from adjusted closes (distributions included), as of ${asOf}`);
  console.log(`committed table is as of ${OBSERVATIONS_AS_OF}\n`);
  console.log("fund   since inception           5y      3y      1y     vol      points");
  for (const entry of computed) {
    console.log(
      `${entry.symbol.padEnd(6)} ${pct(entry.sinceInception)} / ${entry.years.toFixed(1)}y from ${entry.since}` +
        `   ${pct(entry.y5)} ${pct(entry.y3)} ${pct(entry.y1)}  ${pct(entry.volatility)}  ${String(entry.points).padStart(6)}`,
    );
  }

  const drifted: string[] = [];
  for (const entry of computed) {
    const committed = FUND_OBSERVATIONS.find((fund) => fund.symbol === entry.symbol);
    if (!committed) continue;
    const deltas: [string, number][] = [
      ["since inception", entry.sinceInception - committed.sinceInception],
      ["5y", (entry.y5 ?? 0) - (committed.y5 ?? 0)],
      ["3y", (entry.y3 ?? 0) - (committed.y3 ?? 0)],
      // y1 is the noisiest window and the easiest to forget: it was left out of the
      // first version of this check, which is how a 1.4pp difference on AUS survived a
      // run that reported everything as within tolerance.
      ["1y", (entry.y1 ?? 0) - (committed.y1 ?? 0)],
      ["volatility", entry.volatility - committed.volatility],
    ];
    const moved = deltas.filter(([, delta]) => Math.abs(delta) > DRIFT_TOLERANCE);
    if (moved.length > 0) {
      drifted.push(`  ${entry.symbol}: ${moved.map(([label, delta]) => `${label} ${signed(delta)}`).join(", ")}`);
    }
  }

  console.log("");
  if (drifted.length === 0) {
    console.log(`Every figure is within ${(DRIFT_TOLERANCE * 100).toFixed(1)}pp of the committed table.`);
  } else {
    console.log(`Drift against the committed table (over ${(DRIFT_TOLERANCE * 100).toFixed(1)}pp):`);
    console.log(drifted.join("\n"));
    console.log(
      "\nUpdate FUND_OBSERVATIONS if the new figures are right, and reconsider ASSET_CLASS_RETURNS\n" +
        "if the change is large: the assumptions are long-run figures, not a tracking of the last month.",
    );
  }
  console.log("");
}
