# Sharesies Goal Dashboard: Plan & Architecture (Akahu edition)

**Status:** Draft v2, September 2026
**Data source:** Akahu personal app (free). Sharesight was ruled out because it needs a paid plan.
**Goal:** Track a Sharesies portfolio against a total-amount goal, with configurable milestones.

---

## 1. What changed from v1

| v1 idea | v2 decision |
|---|---|
| Sharesight API as the data layer | **Akahu personal app** (free, official OAuth-style tokens, no scraping) |
| Unofficial Sharesies API / scraping | Dropped |
| CSV import as the primary source | CSV is now an **optional extra** for contribution history |
| Price providers (Yahoo, FX) for valuation | Dropped from the MVP. Akahu returns the balance and, where available, the portfolio breakdown |
| Trade history and cost basis | **Not available from Akahu for Sharesies** (see constraints), so the dashboard is **value-based** |

---

## 2. Akahu facts and constraints that shape the design

These come from Akahu's docs (Supported Integrations, Personal Apps, Account Model, Data Refreshes, Rate Limits). Re-check them in the spike (Phase 0) before building on them.

- **Sharesies is supported** as an "enduring access" investment platform with **account data**. Akahu lists no transaction data for it.
- **Personal app:** free, limited to **one user (you)**, ongoing connectivity only, **no webhooks**, **daily scheduled refresh**, and a **1 hour rest period between manual refreshes**.
- **Auth:** two static tokens from the Developers page at my.akahu.nz, sent as `Authorization: Bearer <user token>` and `X-Akahu-Id: <app token>` against `https://api.akahu.io/v1`. Creating a personal app requires accepting the developer terms and setting up multi-factor authentication.
- **Cached data:** the API serves a cached copy. Each account has a `refreshed` object with timestamps, so you can tell how stale the balance is.
- **Account shape:** `balance.current`, `balance.currency`, `type` (e.g. `INVESTMENT`, `WALLET`), `status` (`ACTIVE` or `INACTIVE`), and a loosely defined `meta` object. Investment platforms may expose `meta.portfolio` and `meta.breakdown`. These pass through from the provider, are inconsistent, and must be treated as optional. There is a maximum of 200 instruments per investment account.
- **`INACTIVE` status:** if Akahu loses access (revoked access, changed login, etc.), the account goes `INACTIVE`. Cached data is still served but stops updating, and you must reconnect at my.akahu.nz/connections.
- **Rate limits:** a global limit applies. On HTTP 429, retry with exponential backoff and jitter. A daily poll will not get near it.
- **SDK:** Akahu maintains an official JavaScript SDK, and there is a Postman collection. Python works fine by calling the REST API directly (two headers).

### Consequences

1. **The history starts the day you start collecting.** Akahu gives the current state, not a value time series, so store a daily snapshot from day one.
2. **No trades means no contributions, cost basis or returns from Akahu.** The dashboard tracks value against the goal. "Growth vs contributions" needs a separate contribution log (Section 6).
3. **The shape of `meta.portfolio` is unknown until you look.** Store the raw JSON of every fetch and parse it defensively.

---

## 3. Architecture

```
                 ┌────────────────────────── Your machine / home server ───────────────────────────┐
                 │                                                                                  │
 Sharesies ──▶ Akahu ──▶│ Collector (daily job)  ──▶  SQLite  ◀──  API server  ◀──  Web UI (React)     │
  (account       cached │  - GET /accounts                │          - goals / milestones CRUD         │
   data)          data  │  - optional manual refresh      │          - progress + projection calc      │
                        │  - store raw JSON + snapshot    │          - snapshot + sync-health queries  │
                        │                                 │                                            │
   Manual entry / CSV ─▶│  Contribution log  ─────────────┘                                            │
                 └──────────────────────────────────────────────────────────────────────────────────┘
```

### Design principles

- **Adapter boundary:** define a `PortfolioSource` interface. `AkahuSource` is the main implementation. `ManualSource` (type a value in) and `CsvSource` (Sharesies Transaction Report) can be added without touching the rest of the app.
- **Raw first, parse second:** always persist the raw Akahu payload, then derive normalized rows from it. If Akahu changes its response format, you can re-parse history.
- **Local-first:** SQLite file, tokens in `.env`, runs on your own machine. There is no reason to host it publicly.
- **Separation of concerns:** the collector only fetches and stores. The domain layer (goals, milestones, projections) is pure functions over snapshots, so it is easy to unit test.

### Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node) | Official Akahu SDK is JavaScript, and one language across job, API and UI |
| Storage | SQLite (`better-sqlite3`) | Single file, trivial backup, plenty for one user |
| API | Fastify or Hono | Small and typed |
| UI | React + Vite + Recharts | Fast to build the charts needed |
| Scheduling | OS cron / systemd timer / `node-cron` | One daily job |
| Alternative | Python + FastAPI + httpx | Perfectly viable, since the Akahu REST API is simple |

---

## 4. Data model

```sql
-- Every fetch, untouched. Insurance against inconsistent `meta` shapes.
raw_fetches(id, fetched_at, endpoint, account_id, payload_json)

-- Normalized daily point used by charts. One row per account per day.
snapshots(
  id, snapshot_date, account_id, account_name,
  value_nzd,               -- balance.current
  currency,
  source_refreshed_at,     -- account.refreshed.balance, shows how stale
  status,                  -- ACTIVE | INACTIVE
  UNIQUE(snapshot_date, account_id)
)

-- Only populated if meta.portfolio exposes holdings. Nullable fields on purpose.
holding_snapshots(id, snapshot_id, name, symbol, units, value, raw_json)

-- Money you put in. Needed for "contributions vs growth" and for projections.
contributions(id, contribution_date, amount_nzd, note, source)  -- source: manual | csv | bank

goals(id, name, target_amount_nzd, target_date NULL, progress_basis, created_at)
                                       -- progress_basis: 'value' (default) | 'contributions'

milestones(
  id, goal_id, label, amount_nzd,
  kind,                    -- custom | percent
  first_reached_on NULL, notes
)

settings(key, value)       -- assumed annual return, assumed monthly contribution, etc.

sync_runs(id, started_at, finished_at, status, error, accounts_seen)
```

---

## 5. Collector (daily job)

1. `GET /accounts` with both tokens. On 429, retry with exponential backoff and jitter.
2. Save the raw response to `raw_fetches`.
3. Pick out the Sharesies account(s). Match on `connection.name`, not on a hard-coded ID.
4. Insert or update the day's `snapshots` row, including `source_refreshed_at` from the `refreshed` object.
5. If `meta.portfolio` has usable holdings, write `holding_snapshots`. Otherwise skip quietly.
6. Update `first_reached_on` on any milestone the new value has reached.
7. Record a `sync_runs` row. If the account is `INACTIVE` or the data is older than about 48 hours, flag it so the UI can show a reconnect banner.

**Manual refresh:** optionally expose a "Refresh now" button that triggers Akahu's manual refresh, respecting the 1 hour rest period on personal apps. Check the Data Refreshes guide for the exact endpoint.

**Scheduling tip:** Akahu refreshes on its own daily schedule, so run the collector once a day, ideally at a consistent time, and never poll in a tight loop.

---

## 6. Contributions (because Akahu can't see your trades)

Without contributions you can chart value versus goal, but not how much of the value is growth. Options, in order of effort:

1. **Manual log (MVP):** a simple form to record deposits (date, amount).
2. **Sharesies Transaction Report CSV (optional):** import deposits from the official report under Account → Generate Reports.
3. **Bank auto-detection (stretch, verify first):** if you also connect your bank to Akahu, personal apps get enriched bank transactions by default. You may be able to spot transfers to Sharesies. This depends on how those transactions appear, so test it before designing around it.

---

## 7. Goal and milestone logic

**Goal:** target amount, optional target date, and a progress basis. The default basis is **portfolio value**. Offer **net contributions** as an alternative view.

**Milestones**
- **Custom amounts** such as "$25k: emergency buffer".
- **Auto-generated percentages** of the goal (25 / 50 / 75 / 100%).
- **States:** `reached` (with the first-reached date), `next`, and `future`.
- **Reached semantics:** record the first snapshot date at or above the amount. Keep that date even if the value later dips, and show a subtle "currently below" marker instead of un-achieving it.
- **Pace indicator:** if the goal has a target date, compare the current value with a straight-line or compound path to it (ahead, on track, or behind).

**Projection (illustrative only)**

Simulate month by month:

```
V[n+1] = V[n] * (1 + r/12) + c
```

- `r` is the assumed annual return and `c` is the assumed monthly contribution, both set by you in Settings.
- The ETA for a milestone is the first month where `V[n] >= milestone`.
- Show three scenarios (low, base, high) with `r` at plus or minus 2 percentage points.
- Also compute the **monthly contribution needed to hit the goal by the target date**.
- Label projections clearly as assumptions, not predictions or financial advice.

---

## 8. Backend API (own server)

| Endpoint | Purpose |
|---|---|
| `GET /api/summary` | Current value, goal progress %, next milestone, sync health |
| `GET /api/snapshots?from=&to=` | Series for the value-over-time chart |
| `GET /api/holdings/latest` | Allocation data (if available) |
| `GET/POST/PATCH/DELETE /api/goals`, `/api/milestones` | Goal and milestone management |
| `GET/POST /api/contributions` | Contribution log |
| `GET /api/projection?return=&monthly=` | Scenario ETAs |
| `POST /api/sync` | Trigger the collector on demand (rate-limited) |

---

## 9. Dashboard views

1. **Goal progress:** bar with milestone markers, the current value, the remaining amount, and the pace indicator.
2. **Value over time:** line chart of snapshots with horizontal milestone lines and reached-date markers.
3. **Milestone timeline:** reached, next, and projected ETAs.
4. **Projection:** low, base and high scenario lines to the goal, plus the "required monthly contribution" callout.
5. **Contributions vs growth:** stacked area (needs the contribution log).
6. **Allocation:** donut by holding (only if `meta.portfolio` provides it).
7. **Sync health strip:** last refreshed time, account status, and a reconnect prompt when `INACTIVE`.
8. **Settings:** goal, milestones, assumed return, assumed monthly contribution.

---

## 10. Suggested repo layout

```
sharesies-dashboard/
├─ src/
│  ├─ sources/          PortfolioSource.ts, AkahuSource.ts, ManualSource.ts, (CsvSource.ts)
│  ├─ collector/        run.ts, parse-akahu.ts
│  ├─ domain/           goals.ts, milestones.ts, projection.ts      (pure, unit-tested)
│  ├─ db/               schema.sql, client.ts, migrations/
│  └─ api/              server.ts, routes/
├─ web/                 React + Vite + Recharts
├─ fixtures/            saved sample Akahu responses (redacted) for tests
├─ .env.example         AKAHU_APP_TOKEN=, AKAHU_USER_TOKEN=
└─ README.md
```

---

## 11. Build phases

### Phase 0: Spike (about 1 hour)
- Create the Akahu personal app, connect Sharesies, and copy the two tokens.
- Call `GET /me`, then `GET /accounts`. Save a redacted copy of the response as a fixture.
- **Decide from what you see:** what is in `balance`, `type`, and `meta.portfolio`/`meta.breakdown`?
- **Gate:** if only a balance is available, the MVP is a value-only dashboard (still fully useful for goal and milestone tracking). If holdings are present, add the allocation view.

### Phase 1: Collector and storage
- SQLite schema, `AkahuSource`, the daily job, raw plus normalized storage, and sync logging.
- **Done when:** the job runs unattended for a week and produces one snapshot per day.

### Phase 2: Goals, milestones and the MVP dashboard
- Goal and milestone CRUD, progress bar, value-over-time chart, milestone states, sync health strip.
- **Done when:** you can set a target and milestones and see today's progress and reached dates.

### Phase 3: Projections and contributions
- Contribution log, projection engine and scenarios, required-contribution calculator, contributions-vs-growth chart.
- **Done when:** each milestone shows a projected date under three scenarios.

### Phase 4: Nice-to-haves
- Milestone-reached notifications (email or push).
- Sharesies CSV import for contributions.
- Bank-transfer auto-detection (verify feasibility first).
- Include KiwiSaver or other accounts through Akahu if you widen the goal.
- Export or backup, and a mobile-friendly layout.

---

## 12. Security and privacy

- Keep the tokens in `.env` (or an OS keyring), and never commit them. Add `.env` to `.gitignore` from the first commit.
- Personal apps have security controls. Review them in Akahu's Personal Apps Advanced guide and lock down what you can.
- Run the app on localhost or a private network (for example a VPN or Tailscale). Do not expose it publicly, because it holds your tokens and financial data.
- Check what Akahu asks for when you connect Sharesies, and read its security and privacy terms before you connect. Revoke access at my.akahu.nz/connections if you stop using it.
- Personal apps are for your own accounts only. Keep this project personal, and read the Akahu developer terms if you ever want to share it with others (that would need a full app).
- Back up the SQLite file. Because history can't be re-fetched from Akahu, it is the only copy.

---

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `meta.portfolio` is sparse or inconsistent | No holdings or allocation view | Phase 0 spike, raw JSON storage, defensive parsing, value-only fallback |
| Non-bank connections are less stable than bank ones | Missed days, stale data | Sync health strip, `INACTIVE` detection, reconnect prompt |
| History starts only when you start collecting | Short charts early on | Start collecting as early as possible. Optionally seed one manual starting snapshot |
| No trade data | No cost basis or returns | Value-based design, contribution log, optional CSV import |
| Personal app limits (daily refresh, no webhooks) | Data up to about 24 hours old | Fine for a goal tracker. Show "as of" timestamps |
| Akahu changes its API or terms | Collector breaks | Adapter boundary, fixtures and tests, fallback to `ManualSource` |
| Projections misread as advice | Wrong decisions | Clear "illustrative assumptions" labelling |

---

## 14. Open decisions — resolved

Answered on 2026-09-29, before the first real collection. The original question is
kept so the reasoning stays visible.

1. **Goal scope:** Sharesies only, or also KiwiSaver and other accounts?
   **Sharesies only.** The Akahu connection exposes two Sharesies accounts; the goal
   tracks one of them, see (2). No KiwiSaver or bank accounts are counted. The scope
   is a per-account flag, so including another account later is a click, and every
   account is snapshotted either way so the history is there to backfill.

   **Restated on 2026-10-03, when every account was connected to Akahu:** the
   Simplicity KiwiSaver account and the ANZ spending account are now visible, and
   **KiwiSaver stays out of scope by decision.** Worth stating plainly because it is
   now a choice rather than a consequence: the account is excluded by the
   connection-and-type rule, not by being invisible to the collector, so the
   exclusion is deliberate and revisitable. Its daily snapshots accumulate regardless,
   which is what makes revisiting it cheap later.
2. **Target:** amount, optional date, and the first milestones.
   **A set amount, no target date, measured on one Sharesies portfolio** (the
   Recommended Investment Portfolio). The other account is deliberately *not*
   counted, even though it is much the larger balance: the goal is about that one
   portfolio growing. The milestones are the standard 25/50/75/100% of the target,
   which puts the first one well above the tracked portfolio's current value. No
   target date was set, so the pace line and the "needed monthly" figure stay out
   of the way; the projection chart still gives dates under each assumption.
3. **Progress basis:** **value** (the default). Net contributions would need a
   deposit log, and Akahu cannot see Sharesies trades, so the contribution log
   starts empty and fills from the transaction report or bank-transfer detection.
4. **Hosting:** **a container on the NAS**, but localhost for now while it is being
   tested. This is now built: `Dockerfile` + `docker-compose.yml`, one container running
   the API and the daily job together, with `data/` and `backups/` as the only things that
   must be persisted. The port is published on loopback by default, because the app has no
   authentication and holds the tokens. Two containers was the obvious shape and was
   rejected: two processes writing one SQLite file across a bind mount is a locking risk
   not worth taking with the only copy of the history.
5. **Stack:** **TypeScript**, as recommended. Node runs it directly with no build
   step; `tsc` is only used for `--noEmit` typechecking.
6. **Notifications:** **yes, phone push.** Delivered through `ntfy.sh` on a topic
   whose name is the only secret (see `.env`). One alert per milestone per channel,
   recorded in the database so a restart cannot re-send it.

---

## 15. Reference links

- Akahu Personal Apps: https://developers.akahu.nz/docs/personal-apps
- Supported Integrations: https://developers.akahu.nz/docs/integrations
- Account Model: https://developers.akahu.nz/docs/the-account-model
- Data Refreshes: https://developers.akahu.nz/docs/data-refreshes
- Rate Limits: https://developers.akahu.nz/docs/reference-rate-limits
- Getting Started (SDK, Postman): https://developers.akahu.nz/docs
- Akahu profile and connections: https://my.akahu.nz
