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

## Phase 4 decisions

| Plan said | Built | Why |
|---|---|---|
| Notifications by email or push | Four channels behind one `Notifier` interface: `console`, `webhook`, `ntfy`, `email` | The plan lists two channels; the interface costs nothing extra and console is what makes the feature testable without an account anywhere. ntfy is free and needs no signup, so phone push works on day one. |
| "Nice-to-have" milestones | Dedupe enforced by a `UNIQUE (milestone_id, channel)` constraint, not in memory | A re-sent "you hit $25k" is the failure people actually notice. A restart, a retry, or two collectors running would all duplicate with an in-memory guard. |
| Bank-transfer auto-detection (verify feasibility first) | Detection proposes, never writes; `--apply` and an explicit button are required | Feasibility check first: Akahu's transactions feed does carry the credits into the Sharesies connection, but matching on a description string will eventually match something wrong. A wrong contribution silently corrupts the contributions-vs-growth chart, so the cost of a confirmation click is worth it. Rejected near-misses are shown too, so a transfer it declined to match is visible rather than silently absent. |
| Export or backup | Both, and they are different things | Copying the database with `VACUUM INTO` is the backup; the JSON/CSV exports are for using the data elsewhere. Calling a download link a "backup" would imply the history is safe when it is still one disk failure away. |
| Mobile-friendly layout | Single column below 900px, phone rules below 640px | Checked at 375px and 393px for horizontal overflow. Data tables scroll sideways rather than compressing, because a six-column table squeezed into 340px is not a layout, it is a smear. |

## Found by the first real run

Switch to live Akahu data on 2026-09-29, and the difference between demo data and a
real connection showed up in four places. Each is fixed and pinned by a test.

| Symptom | Cause | Fix |
|---|---|---|
| The dashboard measured a demo goal instead of the real one | `seed:demo:reset` deleted snapshots, contributions and its account, but not the goal it created. The leftover goal stayed active, and `getActiveGoal` ordered by `id ASC`, so the older row won | `goals.source` (migration 003), the reset deletes `source = 'demo'`, and `getActiveGoal` orders newest-first |
| A second active goal was silently ignored | The schema allowed many rows with `is_active = 1` and nothing enforced one; "active" reads as single-valued because the UI has one progress bar and no goal switcher | `createGoal` and `updateGoal` deactivate the others |
| The header said "across 2 accounts" while only one was in the goal | It counted every registered account, not the in-scope ones, next to an in-scope total | Counts the in-scope accounts and names the excluded ones |
| The test alert said "$0.00" and today's date was a day off | `buildMessage` was called with `new Date().toISOString()`, which is UTC, while every other date in the app is Pacific/Auckland | Uses `todayNz()` |

Two further notes from the same session:

* **The `.env` file was never loaded.** Nothing read it — Node's `--env-file` was
  not in any script — so the app had been falling back to defaults and the manual
  source all along. Now every script runs with `--env-file-if-exists=.env`, which
  also means a missing `.env` is not an error.
* **`extractItems` did not know about `item`.** Akahu's single-resource responses
  (`GET /me`) use the singular key, so `/me` parsed as an empty list. Added as the
  last fallback, after the plural keys.

## Learned from the real Akahu response

`GET /me` for a personal app returns `{ success, item: { _id, access_granted_at } }`:
no name, no email. Anything user-facing must come from `/accounts`.

The real `/accounts` payload matched the documented shape closely, which the
hand-written fixtures had already modelled — but the spike caught three things
worth recording:

* Holding `symbol` values are sometimes six-digit Sharesies fund codes rather than
  tickers (`450002`).
* `meta.breakdown.returns` sits right next to the value without being it, so
  treating `returns` as a balance would have been a plausible and very wrong guess.
* **`meta.portfolio` does not always add up to the balance.** One account's
  holdings accounted for about five sixths of its `balance.current`, so the rest is
  an uninvested cash balance sitting inside the investment account. Two
  consequences: the allocation donut describes the invested portion only, and the
  account value must always come from `balance.current` rather than from summing
  holdings, which would under-report. The account the goal tracks happens to be
  fully invested, so its donut explains it exactly; the test asserts the
  one-directional rule (holdings never exceed the balance) rather than equality.

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

## The unattended job, and what the container changed

The plan's Phase 1 says "done when the job runs unattended for a week", and the
hosting decision is a container on a NAS. Both were built last, and both pushed
back on code that had only ever been run by hand.

| Decision | Why |
|---|---|
| A long-running `npm run schedule` rather than cron | The target is a container on a NAS: cron inside one needs a process manager, and the NAS's scheduler usually cannot reach inside it. One command works the same on Windows, in the container, and on the NAS host. |
| The run time is a wall clock in a zone, not an interval | New Zealand shifts its clocks twice a year, so 07:00 is 23 hours after the previous run on the last Sunday in September and 25 hours after on the first Sunday in April. Adding 24 hours to an instant misses a day every September and double-collects every April. |
| Two offset candidates, from a day either side of the target | The obvious two-pass guess uses the offset at the guessed instant, which on a transition day already carries the *new* offset — so it can never find the earlier of two valid answers. Ambiguous times resolve to the first occurrence, matching `Temporal`'s "compatible" behaviour; skipped times resolve to the instant after the jump. |
| No backfill of missed days | Writing today's value into seven past dates would invent history, and honest history is the only reason this database exists. |
| A failed collection is reported, not fatal | Akahu being briefly unavailable should cost one day, not the scheduler. The backup still runs, because a failed fetch is exactly when yesterday's data matters most. |
| One container, two processes | Two containers writing the same SQLite file across a bind mount is a locking risk. The API runs in the foreground so the container's liveness means something; `tini` forwards signals so a stop request reaches both. |
| The image is two stages | The web build needs Vite; the runtime needs three packages. The runtime stage installs only those. |
| The volume paths are pinned in `docker-compose.yml`, not left to `.env` | `env_file` overrides the image's `ENV`, so `DB_PATH=data/sharesies.db` — which is right for a local run — pointed the container at `/app/data/sharesies.db`, inside the container and outside the volume. `environment` wins over `env_file`, so the paths hold whatever `.env` says. |

### What only the container could have found

Four things were wrong in ways that running the app locally never shows. The first
build and the first stop found them:

| Symptom | Cause | Fix |
|---|---|---|
| The build failed at `npm ci` | The Dockerfile copied `web/package.json` but not `web/package-lock.json`, and `npm ci` refuses to run without its own lockfile | Copy both lockfiles |
| The container ran, collected and backed up happily — into a database inside itself | `env_file` overrides image `ENV`: `.env`'s `DB_PATH=data/sharesies.db` resolved to `/app/data/sharesies.db`, so the mounted volume held the real history while the container wrote a fresh, empty one beside it | Pin `DB_PATH` and `BACKUP_DIR` under `environment:` in the compose file, where they beat `env_file` |
| The startup banner said `data/sharesies.db` while the server opened `/app/data/sharesies.db` | The banner echoed the environment variable; the app resolves it against the repo root | The entrypoint asks the app for the resolved path, so the banner cannot disagree with the server |
| `docker stop` took the full 30 second grace period and was killed | The entrypoint `exec`d the API, which replaced the shell and discarded its `trap` — the scheduler never got the signal. Then, even once signalled, the scheduler slept in one 60 second `setTimeout`, so a stop had to outlast the sleep | No `exec`: both processes are children and the shell forwards the signal. The wait is now cancellable, so a stop is immediate; the grace period is only there for an in-flight backup |

That third row is the one worth dwelling on: the container reported `Healthy`, the
logs showed a successful collection and a verified backup, and every number it
printed was consistent — while the history it was building was in the wrong place
and would have vanished with the container. A banner that repeats a configuration
value is not evidence that the value is the one being used.

Three smaller things this work turned up, each of which had a silent failure mode:

* **A blank `DB_PATH` resolved to the repository root.** `resolve(REPO_ROOT, "")` is
  `REPO_ROOT`, so SQLite would have tried to open a directory as a database file. The
  example `.env` ships `DB_PATH=` with nothing after it, so this was one `cp` away for
  anyone. A blank value now means "not set", for `DB_PATH` and `BACKUP_DIR` alike, and
  the same helper is exported so the rule can be tested without touching a real backup
  directory.
* **`engines` said Node `>=24.0.0`, but `import.meta.main` arrived in 24.2.** On 24.0 or
  24.1 every entry point would have run nothing and exited 0 — `npm run collect`
  reporting success while collecting nothing. The requirement is corrected and a check
  in `client.ts` (imported by every entry point) fails loudly instead.
* **Backing up an unmigrated database crashed the verification** with a raw
  `no such table: snapshots`. The integrity check is the authoritative signal; the row
  count is a convenience, so it now reports `-1` rather than failing a readable copy.

## Known gaps

* **One snapshot of history so far.** Pace, and the 7/30-day change figures, need a few
  days of data before they say anything; until then they are honestly blank.
* **The scheduler does not backfill missed days.** Deliberate: writing today's value into
  past dates would invent history.
* **The container is verified on Docker Desktop for Windows**, not yet on the NAS's own
  Docker. The things most likely to differ there are the bind mounts (a NAS share rather
  than a local directory) and filesystem locking over that share.
* **Milestone ETAs use the current goal's assumption set**, not a per-user override per
  request beyond the query parameters `GET /api/projection` already accepts.
* **No auth on the API.** Intentional for a localhost-only personal app; the container
  publishes the port on loopback for the same reason.
* **`web/dist` is not committed**, so `npm run web:build` is required before the API can
  serve the UI (the API says so in plain text at `/` if it is missing; the image builds it).
