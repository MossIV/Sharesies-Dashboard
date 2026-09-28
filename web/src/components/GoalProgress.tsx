import type { EvaluatedMilestone, Summary } from "../api.ts";
import { nzd, pct } from "../api.ts";

const PACE_LABEL: Record<string, string> = {
  ahead: "Ahead of pace",
  on_track: "On track",
  behind: "Behind pace",
  unknown: "Pace unavailable",
};

export function GoalProgress({ summary, milestones }: { summary: Summary; milestones: EvaluatedMilestone[] }) {
  const goal = summary.goal;

  if (!goal) {
    return (
      <div className="card">
        <h2>Goal progress</h2>
        <p className="empty">No goal yet. Set one in Settings to start tracking progress and milestones.</p>
      </div>
    );
  }

  const basisLabel = goal.progressBasis === "contributions" ? "net contributions" : "portfolio value";

  return (
    <div className="card">
      <h2>
        Goal progress
        <span className="hint">measured on {basisLabel}</span>
      </h2>

      <div className="metric-row">
        <div>
          <div className="metric-label">Current</div>
          <div className="metric mono">{nzd(summary.currentValue)}</div>
        </div>
        <div>
          <div className="metric-label">Goal · {goal.name}</div>
          <div className="metric mono">{nzd(goal.targetAmountNzd)}</div>
        </div>
        <div>
          <div className="metric-label">Remaining</div>
          <div className="metric mono">{nzd(goal.remaining)}</div>
        </div>
      </div>

      <div className="progress-outer">
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, goal.progressPct))}%` }} />
        </div>
        {milestones.map((milestone) => {
          const position = Math.min(100, (milestone.amountNzd / goal.targetAmountNzd) * 100);
          return (
            <div
              key={milestone.id}
              className={`progress-marker ${milestone.state}`}
              style={{ left: `calc(${position}% - 1px)` }}
              title={`${milestone.label}: ${nzd(milestone.amountNzd)}${
                milestone.firstReachedOn ? ` (reached ${milestone.firstReachedOn})` : ""
              }`}
            >
              {milestone.state === "next" && <span>{nzd(milestone.amountNzd, { compact: true })}</span>}
            </div>
          );
        })}
      </div>

      <div className="metric-row" style={{ gap: 34 }}>
        <div>
          <div className="metric-label">Progress</div>
          <div className="metric small mono">{pct(goal.progressPct)}</div>
        </div>
        <div>
          <div className="metric-label">Pace</div>
          <div className={`pace ${goal.pace.status}`} style={{ marginTop: 6 }}>
            {PACE_LABEL[goal.pace.status]}
            {goal.pace.deltaPct !== null && (
              <span className="mono">
                {goal.pace.deltaPct > 0 ? "+" : ""}
                {pct(goal.pace.deltaPct)}
              </span>
            )}
          </div>
        </div>
        {goal.targetDate && (
          <div>
            <div className="metric-label">Target</div>
            <div className="metric small mono">{goal.targetDate}</div>
          </div>
        )}
        {goal.requiredMonthly !== null && !goal.targetPassed && (
          <div>
            <div className="metric-label">Needed monthly</div>
            <div className="metric small mono">{nzd(goal.requiredMonthly)}</div>
          </div>
        )}
      </div>

      {goal.pace.status !== "unknown" && goal.pace.expectedValue !== null && (
        <p className="muted tiny" style={{ marginBottom: 0 }}>
          Straight-line path from {goal.pace.baselineDate} ({nzd(goal.pace.baselineValue)}) expects about{" "}
          {nzd(goal.pace.expectedValue)} today. This is a simple comparison, not a forecast.
        </p>
      )}

      {summary.change7d !== null && (
        <p className="muted tiny" style={{ marginBottom: 0 }}>
          7 day change {summary.change7d >= 0 ? "+" : ""}
          {nzd(summary.change7d)}
          {summary.change30d !== null && (
            <>
              {" · "}30 day change {summary.change30d >= 0 ? "+" : ""}
              {nzd(summary.change30d)}
            </>
          )}
        </p>
      )}
    </div>
  );
}
