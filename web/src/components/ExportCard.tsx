import type { DumpCounts } from "../api.ts";

/**
 * Export and backup (plan section 13).
 *
 * The wording matters here: the CSV/JSON downloads are for moving data out, while
 * the thing that actually protects the history is copying the database file, which
 * is a command rather than a button. Saying "Export" alone would imply the history
 * is safe when it is still one disk failure away from being gone.
 */
export function ExportCard({ counts, lastSnapshotDate }: { counts: DumpCounts | null; lastSnapshotDate: string | null }) {
  return (
    <div className="card">
      <h2>
        Export and backup
        <span className="hint">the history only exists on this machine</span>
      </h2>

      <p className="muted tiny">
        Akahu cannot re-serve a past balance, so every stored day is the only copy of that day. These downloads
        are for using the data elsewhere; the backup below is what protects it.
      </p>

      <div className="button-row">
        <a className="button" href="/api/export/json" download>
          Download everything (JSON)
        </a>
        <a className="button" href="/api/export/snapshots.csv" download>
          Snapshots (CSV)
        </a>
        <a className="button" href="/api/export/contributions.csv" download>
          Contributions (CSV)
        </a>
      </div>

      {counts && (
        <table>
          <tbody>
            <tr>
              <td className="muted tiny">Snapshots stored</td>
              <td className="num mono">{counts.snapshots}</td>
            </tr>
            <tr>
              <td className="muted tiny">Accounts registered</td>
              <td className="num mono">{counts.accounts}</td>
            </tr>
            <tr>
              <td className="muted tiny">Contributions logged</td>
              <td className="num mono">{counts.contributions}</td>
            </tr>
            <tr>
              <td className="muted tiny">Newest snapshot</td>
              <td className="num mono">{lastSnapshotDate ?? "–"}</td>
            </tr>
          </tbody>
        </table>
      )}

      <p className="disclaimer" style={{ marginBottom: 0 }}>
        Back up the database with <code>npm run backup</code>, which copies it with SQLite's own{" "}
        <code>VACUUM INTO</code> and verifies the copy. Run it on the same schedule as{" "}
        <code>npm run collect</code>: a backup taken while the API is running is safe, but a backup you never
        took is not.
      </p>
    </div>
  );
}
