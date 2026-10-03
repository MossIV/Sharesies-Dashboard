import { useMemo, useState } from "react";
import type { Account, Contribution } from "../api.ts";
import { nzd, shortDate } from "../api.ts";

const SOURCE_LABEL: Record<string, string> = {
  manual: "manual",
  csv: "Sharesies CSV",
  bank: "bank",
};

/** Rows per page. Ten fits the card without turning it into a scroll box. */
const PAGE_SIZE = 10;

const CATEGORY_LABEL: Record<string, string> = {
  buy: "buy",
  sell: "sell",
  deposit: "deposit",
  withdrawal: "withdrawal",
  dividend: "dividend",
  fee: "fee",
  interest: "interest",
  transfer: "transfer",
};

export function ContributionLog({
  contributions,
  accounts,
  totalAllTime,
  excludedTotalAllTime,
  basis,
  basisNote,
  notCounted,
  onAdd,
  onDelete,
  defaultScope = "goal",
}: {
  contributions: Contribution[];
  accounts: Account[];
  totalAllTime: number;
  excludedTotalAllTime: number;
  /** What `totalAllTime` is counting, and why, both decided server-side. */
  basis: "external" | "trades";
  basisNote: string;
  /** Rows the goal holds that the basis leaves out: internal movements, not money in. */
  notCounted: number;
  onAdd: (body: { contributionDate: string; amountNzd: number; note?: string }) => Promise<unknown>;
  onDelete: (id: number) => Promise<unknown>;
  /** Which list opens first. "all" is for looking at what the goal leaves out. */
  defaultScope?: "goal" | "all";
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  /**
   * Which rows to list. An imported report covers every portfolio, so one import
   * can add a thousand rows that do not touch the goal; paging through those to
   * find the ones that do would be the wrong default.
   */
  const [scope, setScope] = useState<"goal" | "all">(defaultScope);

  const accountNames = useMemo(
    () => new Map(accounts.map((account) => [account.accountId, account.accountName])),
    [accounts],
  );

  const rows = useMemo(() => {
    const wanted = scope === "goal" ? contributions.filter((entry) => entry.inGoal) : contributions;
    // Newest first: the log is read from the top.
    return [...wanted].reverse();
  }, [contributions, scope]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // A delete or a scope change can leave the current page past the end.
  const current = Math.min(page, pageCount);
  const start = (current - 1) * PAGE_SIZE;
  const visible = rows.slice(start, start + PAGE_SIZE);
  const inGoalCount = contributions.filter((entry) => entry.inGoal).length;

  const go = (next: number) => setPage(Math.min(Math.max(1, next), pageCount));
  const changeScope = (next: "goal" | "all") => {
    setScope(next);
    setPage(1);
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAdd({ contributionDate: date, amountNzd: Number(amount), ...(note ? { note } : {}) });
      setAmount("");
      setNote("");
      setPage(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>
        Contribution log
        <span className="hint">
          {nzd(totalAllTime)} {basis === "external" ? "sent to Sharesies" : "in the goal"}
          {excludedTotalAllTime !== 0 ? ` · ${nzd(excludedTotalAllTime)} logged outside it` : ""}
          {notCounted !== 0 ? ` · ${notCounted} internal row(s) not counted` : ""}
        </span>
      </h2>

      {/* What the figure above is counting. Stated rather than implied, because "money
          in" means different things with and without a bank feed to read. */}
      <p className="muted tiny" style={{ marginTop: 0, marginBottom: 12 }}>{basisNote}</p>

      <div className="form-row">
        <div style={{ flex: "0 1 150px" }}>
          <label htmlFor="contrib-date">Date</label>
          <input
            id="contrib-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ flex: "0 1 130px" }}>
          <label htmlFor="contrib-amount">Amount (NZD)</label>
          <input
            id="contrib-amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="250"
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ flex: "1 1 160px" }}>
          <label htmlFor="contrib-note">Note (optional)</label>
          <input
            id="contrib-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            style={{ width: "100%" }}
          />
        </div>
        <button disabled={busy || !Number(amount)} onClick={add}>
          Add deposit
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {contributions.length === 0 ? (
        <p className="empty">Nothing logged yet.</p>
      ) : (
        <>
          <p className="muted tiny" style={{ marginTop: 12 }}>
            Show{" "}
            <button
              className="small"
              disabled={scope === "goal"}
              onClick={() => changeScope("goal")}
              title="Only the rows the goal counts"
            >
              in the goal ({inGoalCount})
            </button>{" "}
            <button
              className="small"
              disabled={scope === "all"}
              onClick={() => changeScope("all")}
              title="Every row, including other portfolios"
            >
              everything ({contributions.length})
            </button>
          </p>

          {visible.length === 0 ? (
            <p className="empty">
              Nothing is in the goal yet. {contributions.length} row(s) are logged against accounts outside it —
              switch to <strong>everything</strong> to see them, or include an account on the Accounts card.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Note</th>
                  <th>Source</th>
                  <th>Account</th>
                  <th className="num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono tiny">{shortDate(entry.contributionDate)}</td>
                    <td className="muted tiny">
                      {entry.category && (
                        <span className="badge" style={{ marginRight: 6 }}>
                          {CATEGORY_LABEL[entry.category] ?? entry.category}
                        </span>
                      )}
                      {entry.note ?? "–"}
                    </td>
                    <td className="muted tiny">{SOURCE_LABEL[entry.source] ?? entry.source}</td>
                    <td className="muted tiny">
                      {entry.accountId === null ? "unattributed" : accountNames.get(entry.accountId) ?? entry.accountId}
                      {!entry.inGoal && (
                        <span className="badge warn" style={{ marginLeft: 6 }}>
                          outside goal
                        </span>
                      )}
                      {entry.inGoal && !entry.counted && (
                        <span
                          className="badge"
                          style={{ marginLeft: 6 }}
                          title="The goal holds this account, but the row is a movement inside the platform rather than money sent in, so the contributions figure leaves it out"
                        >
                          internal
                        </span>
                      )}
                    </td>
                    <td className="num mono">
                      {nzd(entry.amountNzd)}
                      {entry.currency !== "NZD" && (
                        <div className="muted tiny">
                          {entry.currency} {entry.amountOriginal?.toFixed(2)} @ {entry.fxRate}
                        </div>
                      )}
                    </td>
                    <td className="num" style={{ width: 60 }}>
                      <button className="danger small" onClick={() => onDelete(entry.id)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {pageCount > 1 && (
            <p className="muted tiny" style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
              <button className="small" disabled={current === 1} onClick={() => go(1)} title="First page">
                «
              </button>
              <button className="small" disabled={current === 1} onClick={() => go(current - 1)} title="Previous page">
                ‹
              </button>
              <span>
                Page {current} of {pageCount}
                <span className="muted">
                  {" "}
                  · rows {start + 1}–{start + visible.length} of {rows.length}
                </span>
              </span>
              <button
                className="small"
                disabled={current === pageCount}
                onClick={() => go(current + 1)}
                title="Next page"
              >
                ›
              </button>
              <button
                className="small"
                disabled={current === pageCount}
                onClick={() => go(pageCount)}
                title="Last page"
              >
                »
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
