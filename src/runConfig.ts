/**
 * How to start the project a worktree holds — the "▶ Run" button's contract.
 *
 * The command is *resolved*, never invented: it comes from the operator's
 * override in the cockpit's own settings, or failing that from a file the repo
 * already keeps for the purpose (package.json scripts, a Procfile, a Makefile).
 * The cockpit adds no config file of its own to the repo being worked on.
 *
 * Shared by both processes: the main process resolves and spawns, the renderer
 * draws the resolved command and lets it be edited.
 */

/** Where a resolved command came from, phrased for a tooltip. */
export type RunCommand = {
  /** The shell command to run, or '' when nothing could be resolved. */
  command: string;
  /** Human-readable provenance, e.g. `package.json → scripts.app`. '' if none. */
  source: string;
};

export type RunState =
  /** Nothing running — either never started, or deliberately stopped. */
  | 'idle'
  | 'running'
  /** Exited 0 on its own. A dev server reaching this usually means it crashed. */
  | 'exited'
  /** Non-zero exit, spawn failure, or no command to run. */
  | 'failed';

export type RunStatus = {
  state: RunState;
  /** Worktree the command runs in, or last ran in. */
  cwd: string | null;
  command: string;
  exitCode: number | null;
  /** Port injected into the run's env, so the UI can say where it landed. */
  port: number | null;
};

export const IDLE_STATUS: RunStatus = {
  state: 'idle',
  cwd: null,
  command: '',
  exitCode: null,
  port: null,
};

/** One chunk of child output, tagged with the pipe it arrived on. */
export type RunChunk = { stream: 'out' | 'err'; text: string };

/**
 * Every event carries its worktree: runs are concurrent, one per worktree, so a
 * pane showing one of them has to ignore the others' traffic.
 */
export type RunEvent =
  | { type: 'status'; cwd: string; status: RunStatus }
  | { type: 'output'; cwd: string; chunk: RunChunk }
  /** A new run began in this worktree; drop whatever output is on screen. */
  | { type: 'cleared'; cwd: string };

/** Port the dev server binds when the cockpit has assigned nothing. */
export const DEFAULT_PORT = 5273;

/**
 * The port a run should bind, read from the env the cockpit injects.
 *
 * Shared by `vite.config.ts` and the main process's dev-URL fallback so a
 * worktree's server and the window pointed at it always agree. The env is passed
 * in rather than read from `process` — this module is also loaded in the
 * renderer, where there is no `process` to read.
 */
export function resolvePort(env: Record<string, string | undefined>): number {
  const raw = env.COCKPIT_PORT ?? env.PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT;
}

/** Script names that conventionally start a project, best first. */
const SCRIPT_NAMES = ['dev', 'start', 'serve', 'app'];

/**
 * Does this script body actually *invoke* `electron`, as opposed to merely
 * mentioning it in a path? `esbuild electron/main.ts` and `--outfile=dist-electron/…`
 * both contain the word; only a bare `electron <args>` command starts a window.
 */
function invokesElectron(script: string): boolean {
  return /(?:^|[\s;&|])electron(?=\s|$)/.test(script);
}

/**
 * Pick the script that opens the app.
 *
 * An Electron project has two plausible "dev" scripts: the one that starts the
 * bundler and the one that starts the bundler *and* opens a window. Name order
 * alone picks the wrong one — cockpit's own `dev` is browser-only while `app` is
 * the real thing — so when the project ships Electron, prefer whichever script
 * launches it and fall back to the conventional names otherwise.
 */
export function pickScript(
  scripts: Record<string, string>,
  opts: { electron: boolean },
): string | null {
  const names = Object.keys(scripts).filter((name) => typeof scripts[name] === 'string');

  if (opts.electron) {
    const launcher = names.find((name) => invokesElectron(scripts[name]));
    if (launcher) return launcher;
  }

  return SCRIPT_NAMES.find((name) => names.includes(name)) ?? null;
}

/** Make targets worth treating as "run this project", best first. */
export const MAKE_TARGETS = ['dev', 'run', 'start', 'serve'];

/** The first real command in a Procfile, ignoring blanks and comments. */
export function parseProcfile(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const command = line.slice(colon + 1).trim();
    if (command) return command;
  }
  return null;
}

/** The first Make target from `MAKE_TARGETS` that the Makefile actually defines. */
export function parseMakefile(text: string): string | null {
  return MAKE_TARGETS.find((target) => new RegExp(`^${target}\\s*:`, 'm').test(text)) ?? null;
}
