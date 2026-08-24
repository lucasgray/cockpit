import { defineConfig } from 'vite';
import { anthropicAgentPlugin } from './src/agent/backend';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5273, strictPort: true },
  plugins: [anthropicAgentPlugin()],
});
