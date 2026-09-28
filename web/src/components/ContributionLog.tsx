import { useState } from "react";
import type { Contribution } from "../api.ts";
import { nzd, shortDate } from "../api.ts";

const SOURCE_LABEL: Record<string, string> = {
  manual: "manual",
  csv: "Sharesies CSV",
  bank: "bank",
};

export function ContributionLog({
  contributions,
  totalAllTime,
  onAdd,
  onDelete,
}: {
  contributions: Contribution[];
  totalAllTime: number;
  onAdd: (body: { contributionDate: string; amountNzd: number; note?: string }) => Promise<unknown>;
  onDelete: (id: number) => Promise<unknown>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAdd({ contributionDate: date, amountNzd: Number(amount), ...(note ? { note } : {}) });
      setAmount("");
      setNote("");
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
        <span className="hint">{nzd(totalAllTime)} of deposits recorded</span>
      </h2>

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
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Note</th>
              <th>Source</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...contributions].reverse().map((entry) => (
              <tr key={entry.id}>
                <td className="mono tiny">{shortDate(entry.contributionDate)}</td>
                <td className="muted tiny">{entry.note ?? "–"}</td>
                <td className="muted tiny">{SOURCE_LABEL[entry.source] ?? entry.source}</td>
                <td className="num mono">{nzd(entry.amountNzd)}</td>
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
    </div>
  );
}
