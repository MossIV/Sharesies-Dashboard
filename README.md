# Sharesies Goal Dashboard

Track a Sharesies portfolio against a total-amount goal, with configurable milestones.
Data comes from [Akahu](https://my.akahu.nz) (personal app, free). The design and the
reasoning behind it are in [`docs/sharesies-dashboard-plan.md`](docs/sharesies-dashboard-plan.md);
decisions taken during the build are recorded in
[`docs/implementation-notes.md`](docs/implementation-notes.md).

**Status:** Phase 0 through Phase 4 are built. Phases 1-3 (collector, storage, API,
dashboard, projections, contributions) plus every Phase 4 item: milestone
notifications, Sharesies CSV import, bank-transfer detection, widening the goal to
other accounts, export/backup, and a mobile-friendly layout. The one thing still
outstanding is Phase 0's real Akahu spike, which needs your tokens: everything runs
today against the manual source and the demo data.

---

## Quick start

Requires **Node 24 or newer** (Node 26 recommended). There is no build step: TypeScript
runs directly on the Node runtime, and SQLite is built into Node, so the only runtime
dependency is [Hono](https://hono.dev).

```bash
npm install
cp .env.example .env        # optional for now; needed for Akahu tokens
npm run migrate             # create data/sharesies.db
npm run seed:demo           # optional: 8 months of clearly-labelled demo history
npm run api                 # http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787>. The API serves the built UI, so no second process is
needed. For UI development with hot reload, run `npm run api` and `npm run web:dev`
(Vite on <http://127.0.0.1:5173>, proxying `/api` to the server).

Remove the demo data at any time with `npm run seed:demo:reset`. Demo rows are stored
with `source = 'demo'` and the dashboard labels them as demo data, so they cannot be
mistaken for real portfolio figures.

### Other commands

| Command | Purpose |
|---|---|
| `npm test` | 175 tests (parsing, domain, collector, API, import, notifications, export) on the built-in node:test runner |
| `npm run typecheck` | `tsc --noEmit`; the only use for the TypeScript compiler here |
| `npm run collect` | Run one collection pass, the daily job |
| `npm run migrate` | Apply any pending SQL migrations |
| `npm run backup` | Copy the database with `VACUUM INTO` and verify the copy |
| `npm run import:csv` | Import a Sharesies transaction report (`-- --file path.csv --apply`) |
| `npm run detect-transfers` | Scan the bank feed for transfers into Sharesies, without logging them |
| `npm run web:build` | Build the dashboard into `web/dist` for the API to serve |

---

## Connecting Akahu (Phase 0)

1. Create an Akahu profile at <https://my.akahu.nz> and connect Sharesies.
2. On the **Developers** page, create a personal app (free) and copy both tokens.
3. Put them in `.env`:

   ```
   AKAHU_USER_TOKEN=...    # Authorization: Bearer <this>
   AKAHU_APP_TOKEN=...     # X-Akahu-Id: <this>
   ```

4. Verify and inspect the response shape:

   ```bash
   npm run collect
   curl -s http://127.0.0.1:8787/api/holdings/latest   # does meta.portfolio have data?
   ```

5. **The Phase 0 gate.** If only a balance comes back, the dashboard is value-only:
   ignore the Allocation card, everything else still works. If `meta.portfolio` has
   holdings, the allocation donut fills in. The raw payload of every fetch is kept in
   `raw_fetches`, so a later parser change can be re-run over the history you have
   already collected.

Without tokens the app falls back to the **manual source**: enter a value in the
Settings panel (or `MANUAL_VALUE_NZD` in `.env`) and it records a snapshot, so you can
start building history immediately.

### Scheduling the daily job

Akahu refreshes connected accounts on its own daily schedule, so one collection a day
is enough. Do not poll in a loop.

* **Windows:** Task Scheduler, daily, action `node src/collector/run.ts` with *Start in*
  set to the repo root.
* **Linux / macOS:** `0 7 * * * cd /path/to/repo && node src/collector/run.ts`
  (or a systemd timer).

---

## Milestone alerts (Phase 4)

A reached milestone is announced once per channel and never again, enforced in the
database rather than in memory, so a restart cannot cause a duplicate and a failed
send is retried on the next collection. Configure it in `.env`:

```
NOTIFY_CHANNELS=console,webhook        # any of: console, webhook, ntfy, email
NOTIFY_ENABLED=true
NOTIFY_WEBHOOK_URL=https://...         # generic JSON POST
NOTIFY_NTFY_TOPIC=your-topic           # phone push via ntfy.sh (free, no account)
SMTP_HOST=smtp.example.com             # email needs these plus SMTP_USER/SMTP_PASS
```

A channel with missing settings is reported on the dashboard rather than silently
disabling itself, and the **Send a test alert** button proves a channel works
without consuming a real milestone's only send.

## Sharesies report import (Phase 4)

Download an official transaction report from Sharesies and import it:

```bash
npm run import:csv -- --file "C:/Users/you/Downloads/transaction-report.csv"           # preview
npm run import:csv -- --file "C:/Users/you/Downloads/transaction-report.csv" --apply    # write
```

The preview lists what would be logged and what would be skipped, and the importer
is idempotent: each row is keyed by a content hash, so importing the same report
twice adds nothing. Contributions are logged as `source = 'csv'` and stay separate
from the portfolio snapshots, because Akahu cannot see trades.

## Bank-transfer detection (Phase 4)

```bash
npm run detect-transfers -- --from 2026-01-01        # scan and report
npm run detect-transfers -- --from 2026-01-01 --apply # log the matches
```

Detection reads the Akahu transaction feed for transfers into the Sharesies
connection and proposes them as contributions. It never writes without `--apply`,
and the dashboard card shows both the candidates and the near-misses it rejected,
so a transfer it declined to match is visible rather than lost.

## Backup (Phase 4)

`data/sharesies.db` is the only copy of the history, because Akahu cannot re-serve a
past balance.

```bash
npm run backup                 # -> backups/sharesies-<timestamp>.db, newest 14 kept
npm run backup -- --keep 30
npm run backup -- --list
```

The copy is made with SQLite's `VACUUM INTO`, so it is safe to run while the API is
serving, and the result is opened and checked with `PRAGMA integrity_check` before
the script reports success. Schedule it with the daily collection. `backups/` is
git-ignored: a backup in the repo is not a backup.

The dashboard can also export the whole history as JSON or CSV, which is for using
the data elsewhere rather than for disaster recovery.

---

## Widening the goal (Phase 4)

A Sharesies connection usually exposes two accounts (INVESTMENT and WALLET), and
both count. Other accounts Akahu can see — a KiwiSaver provider, another broker —
are stored but excluded by default. Include one on the **Linked accounts** card and
it starts counting from that day; the scope is a per-account flag in the database,
not a code change. New accounts are judged against `AKAHU_CONNECTION_MATCH`
(default `sharesies`) and `AKAHU_ACCOUNT_TYPES` (default `INVESTMENT,WALLET`), and
the card shows that rule so it is not magic. Widening is safe to do late because
every account is snapshotted whether or not it is in scope.

---

## Mobile

The layout is single-column below 900px and phone-tuned below 640px: full-width
buttons, stacked form fields, and data tables that scroll sideways instead of
compressing. Verified with no horizontal overflow at 375px and 393px.

---

## Security

* Tokens live in `.env`, which is git-ignored from the first commit. Never commit them.
* The API binds to `127.0.0.1` by default. It holds your tokens and your financial
  data, so keep it local. To reach it from another device, put it behind Tailscale or a
  VPN rather than exposing the port; set `API_HOST` only if you have done that.
* `data/sharesies.db` is the only copy of your history, because Akahu cannot re-serve
  past values. Back it up. It is git-ignored, so the backup is yours to arrange.
* Revoke access at <https://my.akahu.nz/connections> if you stop using this.

## Not financial advice

Projections are arithmetic on assumptions you set (`V[n+1] = V[n] * (1 + r/12) + c`), with
low and high cases at ±2 percentage points. They are labelled as assumptions throughout
the UI, and they are not predictions.
