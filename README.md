# Sharesies Goal Dashboard

Track a Sharesies portfolio against a total-amount goal, with configurable milestones.
Data comes from [Akahu](https://my.akahu.nz) (personal app, free). The design and the
reasoning behind it are in [`docs/sharesies-dashboard-plan.md`](docs/sharesies-dashboard-plan.md);
decisions taken during the build are recorded in
[`docs/implementation-notes.md`](docs/implementation-notes.md).

**Status:** Phases 1 and 2 are built and tested (collector, storage, API, dashboard UI).
Phase 3 (projections and contributions) is implemented too. Phase 0, the Akahu spike,
needs your tokens, and Phase 4 is not started.

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
| `npm test` | 58 tests (parsing, domain, collector, API) on the built-in node:test runner |
| `npm run typecheck` | `tsc --noEmit`; the only use for the TypeScript compiler here |
| `npm run collect` | Run one collection pass, the daily job |
| `npm run migrate` | Apply any pending SQL migrations |
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
