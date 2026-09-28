# The dashboard in one container (plan section 14.4: a container on the NAS).
#
# Two stages because the web build needs Vite and the runtime does not: the
# second stage installs only hono, @hono/node-server and nodemailer, so the image
# that runs has no build tooling in it.
#
# The server and the daily job share one container rather than two. Two
# containers would mean two processes writing the same SQLite file across a
# bind mount, and WAL locking over a NAS filesystem is not something to bet the
# history on.

# ---------------------------------------------------------------- build stage
FROM node:24-alpine AS build

WORKDIR /app

# Dependencies first: a source edit should not reinstall them.
# Both lockfiles, not just both manifests: `npm ci` refuses to run without its own
# lockfile, and `npm --prefix web ci` looks for web/package-lock.json.
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
RUN npm ci && npm --prefix web ci

COPY . .
RUN npm run web:build

# -------------------------------------------------------------- runtime stage
FROM node:24-alpine

# tini reaps the child processes and forwards SIGTERM to the entrypoint, which
# forwards it to both children. Without it the container ignores the signal and
# Docker has to kill it after a timeout, which is exactly when a half-written
# backup would be most annoying.
#
# tzdata so Pacific/Auckland is real inside the container: the scheduler does its
# own zone maths, but log timestamps and anything else reading the system clock
# should agree with it.
RUN apk add --no-cache tini tzdata

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only what runs: the source is executed directly by Node, which strips the types.
COPY src ./src
COPY scripts ./scripts
COPY --from=build /app/web/dist ./web/dist
RUN chmod +x scripts/entrypoint.sh

ENV NODE_ENV=production \
    DB_PATH=/data/sharesies.db \
    BACKUP_DIR=/backups \
    API_HOST=0.0.0.0 \
    API_PORT=8787 \
    TZ=Pacific/Auckland

# The two directories that must outlive the container: the database (the only
# copy of the history) and the backups.
RUN mkdir -p /data /backups && chown -R node:node /data /backups /app
USER node

VOLUME ["/data", "/backups"]
EXPOSE 8787

# A failing API is worth restarting; a failing collector is not, and restarting on
# it would lose the day rather than retry tomorrow. This only checks the API.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8787)+'/api/summary').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "./scripts/entrypoint.sh"]