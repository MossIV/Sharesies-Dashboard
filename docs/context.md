# Project context

A running record of what this project is, what was decided, what was built, and what
went wrong along the way. Written to be readable on its own, and deliberately free of
personal figures: no balances, no account names, no account identifiers, no tokens and
no notification topic. Where a number mattered to a decision it is described rather
than quoted.

The other documents are:

| File | What it is |
|---|---|
| `sharesies-dashboard-plan.md` | The design document: data model, collector, API, views, phases, risks. Section 14 holds the decisions taken, with the specifics. |
| `implementation-notes.md` | Where the build diverged from the plan, and what the real data and the container taught. |
| `../README.md` | How to run it, and how to deploy it. |
| This file | The story: what happened, in order, and why. |

---

## 1. What it is

A personal dashboard that tracks one Sharesies portfolio against a target, using
[Akahu](https://my.akahu.nz) as the data source. It stores a value snapshot per account
per day, compares the total of the accounts *inside the goal* against the target, and
announces milestones when they are reached.

The constraint that shapes everything: **Akahu cannot re-serve a past balance.** Every
stored day is the only copy of that day, so the database is not a cache — it is the
history. That single fact drives the backup design, the "do not backfill missed days"
rule in the scheduler, and the care taken with anything that writes.

It is a single-user, localhost-or-private-network application. There is no
authentication by design, which is why the container publishes its port on loopback and
the README says to reach it through a VPN rather than the open internet.

---

## 2. Decisions

Answered before the first real collection; the reasoning is in the plan's section 14.

| Decision | Taken |
|---|---|
| Goal scope | Sharesies accounts only, and only one of the two the connection exposes. The other is registered and snapshotted daily but excluded from the goal. |
| Target | A single amount on that one portfolio, with no target date. Standard 25/50/75/100% milestones. |
| Progress basis | Portfolio value (not net contributions). |
| Hosting | A container on a NAS, tested locally first. |
| Stack | TypeScript, no build step — Node runs it directly and `tsc` is only used for `--noEmit`. |
| Notifications | Phone push, via ntfy. |

The scope choice is worth calling out: excluding the larger account is deliberate, and it
is the reason a whole class of bug (section 6) was reachable and had to be fixed.

---

## 3. How it is put together

```
src/sources/     PortfolioSource boundary: Akahu, manual, CSV
src/collector/   the daily job: fetch, store raw, normalise, snapshot, stamp, announce
src/domain/      pure logic: goals, pace, milestones, projections   (unit-tested)
src/db/          schema + migrations, typed data access, backup
src/api/         Hono server and routes
src/notify/      one Notifier interface: console, webhook, ntfy, email
src/scheduler/   the unattended daily run, and the timezone maths behind it
src/export/      JSON and CSV dumps
web/             React + Vite + Recharts dashboard
```

Design rules that held throughout:

* **Every upstream payload is stored raw** before it is normalised, so a parser fix can
  be re-run over history that has already been collected.
* **The domain layer never sees a database handle.** All SQL lives in `src/db/repo.ts`.
* **Defensive parsing.** Akahu documents `meta` as "passed straight through from
  integrations, making it very inconsistent", so the parser probes several key spellings
  and degrades to value-only rather than failing.
* **Demo data is labelled and removable.** Rows carry `source = 'demo'`, and the reset
  removes them — including the goal the seeder creates, which it originally did not.

---

## 4. What it does

**Collection.** One pass fetches `/accounts`, stores the raw payload per account, writes
one snapshot row per account per day (idempotent on date + account), replaces holdings
when `meta.portfolio` provides them, stamps newly reached milestones, announces them,
and records a sync run with a staleness verdict.

**Goals and milestones.** One active goal (enforced, not merely implied), percentage or
custom milestones, first-reached dates that survive a later dip, and a straight-line pace
indicator when a target date exists.

**Accounts and scope.** Every account the connection exposes is registered and
snapshotted. A per-account flag decides what the goal sums. New accounts are judged
against a connection-name pattern and an account-type list, and the rule is shown in the
UI so it is not magic.

**Contributions.** A manual log, plus two ways to fill it: the official Sharesies
transaction report (idempotent, keyed by a content hash, with a preview before anything
is written) and bank-transfer detection, which proposes candidates and never writes
without an explicit confirmation. Akahu cannot see trades, so this log is what separates
deposits from growth.

**Projections.** Month-by-month arithmetic at low/base/high assumptions, labelled
throughout as assumptions rather than predictions, with a required-contribution figure.

**Alerts.** A reached milestone is announced once per channel and never again, enforced
by a `UNIQUE (milestone_id, channel)` constraint rather than in memory, so a restart
cannot duplicate it. A failed channel is recorded per channel and retried on the next
run. A test button proves a channel works without consuming a real milestone's only send.

**Export and backup.** JSON and CSV downloads for using the data elsewhere; `VACUUM INTO`
copies that are reopened and integrity-checked for protecting it. The two are named
differently on purpose — calling a download a "backup" would imply the history is safe
when it is one disk failure away.

**Unattended operation.** `npm run schedule` runs the collector and then a backup, once a
day, and stays running. It is a long-lived command rather than a cron entry because the
target is a container on a NAS, where cron needs a process manager and the NAS's own
scheduler usually cannot reach inside it.

**Container.** A two-stage image: the web build happens with Vite, and the runtime
installs only the three runtime dependencies. One container runs the API and the
scheduler as children of a small entrypoint script under `tini`.

---

## 5. Running it

```bash
npm install
cp .env.example .env        # Akahu tokens, notification channel, schedule
npm run migrate             # create the database
npm run spike               # check the Akahu connection, save a redacted fixture
npm run collect             # one collection pass
npm run api                 # http://127.0.0.1:8787
npm run schedule            # the daily job, unattended
npm test                    # the test suite
```

Every script loads `.env` itself via Node's `--env-file-if-exists`, so a missing `.env`
falls back to the manual source rather than failing. Node 24.2 or newer is required.

For the container:

```bash
docker compose up -d --build
docker compose logs -f
```

---

## 6. What went wrong

The most useful part of this document. Almost none of these were visible from a passing
test suite; most were found by running the thing against real data, or by running it in
a container.

### Found by the first real data

| Symptom | Cause | Fix |
|---|---|---|
| The dashboard measured a demo goal instead of the real one | The seeder's `--reset` deleted snapshots, contributions and its account, but not the goal it created. The leftover goal stayed active and won on `id ASC`. | Goals carry a `source`; the reset removes the one it owns. |
| A second active goal was silently ignored | Nothing enforced a single active goal, though the UI has one progress bar and no switcher. | Creating or reactivating a goal deactivates the others. |
| The header counted all registered accounts beside an in-scope total | It counted the registry, not the scope. | Counts the in-scope accounts and names the excluded ones. |
| `.env` was never read at all | No script used Node's `--env-file`; the app had been running on defaults and the manual source regardless of the file. | Every script loads it, optionally. |

### Found by the goal scope, after real data accumulated

The reported bug: the milestone timeline tracked the whole portfolio while the goal
excluded the larger account. `stampReachedMilestones` compared each snapshot row against
the milestone amount with no scope filter, so the excluded account — many times larger
than the tracked one — satisfied the lower milestones.

Two consequences, both bad: a dashboard that contradicted itself (a low single-digit
percentage next to "50% of goal reached"), and milestone alerts already delivered to a
phone for milestones that had not been reached. Those false sends had also consumed the
once-per-channel dedupe, so the *real* crossings would never have notified.

Auditing for the same mistake found two more instances of it:

* The "latest value" helper picked the newest snapshot date globally and then filtered by
  scope. An excluded account collected on a newer date than an in-scope one — a failed
  fetch for one connection, an account added later — made the goal value read as **zero**.
* The sync-health strip, whose job is to list every account *including* excluded ones,
  filtered to a single date for the same reason, so an account collected on a different
  day vanished from the one place it is meant to be visible.

All three now use the same rule as the headline number: the in-scope accounts, summed per
day. The live database was repaired — the wrong reached-dates cleared and the false
notification rows removed so the real crossing still alerts once — and verified by
running a collection through the fixed code and confirming nothing was stamped.

The lesson worth keeping: the scope is a property of *every* query that touches
snapshots, not just the headline. A test file now builds the exact shape of the real
data — a small account inside the goal, a large one outside it — so the next such query
fails loudly.

### Found by the container

| Symptom | Cause | Fix |
|---|---|---|
| The build failed at `npm ci` | The Dockerfile copied `web/package.json` but not `web/package-lock.json`, and `npm ci` refuses to run without its own lockfile. | Copy both lockfiles. |
| **The container reported Healthy while writing its database inside itself** | `env_file` overrides the image's `ENV`, so the local-run value of `DB_PATH` resolved to a path inside the container, outside the mounted volume. It collected, verified a backup and logged success the whole time. | Pin the volume paths under `environment:`, which beats `env_file`. |
| The startup banner named a different database than the server opened | The banner echoed the environment variable; the app resolves it against the repo root. | The entrypoint asks the app for the resolved path, so the two cannot disagree. |
| `docker stop` took the full grace period and was killed | The entrypoint `exec`d the API, replacing the shell and discarding its `trap`, so the scheduler never heard the signal. Even once signalled, it slept in one long timer that had to be outlived. | No `exec`: both processes are children and the shell forwards the signal. The wait is cancellable, so a stop is immediate. |

The second row is the one to remember: a banner that repeats a configuration value is not
evidence that the value is the one being used. The tell was a backup of a two-snapshot
database appearing beside backups of a two-hundred-snapshot one.

### Found by writing the tests

* A redaction routine that over-redacted six-digit fund symbols as if they were account
  numbers, and under-redacted a connection id inside a logo URL. Caught by a test that
  asserts the redaction itself.
* A test that would have written into — and pruned — the real backups directory. The rule
  was extracted into a pure function and tested there instead.
* An assumption that holdings add up to the account balance. The real data disproved it:
  part of one account is an uninvested cash balance that appears in no holding, so
  summing holdings would under-report and the assertion had to become one-directional.
* Real balances asserted as literals in a committed test — the fixture was git-ignored but
  the numbers in the test were not. Every expected value is now derived from the fixture.

### Found by reasoning about the clock

A daily 07:00 run is 23 hours after the previous one on the day daylight saving starts,
and 25 hours after on the day it ends. Adding 24 hours to an instant loses a day every
September and collects twice every April. The schedule is resolved as a wall clock in a
zone, with the offsets from a day either side of the target — the obvious two-pass guess
uses the offset at the guessed instant, which on a transition day already carries the new
value and can never find the earlier of two valid answers.

### Smaller, but silent if wrong

* A blank `DB_PATH` resolved to the repository root, so SQLite would have tried to open a
  directory as a database file. The example `.env` shipped it blank.
* `engines` claimed Node `>=24.0.0`, but `import.meta.main` arrived in 24.2. On 24.0 or
  24.1 every command would have run nothing and exited 0 — a collection reporting success
  while collecting nothing.
* Backing up an unmigrated database crashed the verification with a raw SQL error. The
  integrity check is the authoritative signal; the row count now reports "unknown".

### Found by the NAS import

| Symptom | Cause | Fix |
|---|---|---|
| Container Station: **"Invalid File Format"** on a `.tar` its own dialog says it supports | Docker Desktop's containerd image store writes an OCI archive (`oci-layout`, `index.json`, `blobs/sha256/…`), and even `buildx --output type=docker` writes `manifest.json` pointing at `blobs/`. Container Station understands only the legacy layout: `manifest.json`, a `repositories` file, and `<id>/layer.tar` per layer. The message blames the format when the file is a valid archive of the wrong shape. | Convert through a throwaway classic-store daemon (`docker:24-dind`): load the OCI archive, save it back out. The result is about three times larger, because legacy layers are stored uncompressed — expected, not a fault. |
| The compose file's `/share/<share>/…` paths may not match what Container Station displays | Its file browser presented the same folder as `/WongFiles/Ben/…`, with no `/share` prefix, while the daemon resolves host paths under `/share`. | Confirm with Container Station's volume picker instead of typing; swap the prefix if a mount error appears. |

A detail worth keeping from that first attempt: the container ran happily in the
background while its readiness loop hung on `docker info`, so it looked busy rather than
stuck. Checking the process list inside the container showed the truth in seconds.

---

## 7. How it is verified

* **A test suite** (in the hundreds) on Node's built-in runner: parsing against saved
  payloads, the pure domain logic, the collector against fixtures, the API, imports,
  notifications, export, backup, and the scheduling maths including both daylight-saving
  transitions.
* **A Phase 0 spike** (`npm run spike`) that calls Akahu once, reports what actually came
  back, and writes a redacted fixture. Redaction covers the identifiers, the
  authorisation references, the account number and the payment reference — but *not* the
  balances or holdings, so the raw capture is git-ignored: it is a financial statement,
  not a fixture. A test skips when it is absent, and a second test asserts the redaction
  itself.
* **Real collections** against live data, including deliberately after each fix.
* **The container, end to end**: healthy, serving from the mounted volume, stopping in a
  second with the full shutdown sequence in the log.

Two limits worth stating plainly: the container is verified on Docker Desktop for
Windows, not on a NAS's own Docker, where the bind mounts and filesystem locking are the
things most likely to differ; and a few figures (pace, 7/30-day change) stay honestly
blank until enough days have accumulated.

---

## 8. Where it stands

Built and running: collection, storage, the goal and milestone logic, projections,
contributions and both import paths, notifications on a phone, export and backup, the
unattended daily job, and the container. The design in the plan is implemented.

It runs from a container on a QNAP NAS (Container Station). The image is built on the
Windows machine, exported to a tar, checksum-verified after the copy, and imported; the
database and its backups are bind-mounted to folders on a NAS share, beside Container
Station's own directory rather than inside it. The existing database was copied across
rather than letting the NAS start empty, because the goal, the milestones and the account
scope live only in that file — an empty NAS would have meant recreating all of it by hand.

Publishing to a registry and pulling is documented in `deploy/qnap/README.md` as the
alternative, and deliberately not used: it would add a registry account and credentials
stored on the NAS in exchange for an easier update path that a personal app does not
need. The tar route keeps the image private and needs nothing but the file.

Known gaps, all deliberate or pending:

* The scheduler does not backfill missed days — writing today's value into past dates
  would invent the history the database exists to keep.
* Nothing about the app is authenticated, by design for a private single-user tool.
* The NAS deployment is verified on Docker Desktop for Windows, not yet on the NAS
  itself: the bind mounts and filesystem locking over a NAS share are the parts most
  likely to behave differently, and the folder ownership is the first thing to check.
* Milestone reached-dates are measured on portfolio value; a goal set to a
  contributions basis would still stamp from value. Noted rather than guessed at.

---

## 9. Privacy decisions

Worth recording because they were choices, not defaults:

* The database and its backups are git-ignored. They are the only copy of the history,
  and they are personal.
* Raw Akahu captures are git-ignored, because redaction cannot make a statement of
  balances and holdings safe to publish. The tests skip without them.
* `.env` — tokens and the notification topic — is git-ignored from the first commit. The
  notification topic is treated as a secret: anyone who knows it can read the alerts.
* The container image excludes all of the above; the tokens are passed in at run time.
* This document quotes no balances, no account names and no identifiers.