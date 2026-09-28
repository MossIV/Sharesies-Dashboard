import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Contribution, EvaluatedMilestone, Holdings, Projection, SnapshotSeries } from "../api.ts";
import { nzd, shortDate } from "../api.ts";

const GRID = "#24304e";
const AXIS = "#93a0bd";
const ACCENT = "#5b8cff";
const GOOD = "#35c48f";
const WARN = "#f0b429";
const DIM = "#7c8bb0";

const axisProps = {
  stroke: AXIS,
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

const compactTick = (value: number): string => nzd(value, { compact: true });

function TooltipBox({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; dataKey?: string }[];
  label?: string;
  format?: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const fmt = format ?? ((value: number) => nzd(value));
  return (
    <div className="tooltip">
      <strong>{label ? shortDate(label) : ""}</strong>
      {payload.map((entry) => (
        <div key={String(entry.dataKey ?? entry.name)} style={{ color: entry.color }}>
          {entry.name}: {typeof entry.value === "number" ? fmt(entry.value) : "–"}
        </div>
      ))}
    </div>
  );
}

/** Value over time, with milestone lines and reached-date markers. */
export function ValueChart({
  series,
  milestones,
}: {
  series: SnapshotSeries | null;
  milestones: EvaluatedMilestone[];
}) {
  const points = series?.points ?? [];

  // Only milestones inside the plotted range are worth a reference line.
  const values = points.map((point) => point.value);
  const low = values.length > 0 ? Math.min(...values) : 0;
  const high = values.length > 0 ? Math.max(...values) : 0;
  const visible = milestones.filter((milestone) => milestone.amountNzd >= low * 0.9 && milestone.amountNzd <= high * 1.1);

  return (
    <div className="card">
      <h2>
        Value over time
        <span className="hint">
          {points.length} snapshot{points.length === 1 ? "" : "s"} · each point is one calendar day
        </span>
      </h2>

      {points.length === 0 ? (
        <p className="empty">
          No history yet. History starts the day collection starts, because Akahu only serves the current value.
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps} minTickGap={40} />
              <YAxis tickFormatter={compactTick} {...axisProps} width={64} domain={["auto", "auto"]} />
              <Tooltip content={<TooltipBox />} />
              {visible.map((milestone) => (
                <ReferenceLine
                  key={milestone.id}
                  y={milestone.amountNzd}
                  stroke={milestone.state === "reached" ? GOOD : milestone.state === "next" ? WARN : GRID}
                  strokeDasharray="4 4"
                  label={{ value: milestone.label, position: "insideTopRight", fill: AXIS, fontSize: 11 }}
                />
              ))}
              <Line
                type="monotone"
                dataKey="value"
                name="Portfolio"
                stroke={ACCENT}
                strokeWidth={2}
                dot={points.length <= 40}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="legend">
            <span>
              <span className="swatch" style={{ background: GOOD }} />
              reached milestone
            </span>
            <span>
              <span className="swatch" style={{ background: WARN }} />
              next milestone
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Low / base / high scenarios to the goal, plus the required contribution. */
export function ProjectionChart({ projection }: { projection: Projection | null }) {
  if (!projection) return <div className="card"><h2>Projection</h2><p className="empty">Loading…</p></div>;

  const byMonth = new Map<number, { month: number; date: string; low?: number; base?: number; high?: number }>();
  for (const scenario of projection.scenarios) {
    for (const point of scenario.points) {
      const row = byMonth.get(point.month) ?? { month: point.month, date: point.date };
      row[scenario.key] = point.value;
      byMonth.set(point.month, row);
    }
  }
  const data = [...byMonth.values()].sort((a, b) => a.month - b.month);

  const goal = projection.goal;
  const base = projection.scenarios.find((scenario) => scenario.key === "base");

  return (
    <div className="card">
      <h2>
        Projection
        <span className="hint">assumptions, not predictions</span>
      </h2>

      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps} minTickGap={48} />
          <YAxis tickFormatter={compactTick} {...axisProps} width={64} />
          <Tooltip content={<TooltipBox />} />
          {goal && (
            <ReferenceLine
              y={goal.targetAmountNzd}
              stroke={DIM}
              strokeDasharray="6 4"
              label={{ value: `Goal ${nzd(goal.targetAmountNzd, { compact: true })}`, position: "insideTopLeft", fill: AXIS, fontSize: 11 }}
            />
          )}
          <Line type="monotone" dataKey="low" name="Low (−2pp)" stroke="#8d7bd6" dot={false} strokeWidth={1.6} />
          <Line type="monotone" dataKey="base" name="Base" stroke={ACCENT} dot={false} strokeWidth={2.2} />
          <Line type="monotone" dataKey="high" name="High (+2pp)" stroke={GOOD} dot={false} strokeWidth={1.6} />
        </LineChart>
      </ResponsiveContainer>

      <div className="legend">
        <span>
          <span className="swatch" style={{ background: "#8d7bd6" }} />
          {((projection.assumptions.annualReturn - 0.02) * 100).toFixed(1)}% low
        </span>
        <span>
          <span className="swatch" style={{ background: ACCENT }} />
          {(projection.assumptions.annualReturn * 100).toFixed(1)}% base
        </span>
        <span>
          <span className="swatch" style={{ background: GOOD }} />
          {((projection.assumptions.annualReturn + 0.02) * 100).toFixed(1)}% high
        </span>
        <span>
          +{nzd(projection.assumptions.monthlyContribution)}/month ·{" "}
          {Math.round(projection.assumptions.months / 12)} year horizon
        </span>
      </div>

      {goal?.requiredMonthly !== null && goal?.requiredMonthly !== undefined && (
        <div className="callout" style={{ marginTop: 12 }}>
          To reach <strong>{nzd(goal.targetAmountNzd)}</strong> by <strong>{shortDate(goal.targetDate)}</strong> you
          would need to contribute about <strong>{nzd(goal.requiredMonthly)}</strong> per month at an assumed{" "}
          {(projection.assumptions.annualReturn * 100).toFixed(1)}% annual return.
          {base && (
            <>
              {" "}
              The base scenario alone reaches it{" "}
              {(() => {
                const point = base.points.find((entry) => entry.value >= goal.targetAmountNzd);
                return point ? `in ${shortDate(point.date)}.` : "beyond this horizon.";
              })()}
            </>
          )}
        </div>
      )}

      <p className="disclaimer">{projection.disclaimer}</p>
    </div>
  );
}

/** Stacked area: how much of the value is deposits versus growth. */
export function ContributionsChart({
  series,
  contributions,
}: {
  series: SnapshotSeries | null;
  contributions: Contribution[];
}) {
  const points = series?.points ?? [];

  // Cumulative deposits as of each snapshot date; the remainder is growth.
  const rows = points.map((point) => {
    const contributed = contributions
      .filter((entry) => entry.contributionDate <= point.date)
      .reduce((sum, entry) => sum + entry.amountNzd, 0);
    return {
      date: point.date,
      contributions: Math.round(contributed * 100) / 100,
      growth: Math.round((point.value - contributed) * 100) / 100,
    };
  });

  return (
    <div className="card">
      <h2>
        Contributions vs growth
        <span className="hint">needs the contribution log</span>
      </h2>

      {contributions.length === 0 ? (
        <p className="empty">
          No contributions logged. Akahu cannot see your Sharesies trades, so log deposits below (or import the
          Sharesies Transaction Report) to separate deposits from growth.
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps} minTickGap={40} />
              <YAxis tickFormatter={compactTick} {...axisProps} width={64} />
              <Tooltip content={<TooltipBox />} />
              <Legend wrapperStyle={{ fontSize: 12, color: AXIS }} />
              <Area
                type="monotone"
                dataKey="contributions"
                name="Deposits"
                stackId="1"
                stroke={ACCENT}
                fill={ACCENT}
                fillOpacity={0.35}
              />
              <Area
                type="monotone"
                dataKey="growth"
                name="Growth"
                stackId="1"
                stroke={GOOD}
                fill={GOOD}
                fillOpacity={0.3}
              />
            </AreaChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}

const DONUT_COLOURS = ["#5b8cff", "#35c48f", "#f0b429", "#c07bd6", "#f2686b", "#4bbfd6", "#8d7bd6", "#8fa3c8"];

/** Allocation donut, only when Akahu exposes meta.portfolio. */
export function AllocationDonut({ holdings }: { holdings: Holdings | null }) {
  const data = (holdings?.holdings ?? [])
    .filter((holding) => (holding.value ?? 0) > 0)
    .map((holding) => ({
      name: holding.symbol ?? holding.name ?? "Unknown",
      value: holding.value ?? 0,
      sharePct: holding.sharePct,
    }));

  return (
    <div className="card">
      <h2>
        Allocation
        <span className="hint">from meta.portfolio, when Akahu provides it</span>
      </h2>

      {data.length === 0 ? (
        <p className="empty">
          {holdings?.note ??
            "No holdings available. Akahu does not guarantee portfolio data for Sharesies, so the dashboard falls back to value only."}
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2} stroke="none">
                {data.map((entry, index) => (
                  <Cell key={entry.name + index} fill={DONUT_COLOURS[index % DONUT_COLOURS.length]} />
                ))}
              </Pie>
              <Tooltip content={<TooltipBox />} />
            </PieChart>
          </ResponsiveContainer>
          <table>
            <tbody>
              {data.map((entry, index) => (
                <tr key={entry.name + index}>
                  <td>
                    <span className="dot" style={{ background: DONUT_COLOURS[index % DONUT_COLOURS.length] }} />
                    {entry.name}
                  </td>
                  <td className="num mono tiny">{entry.sharePct === null ? "–" : `${entry.sharePct}%`}</td>
                  <td className="num mono">{nzd(entry.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
