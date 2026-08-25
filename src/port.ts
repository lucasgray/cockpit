/**
 * The port a cockpit window and its vite server agree on.
 *
 * One cockpit can be started from another — a worktree opened as its own app —
 * and each gets its own port so the windows don't fight over one address. The
 * assignment itself lives in the main process (`electron/ports.ts`); this is the
 * shared reader for it.
 */

/** Port used when the cockpit has assigned nothing. */
export const DEFAULT_PORT = 5273;

/**
 * The port to bind, read from the env the cockpit injects.
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
