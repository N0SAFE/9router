# Docker

Run 9Router in a container. Published image: [`decolua/9router`](https://hub.docker.com/r/decolua/9router) — multi-platform `linux/amd64` + `linux/arm64`.

For an all-in-one self-hosted deployment (router + bundled Headroom, built from this repo, on the production Docker daemon) jump to [Self-hosted all-in-one stack](#-self-hosted-all-in-one-stack-docker-composeyml).

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  decolua/9router:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f 9router        # view logs
docker stop 9router           # stop
docker start 9router          # start again
docker rm -f 9router          # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name 9router \
  decolua/9router:latest
```

## Optional Headroom sidecar

> The [self-hosted all-in-one stack](#-self-hosted-all-in-one-stack-docker-composeyml) bundles Headroom inside the 9Router image, so you do not need a sidecar there. The instructions below are for the published image (`decolua/9router`), which ships without Python.

The 9Router image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point 9Router at that proxy:

```yaml
services:
  9router:
    image: decolua/9router:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
docker pull decolua/9router:latest
docker rm -f 9router
# re-run the quick start command
```

To pin a specific version instead of following `latest`, use a numbered image tag:

```bash
docker pull decolua/9router:0.5.81
```

---

# 🏠 Self-hosted all-in-one stack (`docker-compose.yml`)

`docker-compose.yml` + `Dockerfile.selfhosted` run the router **and its managed Headroom proxy** in one long-lived container on the production Docker daemon. Compose only *starts* the stack — it never reads `$HOME/.9router`; the data volume is imported by hand once, before the first start.

```bash
docker-prod compose up --build -d      # docker-prod = docker -H unix:///var/run/docker-prod.sock
docker-prod compose logs -f router
docker-prod compose down               # keeps the 9router-data volume
```

| | |
|---|---|
| **Container** | `9router` (`9router:selfhosted`), `restart: always`, `init: true`, 50 MB × 5 log rotation |
| **Data** | external volumes `9router-data` → `/app/data` and `9router-home` → `/home/node/.headroom`, both pre-populated once (see below) |
| **Headroom** | `headroom-ai` installed in the image (`/opt/headroom` venv), managed by 9Router on `127.0.0.1:8787` — nothing runs on the host Python |
| **Network** | host networking, so `localhost:11434` (Ollama), llama.cpp connections and the loopback Headroom URL behave exactly like the local install |

## One-time data import

Run once, with the local app stopped, before the first `up`. This is a manual step: the stack itself never touches `$HOME/.9router` or `$HOME/.headroom`.

```bash
# app data: database, secrets, settings, model catalog
docker-prod volume create 9router-data
docker-prod run --rm \
  -v 9router-data:/target \
  -v "$HOME/.9router:/source:ro" \
  alpine:3.20 sh -c '
    cp -a /source/. /target/ &&
    rm -rf /target/remote &&
    rm -f /target/headroom/proxy.pid /target/local/*.json /target/local/*.log &&
    chown -R 1000:1000 /target'

# Headroom's own home: savings history, ccr store, logs
docker-prod volume create 9router-home
docker-prod run --rm \
  -v 9router-home:/target \
  -v "$HOME/.headroom:/source:ro" \
  alpine:3.20 sh -c '
    cp -a /source/. /target/ &&
    rm -f /target/.beacon_lock_* &&
    chown -R 1000:1000 /target'
```

`remote/` (VS Code agent-host/tunnel state) and the managed-process pid files are dropped on purpose — they describe host processes and would be meaningless inside the container. `9router-home` keeps the Token Saver dashboard numbers continuous across the switch.

## Switching from the local variant

The local app and the container bind the same ports and must not share a SQLite file, so:

```bash
# 1. stop the local app for good (systemd user unit with Restart=always)
systemctl --user disable --now 9router
pkill -f '[h]eadroom proxy' || true

# 2. import the data once (see "One-time data import")

# 3. start the stack
docker-prod compose up --build -d
docker-prod compose logs -f router
```

The dashboard is then at http://localhost:20128 with the same login, providers and settings as the local install. To go back to the local variant: `docker-prod compose down && systemctl --user enable --now 9router`.

## Verifying

```bash
docker-prod compose ps                       # router running/healthy
curl -s localhost:20128/api/health           # {"ok":true}
docker-prod exec 9router headroom --version  # headroom inside the container
```

## Headroom extras and image size

The image installs `headroom-ai[proxy,code,ml]` by default — AST compression (`code`) and Kompress (`ml`, CPU-only torch), matching a fully-featured host install. This makes the image a couple of GB; to skip the ML stage:

```bash
HEADROOM_EXTRAS=proxy,code docker-prod compose build router
```

Extras can also be toggled from the dashboard (`Endpoint → Token Saver → Headroom`): the venv ships pip and is owned by the container user, so in-app installs work. They are lost when the image is rebuilt.

## Upgrade agent (dashboard button)

The self-hosted image ships the opencode CLI (v2, pinned) plus git/ripgrep and the Docker CLI, so this fork can be upgraded without leaving the dashboard.

- **Button**: Dashboard → Profile → *Upgrade agent* — it sits with the version info and enables when `/api/version` reports an update.
- **Model**: set the model (or combo) in the same card. The run passes it as `opencode run --model 9router/<model>`, so the agent talks to this router with the model you configured there.
- **What it runs**: `skills/9router-upgrade/SKILL.md` — fetch upstream, backup branch, rebase, resolve conflicts keeping both sides, `npm run build`, the regression gate, focused commits. The prompt forbids pushing.
- **Finish**: the agent rebuilds and restarts this stack (`docker compose up -d --build`) as its final step, which recreates the container it runs in. Commit first, restart last.
- **Mounts it needs** (already in `docker-compose.yml`):

  | Mount | Why |
  |---|---|
  | `${REPO_PATH:-$HOME/Bureau/projects/self-hosted/9router}` → `/workspace/9router` | the git checkout the agent rebases and commits in |
  | `/var/run/docker-prod.sock` → same path (plus `group_add` with the socket's GID) | lets the agent rebuild/restart the stack — root-equivalent Docker access |
  | `9router-data` → `/app/data` (`opencode/` subdir) | opencode config/state, plus run logs and report in `/app/data/upgrade/` |

- **State**: `/app/data/upgrade/{state.json,run.log,last-report.md}`; the card shows the log tail and the last report.
- The API is local-only (`/api/upgrade/start|stop` require the CLI token or loopback access, like the Headroom endpoints).

**Security note**: mounting the production socket gives this container full control over that daemon. That is intentional for this personal fork — do not reuse this compose file for a shared deployment.

## What is *not* in the container

| Feature | Why | Where it runs |
|---|---|---|
| Local model servers (`ollama serve`, `llama-server`) | a container cannot manage host processes | host — connections keep working thanks to host networking (`http://localhost:11434`) |
| 9Remote / VS Code agent host + tunnel | needs the VS Code CLI and its tunnel sessions | host (`9router-host`, `9router-agent`) |
| In-app updater (`/api/version/update`) | the app inside an image is not self-updating | rebuild: `docker-prod compose up --build -d` |

## Starting over from the host

The volumes are external, so replacing them is an explicit two-step:

```bash
docker-prod compose down
docker-prod volume rm 9router-data 9router-home   # discards the container's state
# then repeat "One-time data import" and bring the stack back up:
docker-prod compose up -d
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -t 9router .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router
```

The Dockerfile uses the official Alpine and npm registries by default. Regional mirrors can be supplied when needed:

```bash
docker build \
  --build-arg ALPINE_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ \
  -t 9router .
```

## Publish (automatic via CI)

Push a Docker-safe semver git tag `vX.Y.Z` (or a prerelease such as `vX.Y.Z-rc.1`) → GitHub Actions builds `linux/amd64` and `linux/arm64` on native runners, health-checks each platform image, verifies the resulting manifest and `/api/health`, then publishes:

- `ghcr.io/decolua/9router:X.Y.Z` + `:latest`
- `decolua/9router:X.Y.Z` + `:latest`

The `v` prefix is used only for the git tag; image tags omit it. A stable tag push promotes `latest`, but a prerelease tag such as `vX.Y.Z-rc.1` publishes only its numbered image by default. Prereleases require an explicit manual `promote_latest` opt-in. Promotion happens only after both native platform builds, both platform health checks, manifest inspection, and the resolved-manifest smoke test succeed. A failed or timed-out platform build therefore cannot move `latest`.

The workflow rejects SemVer build metadata such as `v1.2.3+build.7` because the `+` form is not a valid Docker image tag. The git tag and both `package.json` versions must match exactly.

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.5.81 && git push origin v0.5.81
```

To republish an existing tag, run the `Build and Push Docker Image` workflow manually and provide the exact tag, for example `v0.5.81`, in the `release_tag` input. Manual runs publish the numbered tag but leave `latest` unchanged by default:

```text
release_tag:     v0.5.81
promote_latest:  false
```

The `promote_latest` checkbox is an explicit opt-in for changing `latest`. Use it when a deliberate rollback or recovery should make that version the current default:

```text
release_tag:     v0.5.75
promote_latest:  true
```

Numbered image tags are mutable because a republish can replace their manifest. For a deployment that must be immutable, pin the image digest instead:

```bash
docker pull decolua/9router@sha256:<verified-digest>
```

The release workflow runs `/api/health` on each native `amd64` and `arm64` platform image before it uploads the digest artifact or assembles the multi-platform manifest. It then runs a second health check against the resolved version manifest before any requested `latest` promotion.

During recovery, the selected tag remains the application source while the Dockerfile from the workflow revision is used, so an older tag can be rebuilt with the current publishing fixes.

The workflow is tag-driven. Creating a git tag does not automatically create a GitHub Release, so the Releases page and the published package/image tags can be at different versions unless a maintainer creates a release separately.

The upstream repository needs these repository secrets for Docker Hub publishing:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

GHCR publishing uses the workflow's `GITHUB_TOKEN` with package write permission. Forks can publish to their own GHCR namespace, but Docker Hub publication is restricted to the upstream `decolua/9router` repository.

The optional repository variables `ALPINE_MIRROR` and `NPM_REGISTRY` can override the default package mirrors used by the CI Docker build.

Workflow: `.github/workflows/docker-publish.yml`

## Self-hosted deployment on this machine (docker-prod)

The app that serves the dashboard and API is the **docker-prod compose stack**,
not the systemd tray service:

- daemon: `docker -H unix:///var/run/docker-prod.sock`
- project: `9router` — this directory's `docker-compose.yml`, service `router`
- data: external volume `9router-data` mounted at `/app/data` (the SQLite DB lives there)

Deploy a change:

```bash
docker -H unix:///var/run/docker-prod.sock compose up --build -d
docker -H unix:///var/run/docker-prod.sock compose logs -f router
```

Notes:

- The tray unit (`9router.service`, `cli.js --tray`) only shows the tray icon; it
  does not serve HTTP while the container owns port 20128.
- Copying a `9router-*.tgz` into `~/.bun/install/global/node_modules/9router`
  does **not** update the running app — only the image build above does.
- Rebuilds recreate the container; the data volume is preserved.
