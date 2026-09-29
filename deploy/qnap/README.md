# Putting it on the NAS (QNAP Container Station)

The same image as everywhere else. Only three things differ on a NAS: where the
data lives, how the image gets there, and who owns the folders.

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

On this NAS, Container Station's data sits under `Y:\Ben\container-station-data`, so
create the app folders beside it:

```
Y:\Ben\sharesies\
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
# on the Windows machine, in the repo
docker build -t sharesies-dashboard:latest .
docker save sharesies-dashboard:latest -o sharesies-dashboard.tar
```

Copy `sharesies-dashboard.tar` to the NAS (the `Y:` share is reachable from here), then
either import it in Container Station (**Images → Add → Import image**) or over SSH:

```bash
docker load -i /share/<SHARE>/Ben/sharesies-dashboard.tar
```

The image carries the built web UI, so there is nothing else to transfer.

### Option B — build on the NAS

Copy the repository to the NAS and build there. Slower, and it needs internet access for
the base image and the npm registries, but it is the only option on an ARM model:

```bash
cd /share/<SHARE>/Ben/sharesies-dashboard
docker build -t sharesies-dashboard:latest .
```

---

## 3. Start it

Container Station → **Applications → Create**, paste `docker-compose.yml` from this
folder, and set the three paths marked `ADJUST`. Container Station's folder picker shows
the real `/share/...` path for any folder, which is the quickest way to get them right.

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
chown -R 1000:1000 /share/<SHARE>/Ben/sharesies/data /share/<BACKUP>/Ben/sharesies-backups
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
Next run: 07:00 on ... (Pacific/Auckland)
```

If that first line does not name a path under `/data`, stop — the database is inside the
container and a rebuild will lose it.

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