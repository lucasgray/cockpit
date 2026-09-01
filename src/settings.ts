/**
 * The cockpit's own agent configuration — the single source of truth for how a
 * session is driven. It lives in the app's SQLite store and is passed explicitly
 * into the Agent SDK, so behaviour is identical on every machine instead of
 * depending on whatever dotfiles happen to sit in the operator's home directory.
 *
 * Shared by both processes: the main process reads it to build `query()`
 * options, the renderer reads it to draw the Settings panel.
 */

import { DEFAULT_PORT } from './port';
import { DEFAULT_HIGHLIGHT_COLOR, isHighlightColorId } from './highlightColors';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk';

export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk'];

/**
 * How hard the model works on a turn — the composer's effort switcher. Not every
 * model takes one (Haiku doesn't), and the ones that do don't all reach `max`,
 * so which levels are offered comes from the model, not from this list.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** '' means "don't send one" — the CLI's own default, whatever that is here. */
export type EffortChoice = EffortLevel | '';

/** One row in the composer's model switcher. */
export type ModelChoice = {
  /** Model id to hand the SDK. '' is the default entry — send no model at all. */
  value: string;
  label: string;
  /**
   * The wire id this row's `value` resolves to, when the two differ — the live
   * catalogue tends to speak in aliases (`opus`) where a pin written from
   * `FALLBACK_MODELS` holds the full id (`claude-opus-5`). Carrying it is what
   * lets the switcher recognise such a pin as this row rather than as a stranger.
   */
  resolvedModel?: string;
  /**
   * The CLI's own one-liner — "Opus 5 with 1M context · Best for everyday,
   * complex tasks". This is the only thing that says *which* Opus a row is: the
   * display names are bare ("Opus (1M context)", "Default (recommended)"), so
   * without it two rows pointing at different generations look identical.
   */
  description?: string;
  /** Effort levels this model accepts. Empty means it takes no effort at all. */
  effortLevels: EffortLevel[];
};

/** Effort on the 4.6 generation, which predates `xhigh` (added with Opus 4.7). */
const EFFORT_NO_XHIGH: EffortLevel[] = ['low', 'medium', 'high', 'max'];

/**
 * Models this machine can reach that `supportedModels()` doesn't advertise.
 *
 * The CLI's catalogue lists only the current generation — Opus 5, Fable 5,
 * Sonnet 5, Haiku 4.5. The generation before it is still perfectly reachable;
 * it just isn't offered, so a switcher built from the catalogue alone can't name
 * a single one of them. These rows are merged in beside the live ones.
 *
 * Every entry below was verified by running an actual turn against it, and every
 * `value` carries the `[1m]` suffix for the same reason the catalogue's own
 * `opus[1m]` row does: without it Claude Code caps the session at 200K.
 *
 * This list is hand-maintained, which is the cost of the CLI not exposing one.
 * Prefer whatever the catalogue offers — an entry here that the CLI later starts
 * advertising is dropped as a duplicate rather than shown twice.
 */
export const UNLISTED_MODELS: ModelChoice[] = [
  {
    value: 'claude-opus-4-8[1m]',
    label: 'Opus 4.8',
    resolvedModel: 'claude-opus-4-8',
    description: 'Opus 4.8 with 1M context · The generation before Opus 5',
    effortLevels: EFFORT_LEVELS,
  },
  {
    value: 'claude-opus-4-7[1m]',
    label: 'Opus 4.7',
    resolvedModel: 'claude-opus-4-7',
    description: 'Opus 4.7 with 1M context',
    effortLevels: EFFORT_LEVELS,
  },
  {
    value: 'claude-opus-4-6[1m]',
    label: 'Opus 4.6',
    resolvedModel: 'claude-opus-4-6',
    description: 'Opus 4.6 with 1M context · No xhigh effort on this generation',
    effortLevels: EFFORT_NO_XHIGH,
  },
  {
    value: 'claude-sonnet-4-6[1m]',
    label: 'Sonnet 4.6',
    resolvedModel: 'claude-sonnet-4-6',
    description: 'Sonnet 4.6 with 1M context · No xhigh effort on this generation',
    effortLevels: EFFORT_NO_XHIGH,
  },
];

/**
 * What the model switcher shows before any session has opened.
 *
 * The real list comes from the installed Claude Code (`supportedModels()`), which
 * is the only thing that actually knows what this machine can reach — but that
 * needs a live query, and the cockpit can be sitting at a worktree it has never
 * prompted. So the switcher opens on this and swaps itself for the live catalogue
 * the moment a session exists. Keep it short: it is a placeholder, not a policy.
 *
 * The values here are the CLI's *aliases*, not wire ids, because that is what the
 * live catalogue returns — matching it means the swap is invisible rather than a
 * set of rows that all quietly reshuffle the moment a session opens.
 */
export const FALLBACK_MODELS: ModelChoice[] = [
  {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    resolvedModel: 'claude-opus-5[1m]',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    effortLevels: EFFORT_LEVELS,
  },
  {
    value: 'claude-fable-5[1m]',
    label: 'Fable',
    resolvedModel: 'claude-fable-5',
    description: 'Fable 5 · Most capable for your hardest and longest-running tasks',
    effortLevels: EFFORT_LEVELS,
  },
  {
    value: 'sonnet',
    label: 'Sonnet',
    resolvedModel: 'claude-sonnet-5',
    description: 'Sonnet 5 · Efficient for routine tasks',
    effortLevels: EFFORT_LEVELS,
  },
  {
    value: 'haiku',
    label: 'Haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    description: 'Haiku 4.5 · Fastest for quick answers',
    effortLevels: [],
  },
];

export type CockpitSettings = {
  /**
   * Model id every worktree starts on, or '' to take the CLI's default. The
   * composer's switcher pins a model *per worktree* and wins over this — this is
   * the floor under a worktree that has never been pinned.
   */
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
   * (`$COCKPIT_WORKTREE_CREATE_HOOK`, else `npm install`).
   *
   * Receives the worktree's newly assigned port as `COCKPIT_PORT` and `PORT`, so
   * a project that needs the port baked into a file — an `.env`, a compose
   * override — can write it here, at the one moment the worktree is new.
   */
  worktreeCreateHook: string;
  /**
   * Lowest port handed out to a worktree. Each one gets its own, counting up
   * from here, so two worktrees can serve at the same time without colliding.
   */
  portBase: number;
  /**
   * The app's accent color — id from `HIGHLIGHT_COLORS`, set from the app menu
   * (View → Highlight Color). Stored as an id rather than a hex so a future
   * change to the palette's shades doesn't strand old settings rows.
   */
  highlightColor: string;
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
  highlightColor: DEFAULT_HIGHLIGHT_COLOR,
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
    highlightColor: isHighlightColorId(input.highlightColor)
      ? input.highlightColor
      : DEFAULT_SETTINGS.highlightColor,
  };
}
