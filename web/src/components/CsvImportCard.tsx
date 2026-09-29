import { useRef, useState } from "react";
import { api, nzd, type CsvImportResult, type ImportRecord } from "../api.ts";

/**
 * Import a Sharesies transaction report (plan section 6, option 2).
 *
 * Two things this UI has to communicate, because both surprise people:
 *
 *  1. The report is a buy/sell log, not a deposit ledger. The preview shows a
 *     count per category, so nobody assumes nine rows means nine deposits.
 *  2. Nothing is written until the apply button is pressed on the previewed
 *     rows. The first request is always a dry run.
 */
export function CsvImportCard({
  imports,
  onApplied,
}: {
  imports: ImportRecord[];
  onApplied: () => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<CsvImportResult | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>(["deposit"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ imported: number; skipped: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPreview(null);
    setCsvText(null);
    setFilename(null);
    setApplied(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const run = async (mode: "preview" | "apply", wanted: string[] = categories) => {
    if (!csvText) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.importSharesiesCsv({ csv: csvText, filename, mode, categories: wanted });
      setPreview(result);
      if (mode === "apply") {
        setApplied({ imported: result.imported, skipped: result.skipped });
        await onApplied();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File) => {
    setFilename(file.name);
    setApplied(null);
    setError(null);
    const text = await file.text();
    setCsvText(text);

    // Preview immediately with the current selection; the category checkboxes
    // re-run it so the counts always describe what a click would import.
    setBusy(true);
    try {
      setPreview(await api.importSharesiesCsv({ csv: text, filename: file.name, mode: "preview", categories }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const toggleCategory = async (category: string) => {
    const next = categories.includes(category)
      ? categories.filter((entry) => entry !== category)
      : [...categories, category];
    setCategories(next.length === 0 ? categories : next);
    if (next.length > 0 && csvText) await run("preview", next);
  };

  const detected = preview?.detected;
  const found = detected
    ? Object.entries(detected.counts).filter(([, count]) => count > 0)
    : [];

  return (
    <div className="card">
      <h2>
        Import a Sharesies report
        <span className="hint">official transaction report · CSV</span>
      </h2>

      <p className="muted tiny">
        Downloads from Sharesies → Preferences → Transaction report. Sharesies documents this export as your{" "}
        <strong>buy and sell</strong> transactions, so it may not contain your top ups at all. The preview below
        always says what it found before anything is written.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "14px 0" }}>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void pick(file);
          }}
        />
        {filename && <span className="muted tiny mono">{filename}</span>}
        {busy && <span className="muted tiny">reading…</span>}
      </div>

      {detected && (
        <>
          <table>
            <thead>
              <tr>
                <th>Detected</th>
                <th className="num">Rows</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="muted tiny">
                  {preview.transactions.length} data row(s) · delimiter <code>{detected.delimiter}</code> · dates{" "}
                  <code>{detected.dateFormat}</code>
                  {detected.dateAmbiguous && (
                    <span className="badge warn" style={{ marginLeft: 6 }}>
                      ambiguous, day/month assumed
                    </span>
                  )}
                </td>
                <td className="num mono">{preview.transactions.length}</td>
              </tr>
              {found.map(([category, count]) => (
                <tr key={category}>
                  <td>
                    {category}
                    {categories.includes(category) && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        will import
                      </span>
                    )}
                  </td>
                  <td className="num mono">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="muted tiny" style={{ marginTop: 10 }}>
            Treat another category as a contribution:
            {["deposit", "buy", "transfer", "dividend"].map((category) => (
              <button
                key={category}
                className="small"
                style={{ marginLeft: 6 }}
                disabled={busy}
                onClick={() => void toggleCategory(category)}
              >
                {categories.includes(category) ? `− ${category}` : `+ ${category}`}
              </button>
            ))}
          </p>

          {preview.accounts.length > 0 && (
            <>
              <h3 style={{ marginTop: 16, marginBottom: 4 }}>Portfolios in this report</h3>
              <table>
                <thead>
                  <tr>
                    <th>Portfolio</th>
                    <th>Account</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.accounts.map((match) => (
                    <tr key={match.portfolio}>
                      <td className="tiny mono">{match.portfolio}</td>
                      <td className="tiny">
                        {match.accountId === null ? (
                          <>
                            <span className="badge warn">no match</span>{" "}
                            <span className="muted">
                              {match.status === "ambiguous"
                                ? `could mean ${match.candidates.join(" or ")}`
                                : "no account resembles this name"}
                            </span>
                          </>
                        ) : (
                          <>
                            {match.accountName}
                            {match.status === "partial" && (
                              <span className="muted tiny"> · matched by name</span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted tiny">
                Rows are attributed to the account their portfolio names. A row for an account outside the goal is
                logged and left out of the goal's contributions.
              </p>
            </>
          )}

          {preview.currencyTotals.length > 0 && (
            <>
              <h3 style={{ marginTop: 16, marginBottom: 4 }}>Amounts selected</h3>
              <table>
                <thead>
                  <tr>
                    <th>Currency</th>
                    <th className="num">Rows</th>
                    <th className="num">In that currency</th>
                    <th className="num">In NZD</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.currencyTotals.map((total) => (
                    <tr key={total.currency}>
                      <td className="tiny mono">{total.currency}</td>
                      <td className="num mono">{total.rows}</td>
                      <td className="num mono">
                        {total.currency === "NZD" ? "–" : total.amount.toFixed(2)}
                      </td>
                      <td className="num mono">{nzd(total.nzd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {preview.currencyTotals.some((total) => total.currency !== "NZD") && (
            <p className="muted tiny">
              {preview.fx.source === "none"
                ? "Currency conversion is switched off, so no non-NZD row can be converted."
                : `Converted with ${preview.fx.source} rates for each row's own trade date` +
                  `${preview.fx.requests > 0 ? ` (${preview.fx.requests} request(s) this run)` : " (all rates cached)"}` +
                  ". The rate used is stored on every row."}
              {preview.fx.unconverted > 0 && (
                <>
                  {" "}
                  <strong>{preview.fx.unconverted} row(s) could not be converted and will be left out.</strong>
                </>
              )}
            </p>
          )}

          {(preview.outsideGoal > 0 || preview.unattributed > 0 || preview.attributedByDefault > 0) && (
            <p className="muted tiny">
              {preview.outsideGoal > 0 && (
                <>
                  <strong>{preview.outsideGoal}</strong> row(s) belong to an account outside the goal.
                </>
              )}
              {preview.unattributed > 0 && (
                <>
                  {" "}
                  <strong>{preview.unattributed}</strong> row(s) could not be attributed to an account and are held
                  out of the goal.
                </>
              )}
              {preview.attributedByDefault > 0 && (
                <>
                  {" "}
                  <strong>{preview.attributedByDefault}</strong> row(s) follow the goal's single account, because
                  this file names no portfolio.
                </>
              )}
            </p>
          )}

          <p style={{ marginTop: 12 }}>
            <strong>{preview.selected.length}</strong> row(s) selected, totalling{" "}
            <strong>{nzd(preview.selected.reduce((sum, row) => sum + (row.amountNzd ?? row.amount), 0))}</strong>
            {preview.selected.length > 0 && preview.selected[0]?.date && (
              <span className="muted tiny">
                {" "}
                from {preview.selected[0].date} to {preview.selected.at(-1)?.date}
              </span>
            )}
          </p>
        </>
      )}

      {preview && preview.selected.length > 0 && (
        <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Account</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {preview.selected.map((row) => (
                <tr key={`${row.externalRef}`}>
                  <td className="mono tiny">{row.date ?? "?"}</td>
                  <td className="tiny">{row.description}</td>
                  <td className="tiny">
                    {row.accountName ?? <span className="muted">unattributed</span>}
                    {!row.accountInScope && (
                      <span className="badge warn" style={{ marginLeft: 6 }}>
                        outside goal
                      </span>
                    )}
                  </td>
                  <td className="num mono">
                    {nzd(row.amountNzd)}
                    {row.currency !== "NZD" && (
                      <div className="muted tiny">
                        {row.currency} {row.amount.toFixed(2)} @ {row.fxRate}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview && preview.selected.length === 0 && (
        <p className="empty">
          No rows match the selected categories. Importing the same file twice is safe: rows already in the log
          are skipped, not duplicated.
        </p>
      )}

      {preview && detected && detected.unrecognisedColumns.length > 0 && (
        <p className="muted tiny">Ignored columns: {detected.unrecognisedColumns.join(", ")}</p>
      )}

      {preview && preview.warnings.map((warning) => (
        <p className="disclaimer" key={warning}>
          {warning}
        </p>
      ))}

      {preview && preview.selected.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
          <button disabled={busy} onClick={() => void run("apply")}>
            {busy ? "Importing…" : `Import ${preview.selected.length} row(s)`}
          </button>
          <button className="small" disabled={busy} onClick={reset}>
            Clear
          </button>
          {applied && (
            <span className="muted tiny">
              {applied.imported} imported, {applied.skipped} already present
            </span>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {imports.length > 0 && (
        <>
          <h3 style={{ marginTop: 18, marginBottom: 6 }}>Previous imports</h3>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>File</th>
                <th className="num">Imported</th>
                <th className="num">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((record) => (
                <tr key={record.id}>
                  <td className="tiny">{record.importedAt.slice(0, 16).replace("T", " ")}</td>
                  <td className="tiny mono">{record.filename ?? "–"}</td>
                  <td className="num mono">{record.rowsImported}</td>
                  <td className="num mono">{record.rowsSkipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
