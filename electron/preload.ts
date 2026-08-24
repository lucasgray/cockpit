import { contextBridge, ipcRenderer } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../src/agent/protocol';
import type { AgentRunRequest, CockpitBridge } from '../src/bridge';

const bridge: CockpitBridge = {
  worktrees: {
    list: () => ipcRenderer.invoke('worktrees:list'),
  },
  agent: {
    run: (req: AgentRunRequest, onEvent: (event: AgentEvent) => void) => {
      const runId = randomUUID();
      const channel = `agent:event:${runId}`;
      const listener = (_e: unknown, event: AgentEvent) => onEvent(event);
      ipcRenderer.on(channel, listener);
      return ipcRenderer
        .invoke('agent:run', { ...req, runId })
        .finally(() => ipcRenderer.removeListener(channel, listener));
    },
  },
};

contextBridge.exposeInMainWorld('cockpit', bridge);
