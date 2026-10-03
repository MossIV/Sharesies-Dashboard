import { useState } from "react";
import type { EvaluatedMilestone, Settings, Summary } from "../api.ts";
import { nzd } from "../api.ts";

interface Props {
  settings: Settings | null;
  summary: Summary | null;
  onReload: () => void;
  api: {
    createGoal: (body: {
      name: string;
      targetAmountNzd: number;
      targetDate?: string | null;
      progressBasis?: "value" | "contributions";
      withPercentMilestones?: boolean;
    }) => Promise<unknown>;
    updateGoal: (id: number, patch: Record<string, unknown>) => Promise<unknown>;
    createMilestone: (goalId: number, body: Record<string, unknown>) => Promise<unknown>;
    deleteMilestone: (id: number) => Promise<unknown>;
    updateSettings: (patch: {
      annualReturn?: number;
      monthlyContribution?: number;
      contributionsBasis?: "external" | "trades" | "auto";
    }) => Promise<unknown>;
    setManualValue: (value: number) => Promise<unknown>;
  };
}

export function SettingsPanel({ settings, summary, onReload, api }: Props) {
  const goal = summary?.goal ?? null;
  const milestones: EvaluatedMilestone[] = summary?.milestones ?? [];

  const [goalName, setGoalName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(String(goal?.targetAmountNzd ?? 100000));
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? "");
  const [basis, setBasis] = useState<"value" | "contributions">(goal?.progressBasis ?? "value");
  const [withPercent, setWithPercent] = useState(true);

  const [milestoneLabel, setMilestoneLabel] = useState("");
  const [milestoneAmount, setMilestoneAmount] = useState("");

  const [annualReturn, setAnnualReturn] = useState(
    String(Math.round((settings?.assumptions.annualReturn ?? 0.07) * 1000) / 10),
  );
  const [monthly, setMonthly] = useState(String(settings?.assumptions.monthlyContribution ?? 500));
  const [contribBasis, setContribBasis] = useState<"external" | "trades" | "auto">(
    settings?.contributions.requested ?? "auto",
  );
  const [manualValue, setManualValue] = useState(settings?.manualValueNzd ?? "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await action();
      setOk(label);
      onReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>
        Settings
        <span className="hint">goal, milestones and the projection assumptions</span>
      </h2>

      <div className="stack" style={{ gap: 22 }}>
        <section>
          <h3 style={{ fontSize: 14, margin: "0 0 10px" }}>{goal ? "Goal" : "Create a goal"}</h3>
          <div className="form-row">
            <div style={{ flex: "1 1 180px" }}>
              <label htmlFor="goal-name">Name</label>
              <input
                id="goal-name"
                value={goalName}
                onChange={(event) => setGoalName(event.target.value)}
                placeholder="House deposit"
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ flex: "1 1 130px" }}>
              <label htmlFor="goal-target">Target (NZD)</label>
              <input
                id="goal-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                inputMode="decimal"
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ flex: "1 1 150px" }}>
              <label htmlFor="goal-date">Target date (optional)</label>
              <input
                id="goal-date"
                type="date"
                value={targetDate ?? ""}
                onChange={(event) => setTargetDate(event.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ flex: "0 1 150px" }}>
              <label htmlFor="goal-basis">Progress basis</label>
              <select
                id="goal-basis"
                value={basis}
                onChange={(event) => setBasis(event.target.value as "value" | "contributions")}
                style={{ width: "100%" }}
              >
                <option value="value">Portfolio value</option>
                <option value="contributions">Net contributions</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            {goal ? (
              <button
                disabled={busy}
                onClick={() =>
                  run("Goal updated", () =>
                    api.updateGoal(goal.id, {
                      name: goalName,
                      targetAmountNzd: Number(target),
                      targetDate: targetDate === "" ? null : targetDate,
                      progressBasis: basis,
                    })
                  )
                }
              >
                Save goal
              </button>
            ) : (
              <>
                <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={withPercent}
                    onChange={(event) => setWithPercent(event.target.checked)}
                    style={{ width: "auto" }}
                  />
                  <span className="muted tiny">also create 25/50/75/100% milestones</span>
                </label>
                <button
                  disabled={busy || goalName.trim() === ""}
                  onClick={() =>
                    run("Goal created", () =>
                      api.createGoal({
                        name: goalName,
                        targetAmountNzd: Number(target),
                        targetDate: targetDate === "" ? null : targetDate,
                        progressBasis: basis,
                        withPercentMilestones: withPercent,
                      })
                    )
                  }
                >
                  Create goal
                </button>
              </>
            )}
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: 14, margin: "0 0 10px" }}>Milestones</h3>
          {milestones.length > 0 && (
            <table>
              <tbody>
                {milestones.map((milestone) => (
                  <tr key={milestone.id}>
                    <td>
                      <span className={`dot ${milestone.state}`} />
                      {milestone.label}
                    </td>
                    <td className="num mono">{nzd(milestone.amountNzd)}</td>
                    <td style={{ width: 80 }} className="num">
                      <button
                        className="danger small"
                        disabled={busy}
                        onClick={() => run("Milestone removed", () => api.deleteMilestone(milestone.id))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="form-row" style={{ marginTop: 12, marginBottom: 0 }}>
            <div style={{ flex: "1 1 180px" }}>
              <label htmlFor="ms-label">New milestone</label>
              <input
                id="ms-label"
                value={milestoneLabel}
                onChange={(event) => setMilestoneLabel(event.target.value)}
                placeholder="Emergency buffer"
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ flex: "1 1 130px" }}>
              <label htmlFor="ms-amount">Amount (NZD)</label>
              <input
                id="ms-amount"
                value={milestoneAmount}
                onChange={(event) => setMilestoneAmount(event.target.value)}
                inputMode="decimal"
                style={{ width: "100%" }}
              />
            </div>
            <button
              className="ghost"
              disabled={busy || !goal || milestoneLabel.trim() === "" || !Number(milestoneAmount)}
              onClick={() =>
                run("Milestone added", () =>
                  api.createMilestone(goal!.id, { label: milestoneLabel, amountNzd: Number(milestoneAmount) })
                )
              }
            >
              Add
            </button>
            <button
              className="ghost"
              disabled={busy || !goal}
              onClick={() =>
                run("Percent milestones created", () =>
                  api.createMilestone(goal!.id, { percent: [25, 50, 75, 100] })
                )
              }
            >
              Add 25/50/75/100%
            </button>
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: 14, margin: "0 0 10px" }}>Projection assumptions</h3>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <div style={{ flex: "0 1 150px" }}>
              <label htmlFor="assumption-return">Assumed annual return (%)</label>
              <input
                id="assumption-return"
                value={annualReturn}
                onChange={(event) => setAnnualReturn(event.target.value)}
                inputMode="decimal"
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ flex: "0 1 170px" }}>
              <label htmlFor="assumption-monthly">Assumed monthly contribution</label>
              <input
                id="assumption-monthly"
                value={monthly}
                onChange={(event) => setMonthly(event.target.value)}
                inputMode="decimal"
                style={{ width: "100%" }}
              />
            </div>
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                run("Assumptions saved", () =>
                  api.updateSettings({
                    annualReturn: Number(annualReturn) / 100,
                    monthlyContribution: Number(monthly),
                  })
                )
              }
            >
              Save assumptions
            </button>
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: 14, margin: "0 0 10px" }}>What counts as a contribution</h3>
          <p className="muted tiny" style={{ marginTop: 0 }}>{settings?.contributions.note ?? ""}</p>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <div style={{ flex: "0 1 300px" }}>
              <label htmlFor="contrib-basis">Counted toward contributions</label>
              <select
                id="contrib-basis"
                value={contribBasis}
                onChange={(event) => setContribBasis(event.target.value as "external" | "trades" | "auto")}
                style={{ width: "100%" }}
              >
                <option value="auto">Automatic — external flows when there are any</option>
                <option value="external">Money sent to Sharesies only</option>
                <option value="trades">Buys into the account, as a proxy</option>
              </select>
            </div>
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                run("Contribution basis saved", () => api.updateSettings({ contributionsBasis: contribBasis }))
              }
            >
              Save basis
            </button>
          </div>
          {settings && (
            <p className="muted tiny">
              In force: <strong>{settings.contributions.basis === "external" ? "money sent" : "buys as a proxy"}</strong>
              {" "}— {settings.contributions.source === "auto"
                ? "chosen automatically from what is logged"
                : `set by ${settings.contributions.source}`}
              .
            </p>
          )}
        </section>

        <section>
          <h3 style={{ fontSize: 14, margin: "0 0 10px" }}>Manual value</h3>
          <p className="muted tiny" style={{ marginTop: 0 }}>
            Used when Akahu is unavailable or before the tokens are set. Records a snapshot for today.
          </p>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <div style={{ flex: "0 1 170px" }}>
              <label htmlFor="manual-value">Portfolio value (NZD)</label>
              <input
                id="manual-value"
                value={manualValue}
                onChange={(event) => setManualValue(event.target.value)}
                inputMode="decimal"
                style={{ width: "100%" }}
              />
            </div>
            <button
              className="ghost"
              disabled={busy || !Number(manualValue)}
              onClick={() => run("Snapshot recorded", () => api.setManualValue(Number(manualValue)))}
            >
              Record and collect
            </button>
          </div>
        </section>
      </div>

      {error && <p className="error">{error}</p>}
      {ok && <p className="tiny" style={{ color: "var(--good)" }}>{ok}</p>}
    </div>
  );
}
