import { defineConfig } from 'vite';
import { anthropicAgentPlugin } from './src/agent/backend';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    // Auto-reload is OFF on purpose: the app hosts live Claude sessions, and an
    // automatic reload restarts them mid-turn. Polling still runs so the module
    // graph stays current — a deliberate ⌘R picks up renderer edits fresh —
    // but nothing reloads on its own. (FSEvents is dead here, hence polling.)
    hmr: false,
    watch: { usePolling: true, interval: 300 },
  },
  plugins: [anthropicAgentPlugin()],
});
