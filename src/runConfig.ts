/**
 * How to start the project a worktree holds — the "▶ Run" button's contract.
 *
 * The command is *resolved*, never invented: it comes from the operator's
 * override in the cockpit's own settings, or failing that from a file the repo
 * already keeps for the purpose (package.json scripts, a Procfile, a Makefile).
 * The cockpit adds no config file of its own to the repo being worked on.
 *
 * Shared by both processes: the main process resolves and spawns, the renderer
 * draws the resolved command in the button's tooltip.
 *
 * The port half of this module lives in `port.ts` — it is also read by
 * `vite.config.ts`, which must not pull in run-command resolution.
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
  /**
   * Why the last run ended badly, in one line, or null.
   *
   * There is no output console any more, so this is the only channel a run has
   * for saying what went wrong — the statusline shows it. It carries the tail of
   * what the process said, not a message the cockpit made up.
   */
  error: string | null;
};

export const IDLE_STATUS: RunStatus = {
  state: 'idle',
  cwd: null,
  command: '',
  exitCode: null,
  port: null,
  error: null,
};

/**
 * Every event carries its worktree: runs are concurrent, one per worktree, so a
 * button showing one of them has to ignore the others' traffic.
 */
export type RunEvent = { type: 'status'; cwd: string; status: RunStatus };

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
