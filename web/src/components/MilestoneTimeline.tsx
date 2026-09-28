import type { EvaluatedMilestone, Projection } from "../api.ts";
import { nzd, shortDate } from "../api.ts";

const STATE_LABEL: Record<string, string> = {
  reached: "Reached",
  next: "Next",
  future: "Future",
};

function etaText(projection: Projection | null, id: number, key: "low" | "base" | "high"): string {
  const milestone = projection?.milestones.find((entry) => entry.id === id);
  const date = milestone?.etaDates?.[key] ?? null;
  return date ? shortDate(date) : "beyond horizon";
}

export function MilestoneTimeline({
  milestones,
  projection,
}: {
  milestones: EvaluatedMilestone[];
  projection: Projection | null;
}) {
  return (
    <div className="card">
      <h2>
        Milestone timeline
        <span className="hint">reached dates are kept even if the value dips</span>
      </h2>

      {milestones.length === 0 ? (
        <p className="empty">No milestones yet. Add custom amounts or generate the 25/50/75/100% set in Settings.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Milestone</th>
              <th className="num">Amount</th>
              <th>State</th>
              <th>Reached</th>
              <th className="num">Projected (base)</th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((milestone) => (
              <tr key={milestone.id}>
                <td>
                  <span className={`dot ${milestone.state}`} />
                  {milestone.label}
                  {milestone.notes && (
                    <>
                      <br />
                      <span className="muted tiny">{milestone.notes}</span>
                    </>
                  )}
                </td>
                <td className="num mono">{nzd(milestone.amountNzd)}</td>
                <td>
                  <span className="muted tiny">{STATE_LABEL[milestone.state]}</span>
                  {milestone.currentlyBelow && (
                    <>
                      <br />
                      <span className="tiny" style={{ color: "var(--warn)" }}>
                        currently below by {nzd(milestone.gap)}
                      </span>
                    </>
                  )}
                </td>
                <td className="tiny mono">{milestone.firstReachedOn ? shortDate(milestone.firstReachedOn) : "–"}</td>
                <td className="num mono tiny">
                  {milestone.firstReachedOn ? "reached" : etaText(projection, milestone.id, "base")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
