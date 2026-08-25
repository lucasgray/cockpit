import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  IDLE_STATUS,
  parseMakefile,
  parseProcfile,
  pickScript,
  type RunCommand,
  type RunEvent,
  type RunStatus,
} from '../src/runConfig';
import { ensurePort } from './ports';
import { getStore } from './store';

/**
 * Starting the project a worktree holds.
 *
 * One run per worktree, concurrently: each worktree is assigned its own
 * dev-server port (see `ports.ts`) and that port is injected into the run's
 * environment, so two branches can serve at the same time instead of fighting
 * over one address. Starting a worktree that is already running restarts it.
 *
 * There is no output console — the run is a background service, and its window
 * is the browser the operator opens on the port. Output is therefore *not*
 * buffered for replay; only a short tail is kept, so a run that dies can put the
 * reason in the statusline instead of failing silently.
 */

/** Characters of recent output kept per worktree, for reporting a failure. */
const TAIL_LIMIT = 4_000;
/** Grace period between SIGTERM and SIGKILL on the process group. */
const KILL_GRACE_MS = 3_000;
/** How long to wait for a group to die before giving up and moving on. */
const KILL_TIMEOUT_MS = 6_000;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Lockfile → the package manager that wrote it. Order is most-specific-first. */
const LOCKFILES: [file: string, manager: string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

async function packageManager(cwd: string): Promise<string> {
  for (const [file, manager] of LOCKFILES) {
    if (await exists(path.join(cwd, file))) return manager;
  }
  return 'npm';
}

/**
 * Where the ▶ Run command comes from, in precedence order: the operator's
 * override, then whichever file in the repo already says how to start it.
 */
export async function detectRunCommand(cwd: string): Promise<RunCommand> {
  const override = getStore().settings().runCommand;
  if (override) return { command: override, source: 'cockpit settings' };

  const pkgText = await readText(path.join(cwd, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.scripts && typeof pkg.scripts === 'object') {
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const name = pickScript(pkg.scripts, { electron: 'electron' in deps });
        if (name) {
          return {
            command: `${await packageManager(cwd)} run ${name}`,
            source: `package.json → scripts.${name}`,
          };
        }
      }
    } catch {
      // Malformed package.json — fall through to the other conventions.
    }
  }

  const procfile = await readText(path.join(cwd, 'Procfile'));
  const proc = procfile && parseProcfile(procfile);
  if (proc) return { command: proc, source: 'Procfile' };

  const makefile = await readText(path.join(cwd, 'Makefile'));
  const target = makefile && parseMakefile(makefile);
  if (target) return { command: `make ${target}`, source: `Makefile → ${target}` };

  return { command: '', source: '' };
}

/**
 * The environment a run gets on top of the cockpit's own.
 *
 * `PORT` is the near-universal convention; `COCKPIT_PORT` is the unambiguous one
 * for projects that already use `PORT` for something else. Both are set so a
 * config file can read whichever it prefers.
 */
export function runEnv(port: number): Record<string, string> {
  return {
    COCKPIT_PORT: String(port),
    PORT: String(port),
    // A failure tail lands in the statusline, which renders ANSI colour as
    // escape noise — ask for plain text instead of stripping it after the fact.
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

// ---- lifecycle -----------------------------------------------------------

type Live = { child: ChildProcess; cwd: string; command: string; tail: string };

const live = new Map<string, Live>();
const statuses = new Map<string, RunStatus>();
let sink: ((event: RunEvent) => void) | null = null;

/** The main process points this at the window's `webContents`. */
export function onRunEvent(next: (event: RunEvent) => void) {
  sink = next;
}

function setStatus(cwd: string, patch: Partial<RunStatus>) {
  const status = { ...(statuses.get(cwd) ?? { ...IDLE_STATUS, cwd }), ...patch };
  statuses.set(cwd, status);
  sink?.({ type: 'status', cwd, status });
}

export function runStatus(cwd: string): RunStatus {
  return statuses.get(cwd) ?? { ...IDLE_STATUS, cwd };
}

/** The last thing the process said, in one line — what a failure reports. */
function lastLine(tail: string): string | null {
  const line = tail.trim().split('\n').filter(Boolean).pop();
  return line ? line.trim().slice(0, 300) : null;
}

/**
 * Take down a child and everything it spawned. Returns whether the tree was
 * confirmed dead.
 *
 * Why this is not just `child.kill()`: a run command is usually a shell, and the
 * processes that matter are its grandchildren. `npm run app` expands to
 * sh → concurrently → {vite, electron}. Signalling the shell alone reaps the
 * shell — vite keeps the dev port bound, and the next ▶ Run dies on EADDRINUSE
 * pointing at a process nothing in the UI admits to owning.
 *
 * So the child is spawned `detached`, which makes it a process-group leader, and
 * `process.kill(-pid)` signals every process in that group. Falling back to
 * `child.kill()` covers the case where there is no group to signal at all: spawn
 * failed early, or the child has already been reaped.
 *
 * SIGTERM first, since vite and electron both flush and unlink on the way out,
 * then SIGKILL after `KILL_GRACE_MS` for whatever ignored it. The separate
 * `KILL_TIMEOUT_MS` race is the giving-up point — a group wedged in
 * uninterruptible IO won't die on any signal, and hanging the UI on it forever is
 * worse than saying so. That is what the boolean is for: the caller has to report
 * the truth instead of claiming a clean stop.
 */
async function killTree(child: ChildProcess): Promise<boolean> {
  const { pid } = child;
  // Already gone counts as confirmed — there is nothing left to outlive us.
  if (!pid || child.exitCode !== null || child.signalCode !== null) return true;

  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // No group (already reaped, or spawn never got that far) — try the child.
      try {
        child.kill(sig);
      } catch {
        // Gone. Nothing left to signal.
      }
    }
  };

  let confirmed = false;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      confirmed = true;
      resolve();
    }),
  );
  signal('SIGTERM');

  const escalate = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, KILL_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(escalate);
  clearTimeout(timeout);
  return confirmed;
}

/**
 * Stop one worktree's run. Reports `idle` either way — a deliberate stop isn't a
 * failure, and the cockpit has let go of the process regardless — but a tree that
 * outlived its signals is reported rather than swallowed, because the only
 * symptom otherwise is the *next* start failing for no visible reason.
 */
export async function stopRun(cwd: string): Promise<RunStatus> {
  const target = live.get(cwd);
  if (!target) return runStatus(cwd);

  // Dropped before killing so the exit handler treats this as superseded and
  // stays quiet — the status below is the one that should land.
  live.delete(cwd);
  const dead = await killTree(target.child);
  const { port } = runStatus(cwd);

  setStatus(cwd, {
    state: 'idle',
    exitCode: null,
    error: dead
      ? null
      : `stop timed out after ${KILL_TIMEOUT_MS / 1_000}s — pid ${target.child.pid} may still hold port ${port}`,
  });
  return runStatus(cwd);
}

/** Start `command` (or the resolved one) in `cwd`, restarting it if already up. */
export async function startRun(cwd: string, command?: string): Promise<RunStatus> {
  await stopRun(cwd);

  const resolved = command?.trim() || (await detectRunCommand(cwd)).command;
  if (!resolved) {
    setStatus(cwd, {
      state: 'failed',
      cwd,
      command: '',
      exitCode: null,
      port: null,
      error: 'nothing in this worktree says how to run it — set runCommand in settings',
    });
    return runStatus(cwd);
  }

  const port = await ensurePort(cwd);

  let child: ChildProcess;
  try {
    child = spawn(resolved, {
      cwd,
      shell: true,
      // Its own process group, so `killTree` can take the whole fan-out down.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...runEnv(port) },
    });
  } catch (error) {
    setStatus(cwd, {
      state: 'failed',
      cwd,
      command: resolved,
      exitCode: null,
      port,
      error: error instanceof Error ? error.message : String(error),
    });
    return runStatus(cwd);
  }

  const entry: Live = { child, cwd, command: resolved, tail: '' };
  live.set(cwd, entry);
  setStatus(cwd, { state: 'running', cwd, command: resolved, exitCode: null, port, error: null });

  // Piped and dropped on the floor apart from the tail: nothing displays a run's
  // output, but a crash has to be able to say what it said on the way down.
  const collect = (data: Buffer) => {
    entry.tail = (entry.tail + data.toString()).slice(-TAIL_LIMIT);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  child.on('error', (error) => {
    if (live.get(cwd)?.child !== child) return;
    live.delete(cwd);
    setStatus(cwd, { state: 'failed', exitCode: null, error: error.message });
  });

  child.on('exit', (code, signal) => {
    // A newer run (or an explicit stop) already took over — its status stands.
    if (live.get(cwd)?.child !== child) return;
    live.delete(cwd);
    setStatus(cwd, {
      state: code === 0 ? 'exited' : 'failed',
      exitCode: code ?? null,
      error: code === 0 ? null : (lastLine(entry.tail) ?? (signal ? `killed (${signal})` : null)),
    });
  });

  return runStatus(cwd);
}

/** Called on app quit — no dev server should outlive the window that started it. */
export async function closeRun(): Promise<void> {
  const targets = [...live.values()];
  live.clear();
  await Promise.allSettled(targets.map((target) => killTree(target.child)));
}
