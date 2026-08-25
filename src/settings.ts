/**
 * The cockpit's own agent configuration — the single source of truth for how a
 * session is driven. It lives in the app's SQLite store and is passed explicitly
 * into the Agent SDK, so behaviour is identical on every machine instead of
 * depending on whatever dotfiles happen to sit in the operator's home directory.
 *
 * Shared by both processes: the main process reads it to build `query()`
 * options, the renderer reads it to draw the Settings panel.
 */

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
};

export const DEFAULT_SETTINGS: CockpitSettings = {
  model: '',
  permissionMode: 'default',
  maxTurns: 100,
  instructions: '',
  inheritProjectInstructions: false,
  claudePath: '',
};

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Coerce anything read back from disk into a complete, valid settings object. */
export function normalizeSettings(raw: unknown): CockpitSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<CockpitSettings>;
  const mode = input.permissionMode;
  const turns = Number(input.maxTurns);

  return {
    model: str(input.model, DEFAULT_SETTINGS.model).trim(),
    permissionMode: PERMISSION_MODES.includes(mode as PermissionMode)
      ? (mode as PermissionMode)
      : DEFAULT_SETTINGS.permissionMode,
    maxTurns: Number.isFinite(turns) ? Math.min(500, Math.max(1, Math.round(turns))) : DEFAULT_SETTINGS.maxTurns,
    instructions: str(input.instructions, DEFAULT_SETTINGS.instructions),
    inheritProjectInstructions: input.inheritProjectInstructions === true,
    claudePath: str(input.claudePath, DEFAULT_SETTINGS.claudePath).trim(),
  };
}
