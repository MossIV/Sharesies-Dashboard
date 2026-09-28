/**
 * API server (plan section 8).
 *
 * Binds to 127.0.0.1 by default: this process holds your Akahu tokens, so the
 * plan's rule is "localhost or a private network, never public" (section 12).
 * Put it behind Tailscale or a VPN if you want to reach it from a phone.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb, resolveDbPath } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { HttpError } from "./validate.ts";
import { summaryRoutes } from "./routes/summary.ts";
import { snapshotRoutes } from "./routes/snapshots.ts";
import { accountRoutes } from "./routes/accounts.ts";
import { goalRoutes } from "./routes/goals.ts";
import { contributionRoutes } from "./routes/contributions.ts";
import { projectionRoutes } from "./routes/projection.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { syncRoutes } from "./routes/sync.ts";

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";

export function createApp(db: DatabaseSync): Hono {
  const app = new Hono();

  // The Vite dev server runs on a different origin, so it needs CORS. The
  // server is localhost-only, which is what keeps a permissive origin safe.
  app.use("/api/*", cors({ origin: (origin) => origin ?? "*", credentials: false }));

  if (process.env["QUIET"] !== "1") {
    app.use("*", async (c, next) => {
      const started = Date.now();
      await next();
      const line = `${c.req.method} ${new URL(c.req.url).pathname} -> ${c.res.status} (${Date.now() - started}ms)`;
      if (c.res.status >= 500) console.error(line);
      else console.log(line);
    });
  }

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message, details: error.details }, error.status as 400);
    }
    console.error("Unhandled API error:", error);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.route("/api", summaryRoutes(db));
  app.route("/api", snapshotRoutes(db));
  app.route("/api", accountRoutes(db));
  app.route("/api", goalRoutes(db));
  app.route("/api", contributionRoutes(db));
  app.route("/api", projectionRoutes(db));
  app.route("/api", settingsRoutes(db));
  app.route("/api", syncRoutes(db));

  app.all("/api/*", (c) => c.json({ error: `No such endpoint: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));

  // The built dashboard, when it exists. Built output only; the dev UI is served
  // by Vite. Checked before registering so the middleware does not warn on every
  // request when there is no build.
  const webDist = resolve(import.meta.dirname, "..", "..", "web", "dist");
  if (existsSync(join(webDist, "index.html"))) {
    app.use("*", serveStatic({ root: webDist }));
    app.get("*", serveStatic({ root: webDist, path: "index.html" }));
  } else {
    app.get("/", (c) => c.text("Sharesies dashboard API. The web UI is not built yet: run `npm run web:build`."));
  }

  return app;
}

function main(): void {
  const db = openDb();
  migrate(db);

  const port = Number(process.env["API_PORT"] ?? DEFAULT_PORT);
  const hostname = process.env["API_HOST"] ?? DEFAULT_HOST;

  const app = createApp(db);
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`Sharesies dashboard API on http://${hostname}:${info.port}`);
    console.log(`Database: ${resolveDbPath()}`);
  });
}

if (import.meta.main) main();
