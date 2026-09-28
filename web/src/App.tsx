import { useCallback, useEffect, useState } from "react";
import {
  api,
  nzd,
  type Contribution,
  type Holdings,
  type Projection,
  type Settings,
  type SnapshotSeries,
  type Summary,
} from "./api.ts";
import { GoalProgress } from "./components/GoalProgress.tsx";
import { MilestoneTimeline } from "./components/MilestoneTimeline.tsx";
import { SyncHealthStrip } from "./components/SyncHealthStrip.tsx";
import { AllocationDonut, ContributionsChart, ProjectionChart, ValueChart } from "./components/Charts.tsx";
import { ContributionLog } from "./components/ContributionLog.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";

interface Data {
  summary: Summary;
  series: SnapshotSeries;
  holdings: Holdings;
  contributions: { contributions: Contribution[]; total: number; totalAllTime: number };
  projection: Projection;
  settings: Settings;
}

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [summary, series, holdings, contributions, projection, settings] = await Promise.all([
        api.summary(),
        api.snapshots(),
        api.holdings(),
        api.contributions(),
        api.projection({}),
        api.settings(),
      ]);
      setData({ summary, series, holdings, contributions, projection, settings });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runSync = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await api.sync();
      const result = response.result;
      setMessage(
        result.status === "error"
          ? `Sync failed: ${result.error}`
          : `Synced ${result.snapshotsWritten} snapshot(s)` +
              (result.value === null ? "" : `, portfolio ${nzd(result.value)}`) +
              (result.warnings.length > 0 ? `. ${result.warnings.join(" ")}` : ""),
      );
      await load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const runRefresh = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await api.refresh();
      setMessage(
        response.refreshed
          ? "Akahu accepted the refresh request. Sync again in a few minutes to pick up new values."
          : (response.message ?? "Refresh was not accepted."),
      );
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="shell">
        {error ? (
          <div className="banner bad">
            <strong>Could not reach the API</strong>
            <span>{error}. Is the server running (npm run api)?</span>
          </div>
        ) : (
          <p className="spinner">Loading the dashboard…</p>
        )}
      </div>
    );
  }

  const { summary, series, holdings, contributions, projection, settings } = data;
  const health = summary.syncHealth;

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <h1>Sharesies Goal Dashboard</h1>
          <div className="sub">
            as of {summary.asOf} · {nzd(summary.currentValue)} across {health.accounts.length} account
            {health.accounts.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="badges">
          <span className={`badge ${summary.dataMode === "akahu" ? "good" : "warn"}`}>
            {summary.dataMode === "akahu"
              ? "Akahu live"
              : summary.dataMode === "manual"
                ? "manual value"
                : summary.dataMode === "demo"
                  ? "demo data"
                  : "no data"}
          </span>
          <span className={`badge ${health.stale ? "warn" : "good"}`}>
            {health.lastSnapshotDate ? `snapshot ${health.lastSnapshotDate}` : "no snapshots"}
          </span>
          {health.hasInactive && <span className="badge bad">reconnect needed</span>}
        </div>
      </header>

      {error && (
        <div className="banner warn">
          <strong>Refresh failed</strong>
          <span>{error}</span>
        </div>
      )}

      {health.stale && health.staleReason && (
        <div className={`banner ${health.hasInactive ? "bad" : "warn"}`}>
          <strong>{health.hasInactive ? "Reconnect needed" : "Data may be stale"}</strong>
          <span>{health.staleReason}</span>
        </div>
      )}

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <GoalProgress summary={summary} milestones={summary.milestones} />
        <SyncHealthStrip
          health={health}
          settings={settings}
          onSync={runSync}
          onRefresh={runRefresh}
          busy={busy}
          message={message}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <ValueChart series={series} milestones={summary.milestones} />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <MilestoneTimeline milestones={summary.milestones} projection={projection} />
        <AllocationDonut holdings={holdings} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <ProjectionChart projection={projection} />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <ContributionsChart series={series} contributions={contributions.contributions} />
        <ContributionLog
          contributions={contributions.contributions}
          totalAllTime={contributions.totalAllTime}
          onAdd={async (body) => {
            await api.addContribution(body);
            await load();
          }}
          onDelete={async (id) => {
            await api.deleteContribution(id);
            await load();
          }}
        />
      </div>

      <SettingsPanel settings={settings} summary={summary} onReload={load} api={api} />
    </div>
  );
}
