/**
 * The startup banner's storage block.
 *
 * Two failures are being pinned here, both of which have happened for real:
 *
 *   1. The banner reported a path the app was not using. It echoed
 *      `${BACKUP_DIR:-/backups}`, so a container with no BACKUP_DIR printed
 *      "backups: /backups" while the app wrote to /app/backups, inside the
 *      container, where a rebuild destroys it.
 *   2. A path can be correct and still be the wrong place. The check below tells
 *      the two apart: a mounted volume is a different filesystem from `/`, and the
 *      container's own writable layer is not.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeStorage, isSeparateFilesystem, type DeviceOf } from "../src/db/paths.ts";
import { DEFAULT_BACKUP_DIR, resolveBackupDir } from "../src/db/backup.ts";
import { DEFAULT_DB_PATH, REPO_ROOT, resolveDbPath } from "../src/db/client.ts";
import { resolve } from "node:path";

/** A device lookup that reports what a container looks like: everything on one
 *  device except the paths that are actually mounted. */
const devices = (table: Record<string, number>): DeviceOf => (path) => table[path] ?? null;

describe("the backup directory rule", () => {
  test("BACKUP_DIR is honoured, which is what the hand-run command ignored", () => {
    // The failure this pins: the scheduler read BACKUP_DIR while scripts/backup.ts
    // used the repo default, so a manual backup went to /app/backups inside the
    // container and was invisible from the share.
    process.env["BACKUP_DIR"] = "backups-from-env";
    assert.equal(resolveBackupDir(), resolve(REPO_ROOT, "backups-from-env"));

    // A blank value still means "not set", exactly as for DB_PATH.
    process.env["BACKUP_DIR"] = "  ";
    assert.equal(resolveBackupDir(), DEFAULT_BACKUP_DIR);

    delete process.env["BACKUP_DIR"];
  });

  test("an explicit argument beats the environment, as it does for DB_PATH", () => {
    process.env["BACKUP_DIR"] = "/from-env";
    assert.equal(resolveBackupDir("backups-argument"), resolve(REPO_ROOT, "backups-argument"));
    delete process.env["BACKUP_DIR"];
  });
});

describe("isSeparateFilesystem", () => {
  test("a mounted path is on a different device from the root", () => {
    const deviceOf = devices({ "/": 10, "/data/sharesies.db": 27, "/backups": 31 });
    assert.equal(isSeparateFilesystem("/data/sharesies.db", deviceOf), true);
    assert.equal(isSeparateFilesystem("/backups", deviceOf), true);
  });

  test("a path inside the container's own filesystem is on the same device", () => {
    // /app/backups is where the app wrote when BACKUP_DIR was unset: the same
    // device as /, so a recreate takes it with it.
    const deviceOf = devices({ "/": 10, "/app/backups": 10, "/app/data/sharesies.db": 10 });
    assert.equal(isSeparateFilesystem("/app/backups", deviceOf), false);
    assert.equal(isSeparateFilesystem("/app/data/sharesies.db", deviceOf), false);
  });

  test("unknown is reported as unknown rather than guessed", () => {
    assert.equal(isSeparateFilesystem("/nowhere", devices({ "/": 10 })), null);
    assert.equal(isSeparateFilesystem("/data", devices({ "/data/sharesies.db": 27 })), null);
    assert.equal(isSeparateFilesystem("/data", () => null), null);
  });
});

describe("describeStorage", () => {
  test("reports the paths the app resolved, not the environment variables", () => {
    const lines = describeStorage({
      dbPath: "/data/sharesies.db",
      backupDir: "/backups",
      deviceOf: devices({ "/": 10, "/data/sharesies.db": 27, "/backups": 31 }),
    });

    assert.deepEqual(lines, ["  database: /data/sharesies.db", "  backups:  /backups"]);
  });

  test("warns when the backup directory is inside the container", () => {
    const lines = describeStorage({
      dbPath: "/data/sharesies.db",
      backupDir: "/app/backups",
      deviceOf: devices({ "/": 10, "/data/sharesies.db": 27, "/app/backups": 10 }),
    });

    assert.ok(
      lines.some((line) => line.includes("WARNING: the backups path is on the container's own filesystem")),
      lines.join("\n"),
    );
    assert.ok(lines.some((line) => line.includes("/app/backups")), lines.join("\n"));
    assert.ok(
      lines.some((line) => line.includes("lost when the container is recreated")),
      lines.join("\n"),
    );
    // The database is fine, so it must not be warned about.
    assert.ok(!lines.some((line) => line.includes("the database path is on")), lines.join("\n"));
  });

  test("warns about the database path too, which is the same failure", () => {
    const lines = describeStorage({
      dbPath: "/app/data/sharesies.db",
      backupDir: "/backups",
      deviceOf: devices({ "/": 10, "/app/data/sharesies.db": 10, "/backups": 31 }),
    });

    assert.ok(
      lines.some((line) => line.includes("WARNING: the database path is on the container's own filesystem")),
      lines.join("\n"),
    );
    assert.ok(!lines.some((line) => line.includes("the backups path is on")), lines.join("\n"));
  });

  test("stays quiet when it cannot tell, which is every non-Linux run", () => {
    const lines = describeStorage({ dbPath: "/x/sharesies.db", backupDir: "/y", deviceOf: () => null });
    assert.equal(lines.length, 2);
  });

  test("with nothing overridden it reports the resolved defaults", () => {
    const lines = describeStorage({ deviceOf: () => null });
    assert.equal(lines[0], `  database: ${resolveDbPath()}`);
    assert.equal(lines[1], `  backups:  ${resolveBackupDir()}`);
    assert.equal(resolveBackupDir(), DEFAULT_BACKUP_DIR);
    assert.equal(resolveDbPath(), resolve(REPO_ROOT, DEFAULT_DB_PATH));
  });
});
