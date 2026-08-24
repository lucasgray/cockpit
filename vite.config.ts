import { defineConfig } from 'vite';
import { anthropicAgentPlugin } from './src/agent/backend';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    // FSEvents is exhausted on this machine, so Vite's watcher goes deaf and
    // HMR never fires. Poll instead so renderer edits hot-reload live.
    watch: { usePolling: true, interval: 300 },
  },
  plugins: [anthropicAgentPlugin()],
});
