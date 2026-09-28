import type { Settings, SyncHealth } from "../api.ts";
import { nzd, relativeTime } from "../api.ts";

export function SyncHealthStrip({
  health,
  settings,
  onSync,
  onRefresh,
  busy,
  message,
}: {
  health: SyncHealth;
  settings: Settings | null;
  onSync: () => void;
  onRefresh: () => void;
  busy: boolean;
  message: string | null;
}) {
  const tone = health.stale ? (health.hasInactive ? "bad" : "warn") : "good";

  return (
    <div className="card">
      <h2>
        Sync health
        <span className="hint">Akahu serves a cached balance; this shows how stale it is</span>
      </h2>

      <div className="metric-row" style={{ marginBottom: 12 }}>
        <div>
          <div className="metric-label">Last snapshot</div>
          <div className="metric small mono">{health.lastSnapshotDate ?? "–"}</div>
          <div className="muted tiny">{relativeTime(health.lastRunAt)}</div>
        </div>
        <div>
          <div className="metric-label">Days collected</div>
          <div className="metric small mono">{health.daysCollected}</div>
          <div className="muted tiny">since {health.firstSnapshotDate ?? "–"}</div>
        </div>
        <div>
          <div className="metric-label">Last run</div>
          <div className="metric small mono">{health.lastRunStatus ?? "never"}</div>
        </div>
      </div>

      <div className="stack">
        {health.accounts.map((account) => (
          <div key={account.accountId} className="callout" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>
                {account.accountName}
                {!account.inScope && (
                  <span className="badge" style={{ marginLeft: 8 }}>
                    not in goal
                  </span>
                )}
              </div>
              <div className="muted tiny">
                {account.connectionName ?? "unknown provider"}
                {account.accountType ? ` · ${account.accountType}` : ""} · balance refreshed{" "}
                {relativeTime(account.sourceRefreshedAt)}
                {account.ageHours !== null ? ` (${Math.round(account.ageHours)} h old)` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="mono">{nzd(account.valueNzd)}</div>
              <span className={`badge ${account.status === "ACTIVE" ? "good" : "bad"}`}>{account.status}</span>
            </div>
          </div>
        ))}
      </div>

      {health.stale && health.staleReason && (
        <div className={`banner ${tone}`} style={{ marginTop: 14, marginBottom: 0 }}>
          <strong>Attention</strong>
          <span>
            {health.staleReason}
            {health.hasInactive && (
              <>
                {" "}
                <a href="https://my.akahu.nz/connections" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                  Reconnect Sharesies
                </a>
              </>
            )}
          </span>
        </div>
      )}

      <div className="form-row" style={{ marginTop: 14, marginBottom: 0 }}>
        <button onClick={onSync} disabled={busy}>
          {busy ? "Working…" : "Sync now"}
        </button>
        <button
          className="ghost"
          onClick={onRefresh}
          disabled={busy || !settings?.source.akahuConfigured}
          title={
            settings?.source.akahuConfigured
              ? "Ask Akahu for a manual refresh (1 hour rest period on personal apps)"
              : "Needs Akahu tokens in .env"
          }
        >
          Ask Akahu to refresh
        </button>
      </div>

      {message && <p className="muted tiny" style={{ marginBottom: 0 }}>{message}</p>}
      <p className="disclaimer" style={{ marginBottom: 0 }}>
        Data mode: {settings?.source.effective ?? "unknown"}
        {settings?.source.effective === "manual" ? " (hand-typed value)" : ""} · staleness threshold{" "}
        {health.staleAfterHours} h
      </p>
    </div>
  );
}
