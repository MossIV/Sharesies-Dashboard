import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb, tx } from "./client.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

interface Migration {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = /^(\d+)[-_](.+)\.sql$/.exec(file);
      if (!match) throw new Error(`Bad migration filename: ${file} (expected NNN_name.sql)`);
      return {
        version: Number(match[1]),
        name: match[2]!,
        sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
      };
    })
    .sort((a, b) => a.version - b.version);
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * Apply every migration newer than PRAGMA user_version, each in its own
 * transaction, and record the version. Idempotent.
 */
export function migrate(db: DatabaseSync): { applied: number[]; version: number } {
  const applied: number[] = [];
  for (const migration of loadMigrations()) {
    if (migration.version <= currentVersion(db)) continue;
    tx(db, () => {
      db.exec(migration.sql);
      // PRAGMA does not accept bound parameters; the value is an integer derived
      // from the filename pattern, so it cannot carry injection.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push(migration.version);
  }
  return { applied, version: currentVersion(db) };
}

if (import.meta.main) {
  const db = openDb();
  const { applied } = migrate(db);
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  console.log(
    applied.length > 0
      ? `Applied migrations: ${applied.join(", ")} (schema version ${row.user_version})`
      : `Up to date (schema version ${row.user_version})`,
  );
  db.close();
}
