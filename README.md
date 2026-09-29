# Sharesies Goal Dashboard

Track a Sharesies portfolio against a total-amount goal, with configurable milestones.
Data comes from [Akahu](https://my.akahu.nz) (personal app, free). The design and the
reasoning behind it are in [`docs/sharesies-dashboard-plan.md`](docs/sharesies-dashboard-plan.md);
decisions taken during the build are recorded in
[`docs/implementation-notes.md`](docs/implementation-notes.md).

**Status:** built, running on live Akahu data, and containerised. Phase 0 is done —
the spike confirmed the connection returns holdings, not just a balance, so the
allocation view has real data. Phases 1-4 are complete, including every Phase 4
item: notifications, Sharesies CSV import, bank-transfer detection, widening the
goal to other accounts, export/backup, and a mobile-friendly layout. The daily job
runs unattended (`npm run schedule`, or the container) and the container is
verified end to end. The design decisions behind the current setup are recorded in
[`docs/sharesies-dashboard-plan.md`](docs/sharesies-dashboard-plan.md) section 14.

---

## Quick start

Requires **Node 24.2 or newer** (Node 26 recommended) — 24.2 is where `import.meta.main`
landed, and every command here is an `import.meta.main` entry point that would otherwise
silently do nothing. There is no build step: TypeScript runs directly on the Node runtime,
and SQLite is built into Node, so the only runtime dependency is [Hono](https://hono.dev).

```bash
npm install
cp .env.example .env        # put your Akahu tokens here
npm run migrate             # create data/sharesies.db
npm run spike               # optional: check the Akahu connection and save a fixture
npm run collect             # one collection pass, the daily job
npm run api                 # http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787>. The API serves the built UI, so no second process is
needed. For UI development with hot reload, run `npm run api` and `npm run web:dev`
(Vite on <http://127.0.0.1:5173>, proxying `/api` to the server).

Every script loads `.env` itself (Node's `--env-file-if-exists`), so no shell
setup is needed and a missing `.env` falls back to the manual source rather than
failing. `npm run seed:demo` fills the database with clearly-labelled demo history
if you want to see the UI populated without tokens; `npm run seed:demo:reset`
removes it, including the demo goal it creates. Demo rows are stored with
`source = 'demo'` and labelled in the dashboard, so they cannot be mistaken for
real portfolio figures.

### Other commands

| Command | Purpose |
|---|---|
| `npm test` | 229 tests (parsing, domain, collector, API, import, notifications, export, scheduling) on the built-in node:test runner |
| `npm run typecheck` | `tsc --noEmit`; the only use for the TypeScript compiler here |
| `npm run spike` | Call Akahu once, report what came back, save a redacted fixture |
| `npm run collect` | Run one collection pass, the daily job |
| `npm run schedule` | Collect and back up daily, unattended (the NAS job) |
| `npm run migrate` | Apply any pending SQL migrations |
| `npm run backup` | Copy the database with `VACUUM INTO` and verify the copy |
| `npm run import:csv` | Import a Sharesies transaction report (`-- --file path.csv --apply`) |
| `npm run detect-transfers` | Scan the bank feed for transfers into Sharesies, without logging them |
| `npm run web:build` | Build the dashboard into `web/dist` for the API to serve |

---

## Connecting Akahu (Phase 0 — done)

1. Create an Akahu profile at <https://my.akahu.nz> and connect Sharesies.
2. On the **Developers** page, create a personal app (free) and copy both tokens.
3. Put them in `.env`:

   ```
   AKAHU_USER_TOKEN=...    # the Authorization header value
   AKAHU_APP_TOKEN=...     # the X-Akahu-Id header value
   ```

4. Check the connection and inspect the response shape:

   ```bash
   npm run spike
   npm run collect
   curl -s http://127.0.0.1:8787/api/holdings/latest   # does meta.portfolio have data?
   ```

**The gate, as it came out:** `meta.portfolio` carries holdings, so the allocation
donut is populated. Had it returned only a balance, the dashboard would be
value-only and everything else would still work. The raw payload of every fetch is
kept in `raw_fetches`, so a later parser change can be re-run over the history you
have already collected.

`npm run spike` is read-only and redacts the account id, the `_authorisation` and
`_credentials` references, the account number and the payment reference before
writing `fixtures/akahu-accounts.spike-<date>.json`. It does **not** redact the
balances or the holdings: those files are git-ignored on purpose, because a
financial statement is not a fixture. See the note in `.gitignore`.

Without tokens the app falls back to the **manual source**: enter a value in the
Settings panel (or `MANUAL_VALUE_NZD` in `.env`) and it records a snapshot, so you
can start building history immediately.

### Scheduling the daily job

Akahu refreshes connected accounts on its own daily schedule, so one collection a day
is enough. Do not poll in a loop.

```bash
npm run schedule                  # collect + back up daily at 07:00 NZ, and stay running
npm run schedule -- --hour 6      # a different time
npm run schedule -- --once        # one pass now, for a smoke test
```

The scheduler is a long-running command rather than a cron entry because the target
is a container on a NAS, where cron needs a process manager and the NAS's own
scheduler usually cannot reach inside the container. It runs in the same container
as the API; see below.

Two things it does deliberately:

* **The run is 23 or 25 hours after the previous one twice a year.** New Zealand
  changes its clocks on the last Sunday in September and the first Sunday in April,
  and a daily 07:00 run lands on 07:00 local on both days. Adding 24 hours to an
  instant misses a day once a year and collects twice on another.
* **It does not backfill.** If the machine was off for a week, that week has no
  snapshots. Writing today's value into seven past dates would be inventing history.

If you would rather use the system's own scheduler:

* **Windows:** Task Scheduler, daily, action `npm run collect` with *Start in* set to
  the repo root. `npm run backup` likewise, or run `npm run schedule` and let it live
  in a console window.
* **Linux / macOS:** `0 7 * * * cd /path/to/repo && npm run collect` (or a systemd
  timer), plus a backup entry.

Either way the API is a separate process: `npm run api`.

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

### Phone push, set up

1. Install the **ntfy** app ([ntfy.sh](https://ntfy.sh), iOS/Android, no account).
2. Subscribe to the topic set in `NOTIFY_NTFY_TOPIC`.
3. Press **Send a test alert** on the dashboard and confirm the phone buzzes.

The topic name is the only secret: anyone who knows it can read the notifications,
which is why it is a long random string rather than something guessable. It is in
`.env`, which is git-ignored. Set `NOTIFY_NTFY_TOKEN` if you later switch to a
reserved topic on a self-hosted server.

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

## Hosting it (localhost now, a NAS container)

Running locally is the default and nothing needs changing for it.

For the NAS there is a `Dockerfile` and a `docker-compose.yml`; on a QNAP, follow
[`deploy/qnap/`](deploy/qnap/README.md) instead, which gives the paths to use, how to get
the image across (a tar by default; a registry is documented as an option), the
folder-ownership trap, and what the startup log must say.

Wherever it runs, the local equivalent is:

```bash
cp .env.example .env          # tokens, ntfy topic, schedule
docker compose up -d --build
docker compose logs -f
```

The image builds the UI in a first stage and copies only `web/dist` into the
runtime, which installs the three runtime dependencies and nothing else. One
container runs both processes: the API and the scheduler as children of a small
entrypoint script, under `tini`, so a stop request reaches both and the scheduler
finishes an in-flight backup before exiting.

Three things to get right:

* **Persist `./data` and `./backups`.** The database is the only copy of the
  history, so a container-local path dies with the container. The compose file
  pins `DB_PATH=/data/sharesies.db` and `BACKUP_DIR=/backups` under
  `environment:` on purpose: `env_file` overrides the image's own defaults, so
  leaving it to `.env` (where `DB_PATH=data/sharesies.db` is right for a local
  run) would put the database at `/app/data` — inside the container, outside the
  volume. Point the mounts at a NAS share, and include that share in whatever the
  NAS already backs up; a backup on the same disk as the original is not a backup.
* **The port is published on loopback only.** The API has no authentication by
  design — it is a single-user app holding your tokens and balances — so reach it
  through the NAS's own proxy or a VPN such as Tailscale, or change the left side
  of the port mapping deliberately.
* **`API_HOST` is `0.0.0.0` inside the container** (it has to be, for the port
  mapping to work) and `127.0.0.1` outside it. Nothing else assumes a host.

Two containers would have been the obvious shape and was rejected: two processes
writing the same SQLite file across a bind mount is a locking risk not worth taking
with the only copy of the history.

To check it is healthy:

```bash
docker compose ps                      # should say (healthy)
docker compose logs --tail 20          # banner, next run time, requests
docker exec sharesies-dashboard ls -la /data   # the database, on the volume
```

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
* **Watch out for `git clean -xdf`.** `data/` and `backups/` are ignored on purpose, and
  `-x` deletes ignored files too — one command would take the history with it. If you
  want them out of reach of git entirely, move `DB_PATH` and `BACKUP_DIR` outside the
  repository, or point the container's mounts at a NAS share.
* Revoke access at <https://my.akahu.nz/connections> if you stop using this.

## Not financial advice

Projections are arithmetic on assumptions you set (`V[n+1] = V[n] * (1 + r/12) + c`), with
low and high cases at ±2 percentage points. They are labelled as assumptions throughout
the UI, and they are not predictions.
