import { defineConfig } from 'vite';
import { anthropicAgentPlugin } from './src/agent/backend';

export default defineConfig({
  server: { port: 5273 },
  plugins: [anthropicAgentPlugin()],
});
