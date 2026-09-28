import { useState } from "react";
import { api, type NotificationStatus } from "../api.ts";

/**
 * Milestone announcement status (plan section 10).
 *
 * The reason this is on the dashboard rather than only in a log: the failure mode
 * that matters is a channel that silently stopped working. A notifier you believe
 * in and that never fires is worse than no notifier.
 */
export function NotificationsCard({
  status,
  onChanged,
}: {
  status: NotificationStatus | null;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ channel: string; ok: boolean; error: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!status) return null;

  const sendTest = async () => {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const response = await api.testNotifications();
      setResults(response.results);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const failures = status.notifications.filter((entry) => entry.status === "error");

  return (
    <div className="card">
      <h2>
        Milestone alerts
        <span className="hint">sent once per channel, never twice</span>
      </h2>

      <p className="muted tiny">
        Configured channels: <code>{status.channels.join(", ") || "none"}</code>
        {!status.enabled && " · alerts are switched off (NOTIFY_ENABLED=false)"}
      </p>

      {status.problems.length > 0 && (
        <>
          {status.problems.map((problem) => (
            <p className="error" key={problem} style={{ marginBottom: 6 }}>
              {problem}
            </p>
          ))}
        </>
      )}

      <div style={{ margin: "12px 0" }}>
        <button disabled={busy} onClick={() => void sendTest()}>
          {busy ? "Sending…" : "Send a test alert"}
        </button>
        <span className="field-hint">
          a test is not recorded, so it cannot use up a real milestone's only send
        </span>
      </div>

      {results && (
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.channel}>
                <td className="mono tiny">{result.channel}</td>
                <td className="tiny">
                  {result.ok ? (
                    <span className="badge good">sent</span>
                  ) : (
                    <span className="badge bad">{result.error}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="error">{error}</p>}

      <h3 style={{ marginTop: 16, marginBottom: 6 }}>Recent alerts</h3>
      {status.notifications.length === 0 ? (
        <p className="empty">
          No milestone has been reached yet, so nothing has been announced. Alerts fire from{" "}
          <code>npm run collect</code> and from <code>POST /api/notifications/dispatch</code>.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Channel</th>
              <th>Milestone</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {status.notifications.map((entry) => (
              <tr key={entry.id}>
                <td className="tiny mono">{entry.createdAt.slice(0, 16).replace("T", " ")}</td>
                <td className="tiny mono">{entry.channel}</td>
                <td className="tiny">{entry.detail ?? "–"}</td>
                <td className="tiny">
                  <span className={entry.status === "sent" ? "badge good" : "badge bad"}>{entry.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {failures.length > 0 && (
        <p className="disclaimer">
          {failures.length} alert(s) failed and will be retried on the next collection. The failure is per
          channel: the channels that succeeded stay quiet.
        </p>
      )}
    </div>
  );
}
