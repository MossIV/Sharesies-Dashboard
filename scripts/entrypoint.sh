#!/bin/sh
# Run the API in the foreground and the daily job alongside it.
#
# The API is the foreground process because it is the one whose liveness means
# something: if it dies the container should exit and be restarted. The scheduler
# is a child; if it dies, the API keeps serving and the log says so — a broken
# daily job is worth seeing rather than hiding behind a restart loop.
#
# SIGTERM stops both, so `docker compose down` does not leave a half-written
# SQLite transaction or kill the scheduler mid-backup.
set -eu

echo "Sharesies dashboard"
echo "  database: ${DB_PATH:-/data/sharesies.db}"
echo "  backups:  ${BACKUP_DIR:-/backups}"
echo "  schedule: ${SCHEDULE_HOUR_NZ:-7}:$(printf '%02d' "${SCHEDULE_MINUTE_NZ:-0}") ${SCHEDULE_TIME_ZONE:-Pacific/Auckland}"

scheduler_pid=""

shutdown() {
  echo "Stopping..."
  if [ -n "$scheduler_pid" ] && kill -0 "$scheduler_pid" 2>/dev/null; then
    kill -TERM "$scheduler_pid" 2>/dev/null || true
    wait "$scheduler_pid" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

node --env-file-if-exists=.env src/scheduler/run.ts &
scheduler_pid=$!

# If the scheduler exits unexpectedly, say so once instead of letting it vanish.
(
  sleep 5
  if ! kill -0 "$scheduler_pid" 2>/dev/null; then
    echo "WARNING: the scheduler is not running; the API will keep serving but no snapshots will be collected." >&2
  fi
) &

exec node --env-file-if-exists=.env src/api/server.ts