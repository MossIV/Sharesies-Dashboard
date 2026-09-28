/**
 * Reading settings out of the environment.
 *
 * Small, but both of these are cases where a blank value in `.env` would have
 * produced a working-looking app doing the wrong thing: `DB_PATH=` (which the
 * example file ships) resolved to the repository root, and an empty backup
 * directory resolved to the current working directory. Neither throws where the
 * mistake is made; both bite later, in a file that is the only copy of the
 * history.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_DB_PATH, REPO_ROOT, resolveDbPath } from "../src/db/client.ts";
import { DEFAULT_BACKUP_DIR, backupDatabase, listBackups, resolveBackupDir } from "../src/db/backup.ts";
import { openDb } from "../src/db/client.ts";
import { testDb } from "./helpers.ts";

process.env["QUIET"] = "1";

describe("the database path", () => {
  test("defaults when nothing is set", () => {
    delete process.env["DB_PATH"];
    assert.equal(resolveDbPath(), resolve(REPO_ROOT, DEFAULT_DB_PATH));
  });

  test("treats a blank value as unset rather than as the repo root", () => {
    process.env["DB_PATH"] = "";
    assert.equal(resolveDbPath(), resolve(REPO_ROOT, DEFAULT_DB_PATH));

    process.env["DB_PATH"] = "   ";
    assert.equal(resolveDbPath(), resolve(REPO_ROOT, DEFAULT_DB_PATH));
  });

  test("resolves a relative path against the repo root, not the cwd", () => {
    process.env["DB_PATH"] = "data/other.db";
    assert.equal(resolveDbPath(), join(REPO_ROOT, "data", "other.db"));

    delete process.env["DB_PATH"];
    assert.equal(resolveDbPath("data/other.db"), join(REPO_ROOT, "data", "other.db"));
  });

  test("keeps an absolute path as it is", () => {
    const absolute = process.platform === "win32" ? "C:/tmp/sharesies.db" : "/tmp/sharesies.db";
    process.env["DB_PATH"] = absolute;
    assert.equal(resolveDbPath(), absolute);
    assert.ok(isAbsolute(resolveDbPath()));

    delete process.env["DB_PATH"];
  });

  test("an explicit argument wins over the environment", () => {
    process.env["DB_PATH"] = "data/from-env.db";
    assert.equal(resolveDbPath("data/from-argument.db"), join(REPO_ROOT, "data", "from-argument.db"));
    delete process.env["DB_PATH"];
  });
});

describe("the backup directory", () => {
  test("defaults to the repo's backups directory", () => {
    assert.equal(DEFAULT_BACKUP_DIR, join(REPO_ROOT, "backups"));
  });

  test("a blank value does not scatter backups into the working directory", () => {
    // Not exercised by running a backup: that would write into — and prune — the
    // real backups directory. The rule is a pure function, so test the rule.
    assert.equal(resolveBackupDir(), DEFAULT_BACKUP_DIR);
    assert.equal(resolveBackupDir(""), DEFAULT_BACKUP_DIR);
    assert.equal(resolveBackupDir("   "), DEFAULT_BACKUP_DIR);
    assert.equal(resolveBackupDir(undefined), DEFAULT_BACKUP_DIR);
  });

  test("resolves a relative directory and trims a stray space", () => {
    assert.equal(resolveBackupDir("backups-elsewhere"), resolve(REPO_ROOT, "backups-elsewhere"));
    assert.equal(resolveBackupDir(" backups-elsewhere "), resolve(REPO_ROOT, "backups-elsewhere"));
  });

  test("a real copy lands in the directory it was given", () => {
    const dir = mkdtempSync(join(tmpdir(), "sharesies-dir-"));
    const db = testDb();
    const result = backupDatabase(db, { dir, keep: 1 });

    assert.ok(result.path.startsWith(dir), result.path);
    assert.equal(result.integrity, "ok");
    assert.equal(listBackups(dir).length, 1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a copy of a database with no schema still verifies, with the count unknown", () => {
    // A fresh file that has not been migrated: the integrity check is what
    // matters, and the count is reported as unknown rather than crashing the
    // verification with a raw SQL error.
    const dir = mkdtempSync(join(tmpdir(), "sharesies-empty-"));
    const db = openDb({ path: ":memory:" });
    const result = backupDatabase(db, { dir, keep: 1 });

    assert.equal(result.integrity, "ok");
    assert.equal(result.snapshots, -1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});