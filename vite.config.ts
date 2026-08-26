import { defineConfig } from 'vite';
import { resolvePort } from './src/port';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    // The cockpit assigns each worktree its own port and injects it as
    // COCKPIT_PORT, so sibling worktrees can serve at the same time. Falls back
    // to the default when run by hand.
    port: resolvePort(process.env),
    // Left strict on purpose: if the assigned port is taken, failing loudly is
    // better than silently serving on another one the window won't be pointed at.
    strictPort: true,
    // Auto-reload is OFF on purpose: the app hosts live Claude sessions, and an
    // automatic reload restarts them mid-turn. Polling still runs so the module
    // graph stays current — a deliberate ⌘R picks up renderer edits fresh —
    // but nothing reloads on its own. (FSEvents is dead here, hence polling.)
    hmr: false,
    watch: { usePolling: true, interval: 300 },
  },
});
