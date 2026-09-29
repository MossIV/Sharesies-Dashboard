#!/bin/sh
# Run the API and the daily job together, and stop both on request.
#
# The API is not `exec`d, deliberately. `exec` would replace this shell and take
# the signal trap with it: Docker would signal the API, the scheduler would never
# hear about it, and the container would be killed once the grace period ran out —
# which is exactly when a half-written backup would hurt. Both run as children
# instead, this shell stays alive to forward the signal, and it exits with the
# API's status so the container's liveness still means what it says.
#
# The scheduler finishes what it is doing before exiting: its own handler sets a
# flag and the current pass (a collection, a VACUUM INTO) completes first. The
# grace period in the compose file is what gives it room to.
set -eu

echo "Sharesies dashboard"
# Resolve the database path the same way the app does, so the banner cannot say
# one thing while the server uses another. (It said "data/sharesies.db" while the
# server opened /app/data/sharesies.db, which hid a database outside the volume.)
resolved_db=$(node --input-type=module -e "import { resolveDbPath } from './src/db/client.ts'; console.log(resolveDbPath());" 2>/dev/null || echo "${DB_PATH:-unresolved}")
echo "  database: ${resolved_db}"
echo "  backups:  ${BACKUP_DIR:-/backups}"
echo "  schedule: ${SCHEDULE_HOUR_NZ:-7}:$(printf '%02d' "${SCHEDULE_MINUTE_NZ:-0}") ${SCHEDULE_TIME_ZONE:-Pacific/Auckland}"

# Only pass --env-file when there is one to read. In a container there usually is
# not: compose's `env_file` injects the variables into the environment, so the file
# never exists inside the image, and the flag printed ".env not found. Continuing
# without it." twice — which reads like a warning about missing tokens when nothing
# is actually wrong.
env_flag=""
if [ -f .env ]; then
  env_flag="--env-file=.env"
else
  echo "  settings: from the environment (no .env file inside the container)"
fi

# shellcheck disable=SC2086  # the flag is intentionally word-split, empty or one word
node $env_flag src/scheduler/run.ts &
scheduler_pid=$!

# shellcheck disable=SC2086
node $env_flag src/api/server.ts &
api_pid=$!

stopping=0

shutdown() {
  if [ "$stopping" = "1" ]; then
    return
  fi
  stopping=1
  echo "Stopping (signal received)."
  kill -TERM "$scheduler_pid" 2>/dev/null || true
  kill -TERM "$api_pid" 2>/dev/null || true
}

trap shutdown TERM INT

# A scheduler that dies should be visible, not silent: the API keeps serving, and
# the log says what stopped working.
(
  sleep 5
  if ! kill -0 "$scheduler_pid" 2>/dev/null; then
    echo "WARNING: the scheduler is not running; the API will keep serving but no snapshots will be collected." >&2
  fi
) &

# The API is the process whose liveness matters, so its exit ends the container.
status=0
wait "$api_pid" || status=$?

if [ "$stopping" = "0" ]; then
  echo "The API exited on its own; stopping the scheduler too."
  kill -TERM "$scheduler_pid" 2>/dev/null || true
fi

wait "$scheduler_pid" 2>/dev/null || true
echo "Stopped."
exit "$status"