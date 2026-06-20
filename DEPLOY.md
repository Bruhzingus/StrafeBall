# Deploying Strafeball

The DigitalOcean droplet is a throttled 1-vCPU shared box. Compiling the Vite client there takes
**~8 minutes**; the same build on a normal machine takes **~20 seconds**. So we **build locally and
commit the artifacts** — the droplet never runs `npm run build`, it just `git pull`s already-compiled
output and restarts the process.

The two build outputs ARE committed (un-ignored in `.gitignore`):

- `dist/` — Vite client bundle, served as static files off the droplet.
- `server/dist/` — compiled server (`tsc`); entry point `server/dist/server/src/index.js`.

---

## Releasing a change (on your machine)

```sh
# 1. make your code change, then prebuild + stage the artifacts in one step:
npm run deploy:prebuild
#    ^ runs music:manifest, typechecks client+server, builds both, and `git add -f`s
#      dist/ + server/dist/. It typechecks FIRST, so broken code can't produce committed artifacts.

# 2. commit your source AND the rebuilt artifacts together, then push:
git add -A
git commit -m "your change"
git push
```

> **The one rule:** never commit a code change without rerunning `npm run deploy:prebuild` in the same
> commit. If you commit source without rebuilding, the droplet pulls new source but STALE `dist/` and
> serves old code. `deploy:prebuild` is the guardrail — make it muscle memory.

---

## On the droplet (deploy script)

The old script ran `npm run build` in both folders (the 8-minute step). Replace that with a pull +
restart — **no build**:

```sh
#!/usr/bin/env bash
set -e
cd /path/to/StrafeBall

git pull --ff-only

# Install deps ONLY if package-lock changed (skips the slow npm install on every deploy).
# Client deps are build-time only and not needed at runtime since dist/ is prebuilt, so we only
# need server runtime deps:
npm --prefix server ci --omit=dev   # or `npm --prefix server install --omit=dev`

# Restart the game server (adjust to your process manager / app name):
pm2 restart strafeball

# Static client is already in dist/ — whatever serves it (Node static handler / nginx) picks it up
# automatically on the next request. No build, no extra step.
```

If `package-lock.json` rarely changes you can even drop the `npm ci` line from the common path and
only run it manually when deps change — making a deploy effectively just `git pull && pm2 restart`.

---

## Why this is safe

- The droplet does **zero compilation**, so the shared-CPU throttling that caused the 8-minute build
  (and the in-game ping spikes — see `NETCODE_INVESTIGATION_HANDOFF.md`) no longer touches deploys.
- `deploy:prebuild` typechecks before emitting, so you can't ship artifacts built from code that
  doesn't compile.
- Committed artifacts are deterministic from source; if a diff ever looks wrong, rerun
  `npm run deploy:prebuild` and recommit.
