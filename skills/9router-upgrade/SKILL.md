---
name: 9router-upgrade
description: Upgrade this 9Router fork to the latest upstream (decolua/9router) by rebasing local changes onto origin/master, resolving conflicts without dropping fork features, re-running the baseline regression gate, and rebuilding/restarting the self-hosted Docker stack. Use when asked to upgrade, sync or update 9router, rebase onto upstream/origin, pull in a new upstream release, or refresh the fork after upstream moves.
---

# 9Router upgrade — rebase onto upstream

This repo is a fork that carries local features on top of `decolua/9router`. An upgrade is always a **rebase** (linear history, fork commits on top of upstream), never a merge.

```
origin = https://github.com/decolua/9router   upstream, default branch master
fork   = https://github.com/N0SAFE/9router    your fork, the push target
master = fork changes rebased onto origin/master
```

Confirm the upstream default branch first — it may be renamed:

```bash
git remote -v
git symbolic-ref refs/remotes/origin/HEAD     # refs/remotes/origin/master
```

## 0. Preconditions

- Working tree clean (`git status --short`). Commit or stash first: a rebase with dirty files is how work gets lost.
- Know which runtime is live, because both variants bind the same ports:
  - self-hosted container (`docker-prod compose ps`, reference: `DOCKER.md`), or
  - local app under the systemd user unit `9router.service`.
- Record the current tip so the rebase has a rollback point: `git rev-parse HEAD`.

## 1. Fetch + backup

```bash
git fetch origin --prune
git log --oneline -1 origin/master                            # what we rebase onto
git branch backup/pre-rebase-$(date +%Y%m%d-%H%M%S)           # instant rollback
```

Rollback: `git reset --hard <backup-branch>` (or `git rebase --abort` while mid-rebase).

## 2. Rebase

```bash
git rebase origin/master
```

Conflict policy — **keep both sides; never silently drop a fork feature**:

| Area | Typical conflict | Resolution |
|---|---|---|
| `open-sse/` routing/translation | upstream refactor vs fork routing rules | keep both: fork rules **and** upstream plumbing (e.g. routing map **and** `toolNameMap`, token-saver stats **and** pre-translate RTK) |
| `open-sse/providers/registry/index.js` | both sides added providers | keep upstream entries **and** fork providers, then fix **index collisions** (a duplicated `p124` import must be renumbered, e.g. → `p127`) |
| `open-sse/services/accountPool.js`, `accountFallback.js` | upstream guards vs fork rotation logic | replay the fork guard inside the upstream structure |
| `open-sse/providers/capabilities.js` | capability table reshaped | merge the table and update its test in the same commit |
| `src/app/**` dashboard components | upstream redesign | keep both features, then let `npm run build` catch JSX/type drift |
| `Dockerfile` / `docker-compose.yml` / `DOCKER.md` | upstream Docker changes vs fork stack | keep the fork stack; port upstream fixes (new deps, new COPY lines, apk/apt tweaks) into `Dockerfile.selfhosted` and leave the upstream `Dockerfile` untouched |

Continue with `git add <files> && git rebase --continue`; bail out anytime with `git rebase --abort`.

## 3. Post-rebase repairs

```bash
npm install     # only if package.json / lockfile moved
npm run build   # hard gate — must pass
```

Recurring breakage in this fork (give each fix its own focused commit):

- provider registry index collision (`open-sse/providers/registry/index.js`)
- account pool / cascade rotation guard lost (`open-sse/services/accountPool.js`, `accountFallback.js`)
- per-provider capability limits (`open-sse/providers/capabilities.js`) and `tests/unit/capabilities.test.js`
- **translation shape drift** where both sides touched the same translator: image
  pass-through blocks (`openai-to-commandcode`, `commandcode-to-openai`, the
  Claude↔OpenAI bridges), `tool_choice` demotion for opencode Free, and
  thinking/reasoning-effort mapping (`thinking-unified`, muse-spark). Upstream
  usually ships *new* tests for these, so a failing test that did not exist
  before the rebase is a merge error — not a flaky test.
- upstream Docker COPY/ENV/CVE fixes that the self-hosted image also needs

Commit style: `feat(<scope>): …` / `fix(<scope>): …` scoped to the area.

## 4. Regression gate — compare failure sets, never raw counts

The suite is intentionally not all-green (see `CLAUDE.md`), and for this fork the
committed catalogue is stale: ~85 currently failing tests are *not* in
`known-fails.txt`, and `verify-no-regression.mjs` derives test identities with
`name.split("/app/")[1]`, which only resolves on a checkout path containing
`/app/` (upstream CI, docker). On its own it therefore reports pre-existing
failures as regressions.

The authoritative question after a rebase is: **which tests passed before and
fail now?** Answer it against the pre-rebase branch (and upstream when the diff
is large):

```bash
# 1. results for the rebased tree
node tests/__baseline__/run-gate.mjs --run /tmp/9router-after.json

# 2. results for the pre-rebase reference (worktree + shared deps, no reinstall)
git worktree add --detach /tmp/9router-pre backup/pre-rebase-<timestamp>
ln -sfn "$PWD/node_modules" /tmp/9router-pre/node_modules
ln -sfn "$PWD/tests/node_modules" /tmp/9router-pre/tests/node_modules
node /tmp/9router-pre/tests/__baseline__/run-gate.mjs --run /tmp/9router-pre.json

# 3. gate — must report 0 pass→fail
node tests/__baseline__/run-gate.mjs --compare /tmp/9router-pre.json /tmp/9router-after.json
```

When a test fails in the rebased tree but also on a plain `origin/master`
checkout, judge it against upstream's own run before calling it a rebase error.

Snapshot-compare whatever provider-shaped code you touched:

```bash
node tests/__baseline__/verify-providers.mjs
node tests/__baseline__/verify-alias.mjs
node tests/__baseline__/verify-oauth-urls.mjs
# regenerate snapshots (node tests/__baseline__/snapshot-providers.mjs) only when the change is intentional
```

The upstream catalogue gate remains available as context:
`node tests/__baseline__/verify-no-regression.mjs <results.json>`.

## 5. Restart the runtime

Self-hosted container (preferred):

```bash
docker-prod compose up --build -d        # docker-prod = docker -H unix:///var/run/docker-prod.sock
docker-prod compose ps                   # Up (healthy)
curl -s localhost:20128/api/health       # {"ok":true}
docker exec 9router headroom --version   # Headroom present inside the container
```

Local variant instead:

```bash
systemctl --user restart 9router && curl -s localhost:20128/api/health
```

Only one variant may run — both bind `:20128`, and Headroom binds `127.0.0.1:8787`. Stop the other one first:

```bash
systemctl --user disable --now 9router   # stop and keep it off (revert: systemctl --user enable --now 9router)
pkill -f '[h]eadroom proxy'              # host-side leftovers
```

## 6. Publish

```bash
git push --force-with-lease fork master  # only after the user approves
```

- Never force-push `origin` (upstream).
- Keep `APP_VERSION` in `docker-compose.yml` in sync with `package.json` when the version moved.

## Pitfalls

- **`pkill -f` matches your own shell.** `pkill -f '9router/cli.js'` kills the shell running it; use the bracket trick: `pkill -f '[9]router/cli.js'`.
- **The local app respawns.** It is a systemd user unit with `Restart=always` (`~/.config/systemd/user/9router.service`) — `systemctl --user disable --now 9router`, otherwise it fights the container for port 20128.
- **Container volumes are external** (`9router-data`, `9router-home`). `compose down` never touches them, and compose must never create them empty; a fresh import is a deliberate, documented step (`DOCKER.md` → One-time data import).
- **Never use the in-app updater inside the container** — upgrade by rebuilding the image.
- **`tests/package.json`'s `test` script is broken by design** (hardcoded `/tmp/node_modules`): always `cd tests && npx vitest run`, or use `run-gate.mjs`.
- **The committed regression catalogue is not a gate here.** `known-fails.txt` misses ~85 real failures, and `verify-no-regression.mjs` needs a checkout path containing `/app/`. Use `tests/__baseline__/run-gate.mjs --compare` after every rebase.
- **Headroom extras live in the image** (`/opt/headroom`, build arg `HEADROOM_EXTRAS`). Dashboard-installed extras are lost on rebuild — add them to the build arg when they must persist.
- **Upstream-owned files are conflict magnets.** Prefer adding new files (this skill, `Dockerfile.selfhosted`) over editing upstream ones, and keep the diff small.

## Definition of done

- [ ] `git log --oneline origin/master..HEAD` shows only intentional fork commits
- [ ] `npm run build` passes
- [ ] `node tests/__baseline__/run-gate.mjs --compare <pre.json> <after.json>` reports **0 pass→fail**
- [ ] provider/alias/oauth snapshots verify (`verify-*.mjs`)
- [ ] stack healthy on `:20128`, Headroom answering, container `restart: always`
- [ ] backup branch kept until the fork push is verified
