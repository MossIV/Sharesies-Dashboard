import { useState } from "react";
import type { AccountList } from "../api.ts";
import { nzd, relativeTime } from "../api.ts";

/**
 * Goal scope (plan section 14.1): "Sharesies only, or also KiwiSaver, bank
 * savings and other accounts?" Every account Akahu exposes is listed here, and
 * including one adds it to the goal total on the dashboard.
 *
 * Snapshots are collected for every account regardless, so including one later
 * does not leave a gap in its history.
 */
export function AccountsCard({
  accounts,
  onToggle,
}: {
  accounts: AccountList | null;
  onToggle: (accountId: string, inScope: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!accounts) return null;

  const inScope = accounts.accounts.filter((account) => account.inScope);
  const excluded = accounts.accounts.filter((account) => !account.inScope);
  const inScopeTotal = inScope.reduce((sum, account) => sum + (account.latestValue ?? 0), 0);

  const toggle = async (accountId: string, next: boolean) => {
    setBusy(accountId);
    setError(null);
    try {
      await onToggle(accountId, next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const row = (account: AccountList["accounts"][number], isInScope: boolean) => (
    <tr key={account.accountId}>
      <td>
        <div style={{ fontWeight: 600 }}>{account.accountName}</div>
        <div className="muted tiny">
          {account.connectionName ?? "unknown provider"}
          {account.accountType ? ` · ${account.accountType}` : ""}
          {account.status === "INACTIVE" && (
            <span className="badge bad" style={{ marginLeft: 6 }}>
              INACTIVE
            </span>
          )}
        </div>
      </td>
      <td className="num mono">
        {account.latestValue === null ? "–" : nzd(account.latestValue)}
        <div className="muted tiny">{relativeTime(account.latestSnapshotDate)}</div>
      </td>
      <td className="num" style={{ width: 110 }}>
        <button
          className={isInScope ? "danger small" : "small"}
          disabled={busy === account.accountId}
          onClick={() => toggle(account.accountId, !isInScope)}
        >
          {busy === account.accountId ? "…" : isInScope ? "Exclude" : "Include"}
        </button>
      </td>
    </tr>
  );

  return (
    <div className="card">
      <h2>
        Linked accounts
        <span className="hint">
          {inScope.length} of {accounts.accounts.length} counted toward the goal · {nzd(inScopeTotal)}
        </span>
      </h2>

      {accounts.accounts.length === 0 ? (
        <p className="empty">
          No accounts seen yet. Run a sync, then every account Akahu exposes appears here — including KiwiSaver or
          savings accounts you may want to add to the goal.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Last value</th>
              <th className="num">In goal</th>
            </tr>
          </thead>
          <tbody>
            {inScope.map((account) => row(account, true))}
            {excluded.map((account) => row(account, false))}
          </tbody>
        </table>
      )}

      <p className="disclaimer" style={{ marginBottom: 0 }}>
        A newly discovered account is included when its provider matches{" "}
        <code>{accounts.defaultRule.connectionMatch}</code> (case-insensitive) and its type is one of{" "}
        {accounts.defaultRule.accountTypes.join(", ") || "any"}. Values are still recorded for excluded accounts, so
        including one later backfills its history.
      </p>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
