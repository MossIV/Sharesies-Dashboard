import { useState } from "react";
import { api, nzd, type TransferScanResult } from "../api.ts";

/**
 * Bank transfer detection (plan section 6, option 1).
 *
 * This card only ever *proposes*. A keyword match is evidence, not proof, so
 * every row is offered for confirmation with the reason it was suggested, and
 * nothing is written until the user picks rows and presses import.
 */
export function TransferCandidatesCard({ onImported }: { onImported: () => Promise<unknown> }) {
  const [scan, setScan] = useState<TransferScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState({ from: "", to: "" });
  const [outcome, setOutcome] = useState<{ imported: number; skipped: number } | null>(null);

  const runScan = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const body: { from?: string; to?: string } = {};
      if (window.from) body.from = window.from;
      if (window.to) body.to = window.to;
      const result = await api.scanTransfers(body);
      setScan(result);
      // Default to the high-confidence rows that are not already logged: those
      // are the ones a human would tick anyway.
      setSelected(
        new Set(
          result.candidates
            .filter((candidate) => !candidate.alreadyImported && candidate.confidence === "high")
            .map((candidate) => candidate.externalRef),
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setScan(null);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (ref: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };

  const confirm = async () => {
    if (!scan) return;
    const rows = scan.candidates.filter((candidate) => selected.has(candidate.externalRef));
    if (rows.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const result = await api.confirmTransfers(
        rows.map((candidate) => ({
          externalRef: candidate.externalRef,
          date: candidate.date,
          amountNzd: candidate.contributionAmount,
          description: candidate.description,
        })),
      );
      setOutcome({ imported: result.imported, skipped: result.skipped });
      await runScan();
      await onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const chosen = scan?.candidates.filter((candidate) => selected.has(candidate.externalRef)) ?? [];
  const chosenTotal = chosen.reduce((sum, candidate) => sum + candidate.contributionAmount, 0);

  return (
    <div className="card">
      <h2>
        Bank transfers
        <span className="hint">detected in the Akahu feed · nothing is logged without you</span>
      </h2>

      <p className="muted tiny">
        A top up leaves your bank account as a debit with the provider named in the description, so the feed can
        propose it. Movements inside the Sharesies connection are excluded, because a wallet-to-investment transfer
        is not new money. Everything is checked against the log, so nothing can be counted twice.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "14px 0" }}>
        <label className="muted tiny">
          From{" "}
          <input
            type="date"
            value={window.from}
            onChange={(event) => setWindow({ ...window, from: event.target.value })}
          />
        </label>
        <label className="muted tiny">
          To{" "}
          <input
            type="date"
            value={window.to}
            onChange={(event) => setWindow({ ...window, to: event.target.value })}
          />
        </label>
        <button disabled={busy} onClick={() => void runScan()}>
          {busy ? "Scanning…" : "Scan bank feed"}
        </button>
        <span className="muted tiny">defaults to the last 90 days</span>
      </div>

      {scan && (
        <>
          <p className="muted tiny">
            {scan.window.from} to {scan.window.to} · {scan.summary.examined} transaction(s) over {scan.pages} page(s)
            · looking for <code>{scan.keywords.join(", ")}</code>
          </p>

          <p style={{ marginTop: 10 }}>
            <strong>{scan.summary.new}</strong> new proposal(s), {scan.summary.alreadyImported} already in the log,
            {" "}{scan.summary.internal} internal to Sharesies, {scan.summary.unmatched} unrelated
          </p>

          {scan.candidates.length === 0 ? (
            <p className="empty">
              Nothing matched. Set <code>TRANSFER_KEYWORDS</code> to whatever your bank statement shows, or record
              your deposits by hand.
            </p>
          ) : (
            <div style={{ maxHeight: 280, overflowY: "auto", marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>Date</th>
                    <th>Description</th>
                    <th className="num">Amount</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.candidates.map((candidate) => (
                    <tr key={candidate.externalRef} style={{ opacity: candidate.alreadyImported ? 0.5 : 1 }}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(candidate.externalRef)}
                          disabled={candidate.alreadyImported}
                          onChange={() => toggle(candidate.externalRef)}
                        />
                      </td>
                      <td className="mono tiny">{candidate.date}</td>
                      <td className="tiny">
                        {candidate.description || "(no description)"}
                        <div className="muted tiny">
                          {candidate.accountName ?? "unknown account"}
                          {candidate.type ? ` · ${candidate.type}` : ""}
                          {candidate.alreadyImported && " · already logged"}
                          {candidate.confidence === "medium" && " · lower confidence"}
                        </div>
                      </td>
                      <td className="num mono">
                        {candidate.direction === "in" ? "+" : "−"}
                        {nzd(candidate.amountNzd)}
                      </td>
                      <td className="muted tiny">{candidate.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {chosen.length > 0 && (
            <div style={{ marginTop: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button disabled={busy} onClick={() => void confirm()}>
                Record {chosen.length} transfer(s) · {nzd(chosenTotal)}
              </button>
              <span className="muted tiny">
                {chosen.some((candidate) => candidate.direction === "out")
                  ? "Withdrawals are recorded as negative contributions."
                  : ""}
              </span>
            </div>
          )}

          {outcome && (
            <p className="muted tiny">
              {outcome.imported} recorded, {outcome.skipped} already present.
            </p>
          )}

          {scan.warnings.map((warning) => (
            <p className="disclaimer" key={warning}>
              {warning}
            </p>
          ))}
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
