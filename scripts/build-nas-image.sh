#!/usr/bin/env bash
#
# Build the dashboard image into something the NAS can take.
#
#   npm run image:nas                                build + export a tar for Container Station
#   npm run image:nas -- --out E:/                   put the tar somewhere else
#   npm run image:nas -- --platform linux/arm64      for an ARM NAS
#   npm run image:push -- --registry ghcr.io/<you>/sharesies-dashboard
#                                                    build, tag and push instead of exporting
#
# Why a script and not the four commands in deploy/qnap/README.md: two of those
# steps fail in ways that only show up on the NAS, and both look like something
# else when they do.
#
#   1. `docker save` on a Docker Desktop using the containerd image store writes an
#      OCI archive (oci-layout, index.json, blobs/). Container Station understands
#      only the legacy layout (manifest.json, repositories, <id>/layer.tar) and
#      answers "Invalid File Format", which reads like a corrupt download. This
#      script asks the daemon which store it has and converts through a throwaway
#      classic-store daemon only when it has to.
#   2. A tar that is the wrong shape, or truncated in transit, fails on import with
#      that same message. So the layout is verified here, before the script claims
#      success, and a sha256 is written to compare after the copy.
#
# Nothing here needs the repository's secrets: the image carries no .env, no
# database and no tokens. Those arrive at run time from the compose file.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

IMAGE_NAME="sharesies-dashboard"
OUT_DIR="dist/nas"
PLATFORM=""
REGISTRY=""
TAG=""
CONVERT="auto"
DIND_IMAGE="docker:24-dind"
DIND_NAME="sharesies-image-convert-$$"

log()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# The docker CLI is a native program: it cannot resolve an MSYS path like
# /d/github/... or /tmp/..., and answers with "GetFileAttributesEx ... The system
# cannot find the file specified". Every path handed to docker goes through here.
# `cygpath -m` gives C:/github/... which both docker and the shell handle, and it
# avoids the backslash escaping a -w path would need.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

usage() {
  cat <<'EOF'
Build the dashboard image into something the NAS can take.

  npm run image:nas                                 build + export a tar for Container Station
  npm run image:nas -- --out E:/                    put the tar somewhere else
  npm run image:nas -- --platform linux/arm64       for an ARM NAS
  npm run image:push -- --registry ghcr.io/<you>/sharesies-dashboard
                                                    build, tag and push instead of exporting

Options
  --out DIR            where the tar and its checksum go (default: dist/nas)
  --tag TAG            image tag (default: the git short sha, plus :latest)
  --registry IMAGE     push instead of exporting: tags IMAGE:<sha> and IMAGE:latest
  --platform PLATFORM  build for another architecture (e.g. linux/arm64)
  --force-convert      always route the export through the classic-store daemon
  --no-convert         never convert: export with docker save directly
  -h, --help           this text
EOF
}

# Every option that takes a value needs one: `--registry` with nothing after it
# would otherwise fall through to exporting a tar, which is silent and wrong.
need_value() {
  [[ -n "${2:-}" ]] || die "$1 needs a value (try --help)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)           need_value --out "${2:-}";          OUT_DIR="$2"; shift 2 ;;
    --tag)           need_value --tag "${2:-}";          TAG="$2"; shift 2 ;;
    --registry)      need_value --registry "${2:-}";     REGISTRY="$2"; shift 2 ;;
    --platform)      need_value --platform "${2:-}";     PLATFORM="$2"; shift 2 ;;
    --force-convert) CONVERT="always"; shift ;;
    --no-convert)    CONVERT="never"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "unknown argument: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- preconditions

command -v docker >/dev/null 2>&1 || die "docker is not on PATH."
docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 \
  || die "the docker daemon is not reachable. Start Docker Desktop and try again."
[[ -f Dockerfile && -f .dockerignore ]] || die "run this from the repository (no Dockerfile here)."
if [[ -n "$REGISTRY" && ! "$REGISTRY" =~ ^[^/]+(:[0-9]+)?(/[^:]+)+$ ]]; then
  die "--registry wants a repository, not a tag: --registry ghcr.io/<user>/<name>"
fi

# ------------------------------------------------------------------------- identity

SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DIRTY=""
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  DIRTY="-dirty"
  log "NOTE: the working tree is dirty, so this image cannot be rebuilt from a commit."
  log "      It is tagged ${SHORT_SHA}${DIRTY} to say so."
fi

[[ -n "$TAG" ]] || TAG="${IMAGE_NAME}:${SHORT_SHA}${DIRTY}"
LATEST="${IMAGE_NAME}:latest"

step "Building ${TAG}"
log "  repo       ${REPO_ROOT}"
log "  also tagged ${LATEST}   (what docker-compose.example.yml expects)"
if [[ -n "$PLATFORM" ]]; then
  log "  platform   ${PLATFORM}"
fi

BUILD_ARGS=(build --tag "$TAG" --tag "$LATEST" --file Dockerfile)
if [[ -n "$PLATFORM" ]]; then
  BUILD_ARGS+=(--platform "$PLATFORM")
fi
docker "${BUILD_ARGS[@]}" .

SIZE="$(docker image inspect --format '{{.Size}}' "$TAG")"
log "  image built: $((SIZE / 1024 / 1024)) MB"

# ------------------------------------------------------------------ registry route

if [[ -n "$REGISTRY" ]]; then
  step "Pushing to ${REGISTRY}"
  docker tag "$TAG" "${REGISTRY}:${SHORT_SHA}${DIRTY}"
  docker tag "$TAG" "${REGISTRY}:latest"
  docker push "${REGISTRY}:${SHORT_SHA}${DIRTY}"
  docker push "${REGISTRY}:latest"

  log ""
  log "Pushed ${REGISTRY}:${SHORT_SHA}${DIRTY} and :latest."
  log ""
  log "On the NAS, the compose file's image line has to name the registry -- a bare"
  log "'${IMAGE_NAME}:latest' is satisfied by an imported tar, never by a pull:"
  log ""
  log "    image: ${REGISTRY}:${SHORT_SHA}${DIRTY}"
  log ""
  log "Then recreate the application. Pinning the sha tag rather than :latest is what"
  log "makes a rollback an edit to one line instead of a re-pull and a guess."
  exit 0
fi

# ---------------------------------------------------------------------- exporting

mkdir -p "$OUT_DIR"
# Kept as the MSYS path for the shell's own tools (tar, sha256sum) and converted
# per call for docker, which needs the native form.
OUT_DIR_POSIX="$(cd "$OUT_DIR" && pwd)"
TAR="${OUT_DIR_POSIX}/${IMAGE_NAME}-${SHORT_SHA}${DIRTY}.tar"
TAR_NATIVE="$(winpath "$TAR")"
# The intermediate archive stays beside the output rather than in a temp directory:
# one path scheme, and it is on the same filesystem for the final move.
RAW="${OUT_DIR_POSIX}/.${IMAGE_NAME}.oci.tar"
RAW_NATIVE="$(winpath "$RAW")"

# Which store does this daemon have? The containerd store (Docker Desktop's default
# since 2023) makes `docker save` write an OCI archive, which Container Station
# refuses. Classic stores (overlay2) already write the legacy shape.
DRIVER="$(docker info --format '{{.Driver}}')"
NEEDS_CONVERT="no"
if [[ "$DRIVER" != "overlay2" ]]; then NEEDS_CONVERT="yes"; fi
if [[ "$CONVERT" == "always" ]]; then NEEDS_CONVERT="yes"; fi
if [[ "$CONVERT" == "never" ]]; then NEEDS_CONVERT="no"; fi

step "Exporting to ${TAR}"
log "  this daemon's storage driver: ${DRIVER}"

cleanup_dind() {
  docker rm -f "$DIND_NAME" >/dev/null 2>&1 || true
}
trap cleanup_dind EXIT

if [[ "$NEEDS_CONVERT" == "yes" ]]; then
  log "  ${DRIVER} is not the classic store, so docker save here would write an OCI"
  log "  archive. Routing the export through a throwaway ${DIND_IMAGE} daemon, whose"
  log "  store is overlay2 and writes the layout Container Station accepts."

  docker save "$TAG" "$LATEST" -o "$RAW_NATIVE"

  docker run -d --privileged --name "$DIND_NAME" "$DIND_IMAGE" >/dev/null

  # Its entrypoint starts dockerd itself. Do not start it by hand: a manual
  # readiness loop hangs and the container sits there looking busy.
  ready="no"
  for _ in $(seq 1 45); do
    if docker exec "$DIND_NAME" docker info >/dev/null 2>&1; then ready="yes"; break; fi
    sleep 2
  done
  [[ "$ready" == "yes" ]] || die "the ${DIND_IMAGE} daemon never became ready."

  dind_driver="$(docker exec "$DIND_NAME" docker info --format '{{.Driver}}')"
  [[ "$dind_driver" == "overlay2" ]] \
    || die "the conversion daemon reports driver ${dind_driver}, not overlay2; its save would not be the legacy layout either."

  # docker cp rather than a bind mount: -v "C:/x:/work" is split on the colon and
  # read as three fields, which is a silent source of "invalid volume" on Windows.
  # The price is that nothing creates /work any more -- the mount used to -- and
  # docker cp will not create a destination directory, only the file inside it.
  docker exec "$DIND_NAME" mkdir -p /work
  docker cp "$RAW_NATIVE" "${DIND_NAME}:/work/in.tar"
  docker exec "$DIND_NAME" docker load -i /work/in.tar
  docker exec "$DIND_NAME" docker save -o /work/out.tar "$TAG" "$LATEST"
  docker cp "${DIND_NAME}:/work/out.tar" "$TAR_NATIVE"
  rm -f "$RAW"

  cleanup_dind
  trap - EXIT
  log "  converted (legacy layers are stored uncompressed, so this is larger than"
  log "  the OCI archive: expected, not a fault)"
else
  docker save "$TAG" "$LATEST" -o "$TAR_NATIVE"
  log "  saved directly: this daemon already writes the legacy layout"
fi

# ----------------------------------------------------------------- verifying it

step "Verifying the archive"
[[ -s "$TAR" ]] || die "the tar is empty."

LISTING="$(tar -tf "$TAR")"
if grep -qx 'oci-layout' <<<"$LISTING"; then
  die "the tar is an OCI archive (oci-layout, blobs/). Container Station will answer
       \"Invalid File Format\". Re-run without --no-convert."
fi
grep -qx 'repositories' <<<"$LISTING" || die "no 'repositories' file in the tar: not the legacy layout."
grep -qx 'manifest.json' <<<"$LISTING" || die "no manifest.json in the tar: not the legacy layout."
LAYERS="$(grep -c 'layer\.tar$' <<<"$LISTING" || true)"
[[ "$LAYERS" -ge 1 ]] || die "no <id>/layer.tar entries: nothing to load."

log "  manifest.json, repositories and ${LAYERS} layer(s): the layout Container Station accepts."

sha256sum "$TAR" > "${TAR}.sha256"
BYTES="$(wc -c < "$TAR" | tr -d ' ')"
log "  $(basename "$TAR"): $((BYTES / 1024 / 1024)) MB"
log "  sha256 written to $(basename "${TAR}.sha256")"

NOTES="${OUT_DIR}/${IMAGE_NAME}-${SHORT_SHA}${DIRTY}.txt"
cat > "$NOTES" <<EOF
${IMAGE_NAME}
  built     ${BUILT_AT}
  git       $(git rev-parse HEAD 2>/dev/null || echo unknown)${DIRTY:+ (working tree dirty)}
  tag       ${TAG}  (also tagged ${LATEST}, which the compose file names)
  archive   $(basename "$TAR")
  sha256    $(cut -d' ' -f1 < "${TAR}.sha256")

On the NAS
  1. Copy $(basename "$TAR") and $(basename "${TAR}.sha256"), then check the copy:
       sha256sum /share/<SHARE>/sharesies/$(basename "$TAR")
     and compare it with the line above. A truncated tar fails on import with the
     same "Invalid File Format" message as a wrong-layout one.
  2. Load it:
       docker load -i /share/<SHARE>/sharesies/$(basename "$TAR")
     or Container Station -> Images -> Add / Import image.
  3. Recreate the application (Container Station -> Applications), so the container
     starts from the new image. A running container keeps the old one.
  4. Confirm the first log line names the database on the volume:
       docker exec ${IMAGE_NAME} ls -la /data
     A path outside /data means the history is inside the container, one rebuild
     from starting empty.
EOF

step "Done"
log "  archive  ${TAR}"
log "  notes    ${NOTES}"
log ""
log "Copy the tar and its .sha256 to the NAS, verify the checksum there, load it, then"
log "recreate the application. deploy/qnap/README.md has the NAS side in full."
log ""
log "Updating more than a couple of times? The registry route is less work per update:"
log "  npm run image:push -- --registry ghcr.io/<you>/${IMAGE_NAME}"
log "which swaps a 60-200 MB file copy for a pull, and makes rollback a one-line edit."
