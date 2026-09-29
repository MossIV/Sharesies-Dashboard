# Putting it on the NAS (QNAP Container Station)

The same image as everywhere else. Only three things differ on a NAS: where the
data lives, how the image gets there, and who owns the folders.

**What was done for the first deployment:** the image was built on the Windows machine,
exported to a tar, checksum-verified, and copied to the NAS for Container Station to
import. Transferring a tar is the recommended route here — it needs no registry account
and nothing is published. Option C below keeps the registry workflow on record for if
you ever rebuild often enough to want it.

---

## 0. Check the NAS architecture first

A Docker image is built for one CPU architecture, so this decides how you get it
across. Over SSH, or in Container Station's system information:

```bash
uname -m
```

* **`x86_64`** — the image built on the Windows machine will run as it is. Load the
  exported tar (option A below).
* **`aarch64` or `armv7l`** — an x86 image will not run. Build it on the NAS instead
  (option B), or export an arm64 image from a machine that can build one.

Getting this wrong looks like "exec format error" the moment the container starts.

---

## 1. Create the folders, away from Container Station's own directory

Container Station manages `container-station-data/` itself — it holds `application/`,
`image/`, `lib/` and `tmp/`, and the application definitions it stores there are its
to rewrite. Keep the database and the backups outside it.

On this NAS, Container Station's data sits under a folder of the form
`Y:\<container-station-folder>\container-station-data`, so create the app folders beside
it:

```
Y:\sharesies\
├─ data\                 the database — the only copy of the history
├─ backups\              verified copies
└─ .env                  tokens and the notification topic
```

Anything that persists must be a **bind mount to a real folder on the NAS**, never a
container-local path. That distinction is the whole reason the bug in
`docs/implementation-notes.md` mattered: the container reported healthy while writing
its database inside itself, one rebuild away from starting from empty.

Put `backups` on a different share if you have one (`Z:` is mapped here too), and
ideally on a different disk or an external drive. A backup on the same disk as the
original protects against mistakes, not against a disk failure.

Copy `.env` across as well — it is git-ignored, so it will not arrive with the code.

---

## 2. Get the image onto the NAS

### Option A — build locally, then load the tar (x86 NAS)

```bash
npm run image:nas            # builds, exports the tar, verifies it, writes a sha256
```

That is the whole procedure. It ends with the archive, its checksum and a `.txt` note
beside it in `dist/nas/`, naming the image tag, the commit it was built from and the
commands for the NAS side. Copy the tar and the `.sha256`, verify the copy, load it,
recreate the application. `--out DIR` puts the files elsewhere; `--platform linux/arm64`
builds for an ARM NAS.

The rest of this section is what the script does and why each part matters, for when
something needs doing by hand.

The archive format matters more than the extension, and this is the step that failed
first. Container Station's importer accepts `*.tar, *.tar.gz, *.tgz` but only understands
the **legacy `docker save` layout**: `manifest.json`, a `repositories` file, and one
`<id>/layer.tar` (plus `json` and `VERSION`) per layer.

Docker Desktop with the containerd image store — its default since 2023 — does not write
that. `docker save` writes an OCI archive (`oci-layout`, `index.json`,
`blobs/sha256/…`), and even `docker buildx build --output type=docker` writes
`manifest.json` with `blobs/` paths. Container Station rejects both with
**"Invalid File Format"**, which is a misleading message: the file is a perfectly valid
archive, just not the shape it wants.

The script asks the daemon which store it has (`docker info --format '{{.Driver}}'`, where
`overlay2` is the classic store and anything else is not) and converts only when it has to,
through a throwaway daemon that uses the classic store:

```bash
# on the Windows machine, in the repo
docker build -t sharesies-dashboard:latest .

S="$PWD"   # or any folder; it is shared with the container below
docker run -d --privileged --name dind-convert docker:24-dind
# its entrypoint starts dockerd itself -- do not run dockerd by hand, the readiness
# loop hangs and the whole thing sits there looking busy

docker exec dind-convert docker info --format '{{.Driver}}'      # want: overlay2
docker exec dind-convert docker load -i /work/sharesies-dashboard.tar
docker exec dind-convert docker save sharesies-dashboard:latest \
  -o /work/sharesies-dashboard-legacy.tar
docker rm -f dind-convert

# check it is the legacy shape before copying it anywhere
tar -tf sharesies-dashboard-legacy.tar | grep -x repositories
tar -tf sharesies-dashboard-legacy.tar | grep -c 'layer.tar$'    # one per layer
```

The legacy archive is much larger — layers are stored uncompressed, so roughly 185 MB
against 64 MB for the OCI one. That is expected, not a fault.

Copy it to the NAS, then import it in Container Station (**Images → Add → Import image**,
called *Load image* in some builds) or over SSH:

```bash
docker load -i /share/<SHARE>/sharesies/sharesies-dashboard.tar
```

The image carries the built web UI, so there is nothing else to transfer — just `.env`.

Check the copy arrived intact before loading it, since a truncated tar fails in a
confusing way:

```bash
sha256sum /share/<SHARE>/sharesies/sharesies-dashboard.tar
```

The alternative to all of this, if the conversion is tedious: turn off **Settings →
General → Use containerd for pulling and storing images** in Docker Desktop, restart it,
rebuild, and `docker save` writes the legacy format directly. The script reads the same
setting and skips the conversion when it is off. It is a global setting for every project
on the machine, which is why the throwaway daemon is the default.

### Option B — build on the NAS

Copy the repository to the NAS and build there. Slower, and it needs internet access for
the base image and the npm registries, but it is the only option on an ARM model:

```bash
cd /share/<SHARE>/sharesies-dashboard
docker build -t sharesies-dashboard:latest .
```

### Option C — publish to a registry and pull (the lighter update path)

Updating becomes "push, then recreate the application" instead of copying a 60–200 MB file
by hand, and a rollback becomes an edit to one line of the compose file rather than a
re-import. It was not used for the first deployment because it adds a registry account and
stored credentials for no gain on a personal app that changes occasionally — but if the
app changes more than a couple of times, it is less work per update, not more.

**Docker Hub is the simplest of the registries here**, because Container Station treats it
as the default. On the free Personal plan (as read on Docker's usage page, September 2026):
unlimited public repositories, **one** private repository, and pulls limited to 200 per six
hours when authenticated. One image, pulled once per update, is nowhere near that.

1. Create the repository at <https://hub.docker.com/repository/create> — public or private.
   Creating it first works for both; a private repository cannot be created by a push.
   Docker Hub repository names are lowercase, so `mossiv/sharesies-dashboard`.

2. Log in on this machine. This is yours to do: the script never sees the password.

   ```bash
   docker login
   ```

3. Build, tag and push:

   ```bash
   npm run image:push -- docker.io/<user>/sharesies-dashboard
   ```

   It builds the image, tags it with the git short sha **and** `latest`, pushes both, and
   prints the `image:` line to paste into the compose file.

4. Point the compose file at the registry. A bare `sharesies-dashboard:latest` is satisfied
   by an imported tar, never by a pull:

   ```yaml
   image: docker.io/<user>/sharesies-dashboard:<sha>
   ```

   **Pin the sha tag, not `latest`.** Container Station decides what to pull when the
   application is created, and a tag that already exists locally is not re-fetched — so
   `latest` tends to keep running the old image unless you also prune it. Pinning the sha
   makes each update explicit, and a rollback is editing this one line back.

5. Private repository only: add the Docker Hub credentials in Container Station →
   **Preferences → Registry**. A public repository needs no credentials on the NAS at all,
   and nothing secret is published either way — the image carries no `.env`, no database
   and no tokens, which arrive at run time from the compose file.

**If you would rather not have a registry account**, GHCR is the alternative: private
packages are free and unlimited there (Docker Hub's free plan allows one private repo), and
the credentials are a GitHub token with `read:packages`. Otherwise it is the same three
commands with `ghcr.io/<user>/sharesies-dashboard`.

By hand, the registry route is the same four commands:

```bash
# on the Windows machine, in the repo
docker login                                  # do this yourself; tokens are not shared
docker tag sharesies-dashboard:latest <user>/sharesies-dashboard:0.1.0
docker tag sharesies-dashboard:latest <user>/sharesies-dashboard:latest
docker push <user>/sharesies-dashboard:0.1.0
docker push <user>/sharesies-dashboard:latest
```

Container Station pulls on start, when the application is created or recreated. One more
thing to decide:

* **Private or public.** The image holds no secrets — no `.env`, no database, no raw
  captures, and the tokens are passed in at run time — so a public repository does not
  leak your data. It does make the repository and its history public, which is the only
  real cost. A private repository (the free tier allows one) needs the registry
  credentials added under Container Station → **Preferences → Registry**.
* **Tagging.** Pushing both a version tag and `latest` lets you pin the compose file to
  the version and roll back by editing one line, instead of pulling whatever `latest`
  happens to be. Whatever you pin to, a pull only takes effect when the application is
  recreated.

### Option D — let CI build and push it (the least work per update)

The workflow in `.github/workflows/publish-image.yml` builds the image on GitHub and pushes
it to Docker Hub, so nothing is built, copied or tagged on this machine. Updating becomes:
push the code, wait for the run, recreate the application on the NAS.

Set it up once:

1. Create an access token at <https://hub.docker.com/settings/security> with **Read &
   write** permission. Not the account password: a token can be revoked on its own, and it
   is the only credential this stores.
2. Under **Settings → Secrets and variables → Actions**, add the two settings — note the
   two different tabs:
   * **Variables** tab: `DOCKERHUB_USERNAME` = your Docker Hub account name. It is not
     sensitive, and a value held as a secret is masked in the logs, including this
     workflow's own summary.
   * **Secrets** tab: `DOCKERHUB_TOKEN` = the token from step 1.
3. Push to `main`. The run's summary names the tag it published.

Each run tests first (typecheck and the suite on Node 24), so an image is only published
from a commit that passes. It builds `linux/amd64` — the NAS's architecture — with
provenance and SBOM attestations switched off, because those turn the push into a manifest
list with extra manifests beside the image and Container Station's Docker is not guaranteed
to understand that.

It tags every run with the git short sha and moves `latest` only on `main`, so a run from a
branch cannot become what the NAS pulls next. The NAS side is exactly Option C above: pin
the sha tag in the compose file and recreate the application.

If the secrets are missing the run fails at a step that says which two to add, before it
tries to log in.

---

## 3. Start it

Container Station → **Applications → Create**, paste `docker-compose.example.yml` from
this folder, and set the three paths marked `ADJUST`. (On the NAS it is normally saved
as `docker-compose.yml` — the working name is git-ignored in the repository, which keeps
a real share name and real host paths out of it.)

**On those paths.** They are the *host* paths the Docker daemon resolves, which on QNAP
are `/share/<share>/…`. Container Station's own file browser may show the same folder
without that prefix — its image importer presented the app folder as `/…/sharesies/…`
with the share name first and no `/share`. If the application fails to start with a mount
error, or starts but cannot find the database, that prefix is the first thing to swap. The
reliable way to avoid guessing is to add the two volumes through Container Station's own
volume picker rather than typing the paths, then compare what it writes.

The two that matter most:

| Setting | Value | Why |
|---|---|---|
| `DB_PATH` / the `/data` mount | the `data` folder you created | the history lives here |
| `BACKUP_DIR` / the `/backups` mount | the `backups` folder | and these must be outside the container |

---

## 4. The permissions trap

The image runs as `node`, uid 1000. QNAP folders are usually owned by `admin`, uid 0,
and if uid 1000 cannot write the database the container fails at startup with
`unable to open database file`.

```bash
chown -R 1000:1000 /share/<SHARE>/sharesies/data /share/<BACKUP>/sharesies-backups
```

Or, if you would rather not change ownership on the NAS, uncomment `user: "0:0"` in the
compose file and the container runs as root.

---

## 5. Check it, then leave it alone

```bash
docker compose ps                       # (healthy)
docker compose logs --tail 20           # banner, next run time, requests
docker exec sharesies-dashboard ls -la /data
```

Expected in the log:

```
Sharesies dashboard
  database: /data/sharesies.db
  backups:  /backups
  schedule: 7:00 Pacific/Auckland
  settings: from the environment (no .env file inside the container)
Next run: 07:00 on ... (Pacific/Auckland)
```

**Check both of the first two lines, not just the database one.** Each names a path that
must be under a mounted volume:

* A `database:` path that is not under `/data` means the history is inside the container,
  one rebuild away from starting empty.
* A `backups:` path that is not `/backups` means the copies are inside the container too —
  they exist, they are invisible from the share, and recreating the container deletes them.
  This is the failure mode that is easiest to miss, because a backup that reports success
  has done everything it promised; it just went somewhere doomed.

An image built after this check warns when it can tell a path is not on a mounted
filesystem, which is the fastest way to spot either case:

```
  WARNING: the backups path is on the container's own filesystem, not a mounted volume:
           /app/backups
```

**On an older image, give a hand-run backup its directory.** `node scripts/backup.ts`
used to ignore `BACKUP_DIR` and fall back to the repository's own `backups/` directory,
which inside the container is `/app/backups` — so a `docker exec … node scripts/backup.ts`
reported success and left the copy somewhere a rebuild discards, while the scheduled job
(the one at 07:00) wrote to the right place. Fix the compose file, then either recreate
from a newer image or pass the directory explicitly:

```bash
docker exec sharesies-dashboard node scripts/backup.ts --dir /backups
```

Three commands answer what is really going on:

```bash
docker exec sharesies-dashboard printenv | grep -E "DB_PATH|BACKUP_DIR"   # what it was given
docker inspect sharesies-dashboard --format '{{json .Mounts}}'            # what is mounted
docker exec sharesies-dashboard node scripts/backup.ts --list --dir /backups   # what is on the share
```

To rescue copies out of a container before recreating it:

```bash
docker cp sharesies-dashboard:/app/backups /share/<SHARE>/sharesies/rescued-backups
```

`settings: from the environment` is the expected line: the tokens reach the container as
environment variables from compose's `env_file`, so there is no `.env` file inside it. An
image built before that line existed prints `.env not found. Continuing without it.`
twice instead — the same thing, worded as if something were wrong. Either way, check
`dataMode` in `GET /api/summary`: `akahu` means the tokens arrived, `manual` means they
did not.

Nothing else needs scheduling on the NAS. The daily collection and the backup run inside
this container at `SCHEDULE_HOUR_NZ`, and the scheduler resolves that time against New
Zealand's clock changes rather than a fixed interval.

Two more things worth doing on the NAS itself, outside the container:

* **Include the `data` and `backups` folders in the NAS's own backup** (HBS3 or whatever
  you already run), to a different device. The container's backups protect against a bad
  collection; they do not protect against losing the NAS.
* **Snapshot the share** if the NAS supports it, which gets you point-in-time recovery
  for accidental deletion.

---

## Security

The app has no authentication by design: it is a single-user tool holding your Akahu
tokens and your balances. Publish the port on the LAN, or behind the NAS's reverse proxy
or a VPN — not on the internet. The shipped compose file maps `8081:8787` for LAN
access; change it to `127.0.0.1:8081:8787` if you would rather reach it only through a
proxy or tunnel.