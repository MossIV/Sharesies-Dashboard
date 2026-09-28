# Implementation notes

Decisions and deviations made while building the plan in
[`sharesies-dashboard-plan.md`](sharesies-dashboard-plan.md). The plan remains the design
document; this file records where the build diverged from it and why.

## Deviations from the plan

| Plan said | Built | Why |
|---|---|---|
| `better-sqlite3` | `node:sqlite` (built into Node 24+) | No native module to compile on Windows. Identical SQL; only the `DatabaseSync` API differs, and `db.transaction()` is replaced by an explicit `tx()` helper in `src/db/client.ts`. |
| TypeScript needing a compile step | No build step | Node 26 strips types directly, so `node src/collector/run.ts` just runs. `tsc` is used only for `--noEmit` typechecking, and `erasableSyntaxOnly` in `tsconfig.json` keeps the source within what Node can strip. |
| Value in `snapshots.value_nzd` | Same column, but the currency is stored alongside it and a mixed-currency selection raises a warning | FX was dropped from the MVP, so no conversion is applied. Silently summing across currencies would be wrong. |
| Match Sharesies by `connection.name` | Same, plus an account-type filter (`AKAHU_ACCOUNT_TYPES`, default `INVESTMENT,WALLET`) | A Sharesies connection exposes both an investment account and a cash wallet. Both belong in the portfolio total; only the investment account carries `meta.portfolio`. |

## Additions not in the plan

* **`source` column on `snapshots` and `contributions`.** Lets demo rows, manual entries
  and Akahu rows coexist, and lets the UI label what it is showing.
* **`percent` column on `milestones`.** Percentage milestones store their percentage, so
  the amounts can be regenerated if the goal target changes.
* **`sync_runs.snapshots_written` and `stale`.** Makes the sync-health strip answerable
  without re-deriving it from the runs.
* **Manual source as a first-class source.** The plan lists `ManualSource` as an
  adapter; it is also the default when the tokens are absent, so the whole app is usable
  before Phase 0.
* **`POST /api/refresh`.** Wraps Akahu's `POST /refresh` and enforces the personal-app
  1 hour rest period client-side, returning `429` with `Retry-After` and an explanation
  instead of letting Akahu silently ignore the request.
* **`scripts/seed-demo.ts`.** Deterministic demo history for building the UI before the
  tokens exist. Rows are `source = 'demo'`, labelled in the UI, and removable with
  `--reset`.
* **`raw_fetches` pruning.** The table is capped at the most recent 60 rows per account
  (`pruneRawFetches`) so an insurance policy does not grow into an archive.

## Verified against Akahu's docs

Checked rather than assumed, because the plan flagged these as "re-check in Phase 0":

* `POST /v1/refresh` is the manual refresh endpoint, and personal apps have a **1 hour**
  rest period (the Data Refreshes guide says the default is 15 minutes and personal apps
  are customised to 1 hour, matching the Personal Apps table).
* Rate limiting: `429`, retry with **exponential backoff and jitter**. The documented
  example uses a 100 ms base with a 0.75–1.25 jitter factor, which is what
  `retryDelayMs` implements, plus `Retry-After` handling.
* `meta.portfolio` and `meta.breakdown` are explicitly "passed straight through from
  integrations, making them very inconsistent", and every `meta` field is optional. This
  is why the parser probes several key spellings and depth-limited container shapes
  rather than assuming one.
* `refreshed.balance` may be absent even when `refreshed.meta` is present, so the
  collector falls back to it and treats a missing timestamp as "freshness unknown"
  (flagged stale, not silently trusted).

## Known gaps

* **Phase 4 is untouched:** notifications, CSV import, bank-transfer detection, KiwiSaver
  via Akahu, export/backup tooling.
* **CSV import** (`CsvSource`) is not written. `contributions.source = 'csv'` exists and
  the API accepts it, so the import only needs a parser over the Sharesies Transaction
  Report.
* **Milestone ETAs use the current goals's assumption set**, not a per-user override per
  request beyond the query parameters `GET /api/projection` already accepts.
* **No auth on the API.** Intentional for a localhost-only personal app; revisit if it is
  ever bound to a non-loopback address.
* **`web/dist` is not committed**, so `npm run web:build` is required before the API can
  serve the UI (the API says so in plain text at `/` if it is missing).
