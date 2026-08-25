import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent } from '../src/agent/protocol';
import type { AgentRunRequest, CockpitBridge } from '../src/bridge';

const bridge: CockpitBridge = {
  worktrees: {
    list: () => ipcRenderer.invoke('worktrees:list'),
    create: (branch: string) => ipcRenderer.invoke('worktrees:create', branch),
  },
  agent: {
    run: (req: AgentRunRequest, onEvent: (event: AgentEvent) => void) => {
      const runId = crypto.randomUUID();
      const channel = `agent:event:${runId}`;
      const listener = (_e: unknown, event: AgentEvent) => onEvent(event);
      ipcRenderer.on(channel, listener);
      return ipcRenderer
        .invoke('agent:run', { ...req, runId })
        .finally(() => ipcRenderer.removeListener(channel, listener));
    },
    interrupt: (cwd: string) => ipcRenderer.invoke('agent:interrupt', cwd),
    reset: (cwd: string) => ipcRenderer.invoke('agent:reset', cwd),
  },
  store: {
    transcript: (cwd: string) => ipcRenderer.invoke('store:transcript', cwd),
    clearTranscript: (cwd: string) => ipcRenderer.invoke('store:clearTranscript', cwd),
    selectedWorktree: () => ipcRenderer.invoke('store:selectedWorktree'),
    setSelectedWorktree: (cwd: string | null) =>
      ipcRenderer.invoke('store:setSelectedWorktree', cwd),
  },
};

contextBridge.exposeInMainWorld('cockpit', bridge);
