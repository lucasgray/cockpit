---
name: cockpit-probe
description: >-
  Launch a disposable, per-worktree cockpit instance and drive it over the Chrome
  DevTools Protocol — screenshot the real rendered UI, run JS in the page, and force a
  reload — WITHOUT ever touching Lucas's main cockpit window. Use this whenever you need
  to SEE a cockpit change actually working: "screenshot the cockpit", "does this UI
  change render", "show me the app", "verify the cockpit visually", "drive the cockpit
  over CDP", "check the animation / layout in the real app", or any time you'd otherwise
  hand-roll an Electron launch + CDP WebSocket to look at the renderer. It launches on
  its own vite port (clear of the 5273-5472 worktree range), its own remote-debugging
  port, and its own --user-data-dir, so it never collides with the main instance or a
  sibling worktree. This is the agent-cockpit Electron app, not the comp dev stack.
---

# cockpit-probe — launch a disposable probe & drive it over CDP

Verifying a cockpit change means *looking at the rendered window*, and the main window
is off-limits. This skill stands up a throwaway cockpit for the **current worktree**,
isolated on its own ports and `--user-data-dir`, and gives you four verbs over the
Chrome DevTools Protocol: **shot**, **eval**, **reload**, **stop**. All plumbing (free
port scan, detached launch, electron build, raw CDP WebSocket) is inside the scripts —
you run one command per action.

## Why a probe, and the three hard rules it encodes

- **Never touch the main instance.** Lucas works in the main cockpit: default vite port,
  **no** debug port, a **shared** SQLite store. The probe runs on a different vite port,
  its own `--remote-debugging-port`, and its own `--user-data-dir`, so it can't be
  reached over CDP by accident *and* can't contend with the main store. `cdp.mjs`
  additionally refuses to attach unless the page's URL host:port matches the probe's own
  vite port. **Teardown only ever reaps the probe's own recorded pids — never
  `pkill -f electron`.**
- **The window goes stale.** vite runs with `hmr: false` on purpose. So `shot` **reloads
  by default** (`Page.reload` → wait for `loadEventFired` → capture) so renderer edits
  actually show. An occluded window also freezes CSS keyframes, so **don't trust pixels
  for animated/clipped UI** — assert it via `eval` instead (see below).
- **Visible in the repo, not a hidden dotfile.** The cockpit owns its tooling as
  first-class files: this skill is vendored at `tools/cockpit-probe/` and symlinked into
  `~/.claude/skills/` by `npm run skill:install` — never committed as a hidden `.claude/`.

## Usage

Run from the worktree whose cockpit you want to see. All state lives under
`/tmp/cockpit-probe-<worktree>/` (`probe.json`, `vite.log`, `electron.log`, the
`--user-data-dir`, and `shot-*.png`).

```bash
bash ~/.claude/skills/cockpit-probe/scripts/probe.sh launch
```

`launch` is **idempotent**: if a healthy probe for this worktree is already up, it
reuses it; otherwise it picks a free vite port (>=5900) and CDP port (>=9222), starts
vite detached, builds the electron main, launches electron with the debug + user-data
switches, waits for the page target, and writes `probe.json`. Do **not** wrap it in a
Claude Code `run_in_background` task — the probe is detached on purpose so it outlives
the tool call; run the script in the foreground with the sandbox disabled.

```bash
bash ~/.claude/skills/cockpit-probe/scripts/probe.sh status                 # probe.json + live health
bash ~/.claude/skills/cockpit-probe/scripts/probe.sh shot [out.png]         # reload, then screenshot
bash ~/.claude/skills/cockpit-probe/scripts/probe.sh shot out.png --no-reload   # capture the CURRENT frame
bash ~/.claude/skills/cockpit-probe/scripts/probe.sh eval "document.title"  # run JS in the page
bash ~/.claude/skills/cockpit-probe/scripts/probe.sh reload                 # reload only (pick up edits)
bash ~/.claude/skills/cockpit-probe/scripts/probe.sh stop                   # tear down THIS probe
```

`shot` prints the PNG path (defaults to `/tmp/cockpit-probe-<worktree>/shot-<n>.png`);
**Read that file** to view the UI. After editing anything under `src/`, the next `shot`
(or a `reload`) is what makes the change appear — that's the whole point of reload-by-
default defeating `hmr: false`.

## Asserting animated / clipped UI (don't trust the pixels)

An occluded probe window freezes CSS animations and can misreport layout, so verify
motion and overflow with `eval`, not a screenshot:

```bash
# Is that element actually animating?
probe.sh eval "document.querySelector('.spinner').getAnimations().length"
# Is content clipped / does it overflow its box?
probe.sh eval "(el => el.scrollHeight > el.clientHeight)(document.querySelector('.transcript'))"
```

`eval` uses `Runtime.evaluate` with `returnByValue` + `awaitPromise`, so it returns
JSON-serializable values and awaits promises. It's the general escape hatch — reach for
it whenever a screenshot can't answer the question.

## When done

`stop` SIGTERM→SIGKILLs the probe's recorded electron and vite process trees (matched by
pid **and** by the `--user-data-dir` / `vite` command signature, so a recycled pid can't
misfire), kills any lingering listener on the probe's own vite port, and removes the tmp
dir. It leaves the main cockpit — and every sibling worktree's probe — completely alone.

## Source & install

This skill is **vendored in the agent-cockpit repo** at `tools/cockpit-probe/` and
symlinked into `~/.claude/skills/` by `npm run skill:install` — the repo copy is the
single source of truth, so edit it there. See `tools/cockpit-probe/README.md`.

## Files

- `scripts/probe.sh` — bash lifecycle entrypoint (bash 3.2-safe, detached launch, narrow
  kill), mirrors the `restart-dev-stack` conventions.
- `scripts/cdp.mjs` — zero-dependency Node CDP driver (Node 22+ global `WebSocket` +
  `fetch`); holds the safety rail that refuses to attach to anything but this probe.
- `install.mjs` — symlinks this dir into `~/.claude/skills/` (`npm run skill:install`).
