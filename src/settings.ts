/**
 * The cockpit's own agent configuration — the single source of truth for how a
 * session is driven. It lives in the app's SQLite store and is passed explicitly
 * into the Agent SDK, so behaviour is identical on every machine instead of
 * depending on whatever dotfiles happen to sit in the operator's home directory.
 *
 * Shared by both processes: the main process reads it to build `query()`
 * options, the renderer reads it to draw the Settings panel.
 */

import { DEFAULT_PORT } from './runConfig';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk'];

export type CockpitSettings = {
  /** Model id, or '' to take the CLI's default. */
  model: string;
  permissionMode: PermissionMode;
  maxTurns: number;
  /** Appended to the `claude_code` system prompt preset. */
  instructions: string;
  /**
   * Whether to let the *opened repo* contribute CLAUDE.md and `.claude/settings.json`.
   * Off by default: the cockpit's config is the config. Note the SDK couples the
   * two — loading CLAUDE.md requires the `project` setting source, which also
   * pulls in that repo's `.claude/settings.json`.
   *
   * The operator's personal `~/.claude/settings.json` is never loaded either way;
   * that is the one input that could never travel with a packaged build.
   */
  inheritProjectInstructions: boolean;
  /** Explicit path to the Claude Code binary, or '' to auto-discover it. */
  claudePath: string;
  /**
   * Shell command the ▶ Run button starts in the active worktree, or '' to
   * resolve it from the repo (package.json scripts, Procfile, Makefile).
   *
   * An override rather than a default: leaving it empty means every repo the
   * cockpit opens gets the right command without being told, and setting it
   * pins one repo that guesses wrong. See `src/runConfig.ts`.
   */
  runCommand: string;
  /**
   * Shell command run in a freshly created worktree, or '' for the default
   * (`$COCKPIT_BOOTSTRAP`, else `npm install`).
   *
   * Receives the worktree's newly assigned port as `COCKPIT_PORT` and `PORT`, so
   * a project that needs the port baked into a file — an `.env`, a compose
   * override — can write it here, at the one moment the worktree is new.
   */
  worktreeCreateHook: string;
  /**
   * Lowest port handed out to a worktree. Each one gets its own, counting up
   * from here, so two worktrees can run at the same time without colliding.
   */
  portBase: number;
};

export const DEFAULT_SETTINGS: CockpitSettings = {
  model: '',
  permissionMode: 'default',
  maxTurns: 100,
  instructions: '',
  inheritProjectInstructions: false,
  claudePath: '',
  runCommand: '',
  worktreeCreateHook: '',
  portBase: DEFAULT_PORT,
};

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Coerce anything read back from disk into a complete, valid settings object. */
export function normalizeSettings(raw: unknown): CockpitSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<CockpitSettings>;
  const mode = input.permissionMode;
  const turns = Number(input.maxTurns);
  const base = Number(input.portBase);

  return {
    model: str(input.model, DEFAULT_SETTINGS.model).trim(),
    permissionMode: PERMISSION_MODES.includes(mode as PermissionMode)
      ? (mode as PermissionMode)
      : DEFAULT_SETTINGS.permissionMode,
    maxTurns: Number.isFinite(turns) ? Math.min(500, Math.max(1, Math.round(turns))) : DEFAULT_SETTINGS.maxTurns,
    instructions: str(input.instructions, DEFAULT_SETTINGS.instructions),
    inheritProjectInstructions: input.inheritProjectInstructions === true,
    claudePath: str(input.claudePath, DEFAULT_SETTINGS.claudePath).trim(),
    runCommand: str(input.runCommand, DEFAULT_SETTINGS.runCommand).trim(),
    worktreeCreateHook: str(input.worktreeCreateHook, DEFAULT_SETTINGS.worktreeCreateHook).trim(),
    // Below 1024 needs root to bind, and the range has to leave room to count up.
    portBase: Number.isFinite(base) ? Math.min(60_000, Math.max(1_024, Math.round(base))) : DEFAULT_PORT,
  };
}
