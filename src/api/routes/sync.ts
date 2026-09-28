import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../../db/client.ts";
import { collectOnce } from "../../collector/collect.ts";
import { recentSyncRuns, listSnapshots } from "../../db/repo.ts";
import { AkahuSource } from "../../sources/AkahuSource.ts";
import { conflict, readJson } from "../validate.ts";
import { buildSyncHealth } from "../summary.ts";
import { todayNz } from "../../db/client.ts";

export const LAST_SYNC_SETTING = "last_sync_requested_at";
export const LAST_REFRESH_SETTING = "last_manual_refresh_at";

/** Minimum seconds between on-demand collections. */
export const SYNC_MIN_INTERVAL_SECONDS = Number(process.env["SYNC_MIN_INTERVAL_SECONDS"] ?? 60);

/** Akahu personal apps have a 1 hour manual refresh rest period. */
export const MANUAL_REFRESH_REST_SECONDS = Number(process.env["MANUAL_REFRESH_REST_SECONDS"] ?? 3600);

/**
 * In-process guard against overlapping collections (a rate-limited POST plus the
 * daily job could otherwise race for the same snapshot rows).
 */
let collecting = false;

export function syncRoutes(db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/sync/runs", (c) => c.json({ runs: recentSyncRuns(db, 20) }));

  app.get("/health", (c) => {
    const snapshots = listSnapshots(db);
    const health = buildSyncHealth(db, new Date(), todayNz());
    return c.json({
      status: "ok",
      snapshotCount: snapshots.length,
      sync: health,
    });
  });

  /** Trigger the collector on demand. Rate-limited, see SYNC_MIN_INTERVAL_SECONDS. */
  app.post("/sync", async (c) => {
    const now = Date.now();
    const last = getSetting(db, LAST_SYNC_SETTING);
    const lastAt = last ? Date.parse(last) : Number.NaN;

    if (Number.isFinite(lastAt)) {
      const elapsed = (now - lastAt) / 1000;
      if (elapsed < SYNC_MIN_INTERVAL_SECONDS) {
        const retryAfter = Math.ceil(SYNC_MIN_INTERVAL_SECONDS - elapsed);
        c.header("Retry-After", String(retryAfter));
        throw conflict(
          `A sync ran ${Math.round(elapsed)}s ago. Wait ${retryAfter}s, or run the daily job instead.`,
        );
      }
    }

    if (collecting) throw conflict("A collection is already running");

    collecting = true;
    setSetting(db, LAST_SYNC_SETTING, new Date(now).toISOString());
    try {
      const result = await collectOnce(db);
      return c.json({ result, summary: buildSyncHealth(db, new Date(), todayNz()) });
    } finally {
      collecting = false;
    }
  });

  /**
   * Ask Akahu to refresh account data now (POST /refresh upstream).
   * Honours the personal-app 1 hour rest period instead of hammering the API.
   */
  app.post("/refresh", async (c) => {
    if (!AkahuSource.isConfigured()) {
      throw conflict(
        "Akahu tokens are not configured, so there is nothing to refresh. " +
          "Use POST /api/manual-value instead, or set the tokens in .env.",
      );
    }

    const body = await readJson(c.req.raw).catch(() => ({}) as Record<string, unknown>);
    const now = Date.now();
    const last = getSetting(db, LAST_REFRESH_SETTING);
    const lastAt = last ? Date.parse(last) : Number.NaN;

    if (Number.isFinite(lastAt)) {
      const elapsed = (now - lastAt) / 1000;
      if (elapsed < MANUAL_REFRESH_REST_SECONDS) {
        const retryAfter = Math.ceil(MANUAL_REFRESH_REST_SECONDS - elapsed);
        c.header("Retry-After", String(retryAfter));
        return c.json({
          refreshed: false,
          reason: "rest_period",
          retryAfterSeconds: retryAfter,
          message:
            `Personal apps have a ${MANUAL_REFRESH_REST_SECONDS}s manual refresh rest period. ` +
            `Akahu would ignore the request. Try again in ${Math.round(retryAfter / 60)} minutes.`,
        }, 429);
      }
    }

    const accounts = Array.isArray(body["accounts"]) ? body["accounts"].map(String) : undefined;
    const source = new AkahuSource();
    const response = await source.requestRefresh(accounts);
    setSetting(db, LAST_REFRESH_SETTING, new Date(now).toISOString());

    return c.json({
      refreshed: true,
      upstream: response,
      note:
        "Akahu may still ignore this for individual accounts refreshed within the rest period. " +
        "Run POST /api/sync after a short wait to pick up new values.",
    }, 202);
  });

  return app;
}
