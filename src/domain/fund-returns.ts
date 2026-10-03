/**
 * What the funds in this portfolio have actually returned, and what the projection
 * assumes they will.
 *
 * Two different things, deliberately kept apart.
 *
 * **The observations** are annualised total returns from adjusted closes, so
 * distributions are included. `npm run fund:returns` recomputes them from market data
 * and prints this table, which is why every figure here can be checked rather than
 * trusted. Basis: after fund fees (they are charged inside the fund, so they are in
 * the unit price), before tax.
 *
 * **The assumptions** are forward-looking, one per asset class, and at portfolio level
 * they are lower than the observations. That is not timidity. The observed window is
 * 2020-2026 for the equity funds and 2015-2026 for the bond and cash funds: an
 * exceptional run for global equities plus a falling NZD, giving this portfolio's
 * allocation a weighted observed return near 10.7% a year. Projecting that forward
 * would be extrapolating a peak, which is the mistake the "assumptions, not
 * predictions" labelling exists to prevent. So both numbers are kept: the assumption
 * drives the projection, and the observation sits beside it, per fund, in the UI.
 *
 * The comparison holds at portfolio level and deliberately not per fund: NZG returned
 * 3.4% a year over its six-year window, below the 7% equity assumption. A short window
 * on one market is not evidence about the next twenty years, which is the whole reason
 * the assumption is a class figure and the per-fund evidence is shown rather than
 * averaged into it.
 *
 * A cross-check on the observations, for the one fund with the longest history:
 * published figures for TWF put its five-year return at 11.5% (Sorted, after fees and
 * tax, to May 2026) and 14.2% p.a. after fees and before tax (fund update). This
 * table says 15.3% to October 2026. The gap is the window end date and the tax basis,
 * not a disagreement about the fund.
 */
export type AssetClass = "equity" | "bond" | "cash";

export interface FundObservation {
  /** The ticker the holdings table uses, and the NZX code. */
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Annualised total return from the first observation to `asOf`, e.g. 0.114. */
  sinceInception: number;
  /** How long `sinceInception` covers. */
  years: number;
  /** Annualised over the last 5 / 3 / 1 years, or null where the fund is younger. */
  y5: number | null;
  y3: number | null;
  y1: number | null;
  /** Annualised standard deviation of daily returns, last two years. */
  volatility: number;
  /** First observation. */
  since: string;
}

/** The last session the figures were computed from. */
export const OBSERVATIONS_AS_OF = "2026-10-02";

export const FUND_OBSERVATIONS: FundObservation[] = [
  {
    symbol: "TWH", name: "Smart Total World (NZD Hedged) ETF", assetClass: "equity",
    sinceInception: 0.129, years: 6.2, y5: 0.102, y3: 0.185, y1: 0.139, volatility: 0.170, since: "2020-07-14",
  },
  {
    symbol: "TWF", name: "Smart Total World ETF", assetClass: "equity",
    sinceInception: 0.114, years: 11.2, y5: 0.153, y3: 0.235, y1: 0.195, volatility: 0.159, since: "2015-08-03",
  },
  {
    symbol: "AUS", name: "Smart Australian Top 200 ETF", assetClass: "equity",
    sinceInception: 0.124, years: 6.2, y5: 0.108, y3: 0.166, y1: 0.095, volatility: 0.169, since: "2020-07-14",
  },
  {
    symbol: "NZG", name: "Smart S&P/NZX 50 ETF", assetClass: "equity",
    sinceInception: 0.034, years: 6.2, y5: 0.012, y3: 0.078, y1: 0.035, volatility: 0.126, since: "2020-07-14",
  },
  {
    symbol: "AGG", name: "Smart Global Aggregate Bond ETF", assetClass: "bond",
    sinceInception: 0.005, years: 7.3, y5: -0.003, y3: 0.040, y1: -0.007, volatility: 0.073, since: "2019-06-05",
  },
  {
    symbol: "NZB", name: "Smart NZ Bond ETF", assetClass: "bond",
    sinceInception: 0.033, years: 10.9, y5: 0.028, y3: 0.057, y1: 0.028, volatility: 0.026, since: "2015-11-12",
  },
  {
    symbol: "NZC", name: "Smart NZ Cash ETF", assetClass: "cash",
    sinceInception: 0.029, years: 10.9, y5: 0.038, y3: 0.045, y1: 0.024, volatility: 0.013, since: "2015-11-12",
  },
];

export interface AssetClassAssumption {
  /** Long-run nominal return in NZD, as a decimal. */
  rate: number;
  /** Why this figure, in one sentence, for whoever has to defend it. */
  rationale: string;
}

/**
 * Forward-looking assumptions, long-run and nominal NZD, after fees and before tax.
 *
 * Three classes rather than seven funds on purpose: the funds inside a class differ
 * mostly by market, and pretending to seven decimal places of precision about the
 * next twenty years would be false comfort. The observations above are where the
 * per-fund detail lives.
 */
export const ASSET_CLASS_RETURNS: Record<AssetClass, AssetClassAssumption> = {
  equity: {
    rate: 0.07,
    rationale:
      "Diversified global and Australasian equities, long run: about 7% nominal in NZD, below the " +
      "10-15% the funds have returned over the last six years because that period is not repeatable on demand.",
  },
  bond: {
    rate: 0.035,
    rationale:
      "Investment-grade bonds, long run: about 3.5%, roughly a real return near zero at a 2-3% inflation rate, " +
      "above what these funds earned while rates rose from 2021 to 2024.",
  },
  cash: {
    rate: 0.03,
    rationale:
      "Cash: about 3%, a neutral policy rate rather than the current one; the observed 2.9% over 11 years is the " +
      "clearest evidence that this fund tracks the official rate rather than beating it.",
  },
};

export interface ReturnHolding {
  /** The ticker from the holdings table; null when Akahu did not provide one. */
  symbol: string | null;
  value: number | null;
}

export interface BlendedHolding {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Share of the valued portfolio, 0..1. */
  weight: number;
  value: number;
  assumedReturn: number;
  /** Observed since-inception return, for comparison. */
  observedReturn: number;
}

export interface ReturnBlend {
  /** Allocation-weighted long-run assumption, or null when nothing matched. */
  rate: number | null;
  /** The same weights on the observed since-inception figures, for comparison. */
  observedRate: number | null;
  /** Weighted average volatility, last two years. */
  volatility: number | null;
  /** Share of the portfolio's value that matched a fund in the table, 0..1. */
  covered: number;
  holdings: BlendedHolding[];
  /** Symbols that matched no fund, so the coverage figure can be explained. */
  unmatched: string[];
}

export function findObservation(symbol: string | null): FundObservation | null {
  if (symbol === null) return null;
  const wanted = symbol.trim().toUpperCase();
  return FUND_OBSERVATIONS.find((fund) => fund.symbol === wanted) ?? null;
}

/**
 * Weights the portfolio by value and returns the blended assumption.
 *
 * The weighted average is taken over the holdings that matched, not over everything:
 * an unknown fund would otherwise be counted as returning nothing, which would quietly
 * lower the figure. `covered` reports how much of the portfolio the answer describes,
 * so a caller can say so instead of implying it covers everything.
 */
export function blendAssumedReturn(holdings: ReturnHolding[]): ReturnBlend {
  const valued = holdings.filter(
    (holding): holding is { symbol: string | null; value: number } =>
      typeof holding.value === "number" && Number.isFinite(holding.value) && holding.value > 0,
  );
  const totalValue = valued.reduce((sum, holding) => sum + holding.value, 0);

  const matched: { holding: { symbol: string | null; value: number }; fund: FundObservation }[] = [];
  const unmatched: string[] = [];
  for (const holding of valued) {
    const fund = findObservation(holding.symbol);
    if (fund) matched.push({ holding, fund });
    else unmatched.push(holding.symbol ?? "(no symbol)");
  }

  if (matched.length === 0 || totalValue <= 0) {
    return { rate: null, observedRate: null, volatility: null, covered: 0, holdings: [], unmatched };
  }

  const matchedValue = matched.reduce((sum, entry) => sum + entry.holding.value, 0);
  const blend = (pick: (fund: FundObservation) => number): number =>
    matched.reduce((sum, entry) => sum + (entry.holding.value / matchedValue) * pick(entry.fund), 0);

  return {
    rate: blend((fund) => ASSET_CLASS_RETURNS[fund.assetClass].rate),
    observedRate: blend((fund) => fund.sinceInception),
    volatility: blend((fund) => fund.volatility),
    covered: totalValue > 0 ? matchedValue / totalValue : 0,
    holdings: matched
      .map((entry) => ({
        symbol: entry.fund.symbol,
        name: entry.fund.name,
        assetClass: entry.fund.assetClass,
        weight: entry.holding.value / matchedValue,
        value: entry.holding.value,
        assumedReturn: ASSET_CLASS_RETURNS[entry.fund.assetClass].rate,
        observedReturn: entry.fund.sinceInception,
      }))
      .sort((left, right) => right.value - left.value),
    unmatched,
  };
}
