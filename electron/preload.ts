import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent } from '../src/agent/protocol';
import type { AgentRunRequest, CockpitBridge, WorktreeHookResult } from '../src/bridge';
import type { CockpitSettings } from '../src/settings';

const bridge: CockpitBridge = {
  worktrees: {
    list: () => ipcRenderer.invoke('worktrees:list'),
    create: (branch: string) => ipcRenderer.invoke('worktrees:create', branch),
    diff: (cwd: string) => ipcRenderer.invoke('worktrees:diff', cwd),
    remove: (cwd: string) => ipcRenderer.invoke('worktrees:remove', cwd),
    // The create hook finishes long after `create` resolves, so its result
    // arrives on its own channel rather than as a return value.
    onHook: (listener: (result: WorktreeHookResult) => void) => {
      const wrapped = (_e: unknown, result: WorktreeHookResult) => listener(result);
      ipcRenderer.on('worktrees:hook', wrapped);
      return () => ipcRenderer.removeListener('worktrees:hook', wrapped);
    },
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
    answer: (cwd: string, id: string, selection: string) =>
      ipcRenderer.invoke('agent:answer', { cwd, id, selection }),
  },
  store: {
    transcript: (cwd: string) => ipcRenderer.invoke('store:transcript', cwd),
    clearTranscript: (cwd: string) => ipcRenderer.invoke('store:clearTranscript', cwd),
    selectedWorktree: () => ipcRenderer.invoke('store:selectedWorktree'),
    setSelectedWorktree: (cwd: string | null) =>
      ipcRenderer.invoke('store:setSelectedWorktree', cwd),
    settings: () => ipcRenderer.invoke('store:settings'),
    saveSettings: (patch: Partial<CockpitSettings>) =>
      ipcRenderer.invoke('store:saveSettings', patch),
  },
};

contextBridge.exposeInMainWorld('cockpit', bridge);
