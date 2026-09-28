import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/**
 * Tests must never send a milestone announcement anywhere, and the console
 * channel would otherwise print into the test reporter.
 */
process.env["NOTIFY_ENABLED"] = "false";

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

/** A migrated, empty, in-memory database. */
export function testDb(): DatabaseSync {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  return db;
}
