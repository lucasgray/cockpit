import net from 'node:net';
import { DEFAULT_PORT } from '../src/runConfig';
import { getStore } from './store';

/**
 * One dev-server port per worktree, so two of them can run at once.
 *
 * Assignments are sticky — stored, not recomputed — because a port that moves
 * between restarts is worse than no port at all: bookmarks rot and a stale
 * process is impossible to attribute to the branch that started it.
 */

/** How far above the base to look before giving up. */
const PROBE_RANGE = 200;

/**
 * Can we actually bind this port right now?
 *
 * `exclusive` matters: without it a port already bound by another process on a
 * different address can still accept the listen, and the probe would lie.
 */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

/**
 * The worktree's port, assigning one on first ask.
 *
 * An existing assignment is returned without probing — by the time a run is
 * underway its own server holds the port, and a probe would report it taken and
 * hand out a second one.
 */
export async function ensurePort(cwd: string): Promise<number> {
  const store = getStore();

  const existing = store.port(cwd);
  if (existing) return existing;

  const base = store.settings().portBase || DEFAULT_PORT;
  const taken = new Set(store.assignedPorts());

  for (let port = base; port < base + PROBE_RANGE; port++) {
    if (taken.has(port)) continue;
    if (!(await isPortFree(port))) continue;
    try {
      store.setPort(cwd, port);
      return port;
    } catch {
      // Lost a race for the UNIQUE column — try the next one up.
    }
  }

  // Nothing free in range. Hand back the base and let the dev server's own
  // strict-port check fail loudly, rather than quietly binding something else.
  return base;
}
