# cockpit-probe

A dev tool for **seeing a cockpit change actually render** — it launches a disposable,
per-worktree Electron instance and drives it over the Chrome DevTools Protocol
(screenshot, run JS in the page, force a reload), **without ever touching the main
cockpit window you work in**.

This is contributor tooling for the agent-cockpit repo, not something the app ships to
its own users. It's packaged as a Claude Code *skill* so an agent working in this repo
can verify UI changes with one command instead of re-deriving the Electron + CDP
plumbing every time.

## Why it exists

Verifying a cockpit change means *looking at the rendered window*, but two things make a
naive screenshot lie, and one makes it dangerous:

- **`hmr: false` is deliberate** (the app hosts live Claude sessions; auto-reload would
  restart them mid-turn), so the renderer never picks up a `src/` edit on its own — a
  screenshot needs a forced reload first. `shot` reloads by default.
- **An occluded window freezes CSS keyframe animations**, so animated/clipped UI must be
  asserted via `eval` (`getAnimations()`, `scrollHeight > clientHeight`), not pixels.
- **The main window must never be reloaded, killed, or written to.** The probe runs on
  its own vite port (clear of the 5273–5472 worktree range), its own
  `--remote-debugging-port`, and its own `--user-data-dir`, so it can't collide with the
  main instance or a sibling worktree, and `cdp.mjs` refuses to attach to any page whose
  URL doesn't match the probe's own vite port.

## Install

```bash
npm run skill:install
```

This symlinks `tools/cockpit-probe/` into `~/.claude/skills/` so Claude Code registers
it (start a new session afterward). The repo copy stays the single source of truth — a
single link serves every worktree, since `probe.sh` resolves the target worktree from
your current directory's `git` root, not from where the script lives.

It's an explicit one-time step on purpose: the source lives as visible files in the repo
rather than a committed hidden `.claude/` directory.

## Usage

Run from the worktree whose cockpit you want to see (after install, via the skill path;
or straight from the repo without installing):

```bash
# installed:
bash ~/.claude/skills/cockpit-probe/scripts/probe.sh <cmd>
# or straight from a checkout:
bash tools/cockpit-probe/scripts/probe.sh <cmd>
```

| Command | What it does |
| --- | --- |
| `launch` | Idempotent: reuse a healthy probe for this worktree, else stand a new one up (free vite port ≥5900, CDP port ≥9222, own `--user-data-dir`). |
| `status` | Print `probe.json` + a live health check. |
| `shot [out.png] [--no-reload]` | Reload (default) then screenshot; prints the PNG path. `--no-reload` captures the current frame for transient/animated state. |
| `eval "<js>"` | `Runtime.evaluate` with `returnByValue` + `awaitPromise`; prints JSON. |
| `reload` | Reload the page only (pick up renderer edits without a capture). |
| `stop` | Tear down **only this probe's** recorded process trees + tmp dir. |

All state for a probe lives under `/tmp/cockpit-probe-<worktree>/` (`probe.json`,
`vite.log`, `electron.log`, the `--user-data-dir`, and `shot-*.png`).

Do **not** wrap `launch` in a background task tied to a Claude Code session — the probe
is detached on purpose so it outlives the tool call; run the script in the foreground.

### Asserting animated / clipped UI

An occluded probe freezes animations and can misreport layout, so verify motion and
overflow with `eval`, not a screenshot:

```bash
probe.sh eval "document.querySelector('.spinner').getAnimations().length"
probe.sh eval "(el => el.scrollHeight > el.clientHeight)(document.querySelector('.transcript'))"
```

## Files

- `SKILL.md` — the Claude Code skill definition (frontmatter + instructions).
- `scripts/probe.sh` — bash lifecycle entrypoint (bash 3.2-safe, detached launch, narrow
  pid-matched teardown).
- `scripts/cdp.mjs` — zero-dependency Node CDP driver (Node's global `WebSocket` +
  `fetch`); holds the safety rail that refuses to attach to anything but this probe.
- `install.mjs` — symlinks this directory into `~/.claude/skills/` (`npm run skill:install`).

## Not the Run button

The in-app **▶ Run** button (`electron/runner.ts`) also launches a worktree's app, but
it's a different tool on purpose: Run uses the sticky, bookmarkable 5273–5472 port, the
**shared** user-data store (so state persists — the point of the human window), and
**no** debug port (which is what makes the everyday window un-drivable and safe). The
probe inverts all three — off-range port, isolated store, debug port — because it's for
an agent to inspect a throwaway window, not for a human to keep one. Keep them separate.
