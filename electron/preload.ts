import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent } from '../src/agent/protocol';
import type { AgentRunRequest, CockpitBridge, WorktreeHookResult } from '../src/bridge';
import type { CockpitSettings, EffortChoice } from '../src/settings';
import type { RunEvent } from '../src/runConfig';

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
  pr: {
    status: (cwd: string) => ipcRenderer.invoke('pr:status', cwd),
    open: (cwd: string) => ipcRenderer.invoke('pr:open', cwd),
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
    models: () => ipcRenderer.invoke('agent:models'),
  },
  files: {
    list: (cwd: string, dir: string) => ipcRenderer.invoke('files:list', cwd, dir),
    stamps: (cwd: string, dirs: string[]) => ipcRenderer.invoke('files:stamps', cwd, dirs),
    read: (cwd: string, path: string) => ipcRenderer.invoke('files:read', cwd, path),
    write: (cwd: string, path: string, text: string, mtime: number) =>
      ipcRenderer.invoke('files:write', { cwd, path, text, mtime }),
  },
  run: {
    detect: (cwd: string) => ipcRenderer.invoke('run:detect', cwd),
    start: (cwd: string, command?: string) => ipcRenderer.invoke('run:start', cwd, command),
    stop: (cwd: string) => ipcRenderer.invoke('run:stop', cwd),
    status: (cwd: string) => ipcRenderer.invoke('run:status', cwd),
    // One long-lived channel rather than the agent's per-run one: a run outlives
    // any single call, and the button subscribes once for the window's lifetime.
    onEvent: (listener: (event: RunEvent) => void) => {
      const wrapped = (_e: unknown, event: RunEvent) => listener(event);
      ipcRenderer.on('run:event', wrapped);
      return () => ipcRenderer.removeListener('run:event', wrapped);
    },
  },
  store: {
    transcript: (cwd: string) => ipcRenderer.invoke('store:transcript', cwd),
    clearTranscript: (cwd: string) => ipcRenderer.invoke('store:clearTranscript', cwd),
    selectedWorktree: () => ipcRenderer.invoke('store:selectedWorktree'),
    setSelectedWorktree: (cwd: string | null) =>
      ipcRenderer.invoke('store:setSelectedWorktree', cwd),
    openFiles: (cwd: string) => ipcRenderer.invoke('store:openFiles', cwd),
    setOpenFiles: (cwd: string, open: string[], active: string | null) =>
      ipcRenderer.invoke('store:setOpenFiles', cwd, open, active),
    draft: (cwd: string) => ipcRenderer.invoke('store:draft', cwd),
    setDraft: (cwd: string, text: string) => ipcRenderer.invoke('store:setDraft', cwd, text),
    thinking: (cwd: string) => ipcRenderer.invoke('store:thinking', cwd),
    setThinking: (cwd: string, on: boolean) => ipcRenderer.invoke('store:setThinking', cwd, on),
    model: (cwd: string) => ipcRenderer.invoke('store:model', cwd),
    setModel: (cwd: string, model: string) => ipcRenderer.invoke('store:setModel', cwd, model),
    effort: (cwd: string) => ipcRenderer.invoke('store:effort', cwd),
    setEffort: (cwd: string, effort: EffortChoice) =>
      ipcRenderer.invoke('store:setEffort', cwd, effort),
    railView: () => ipcRenderer.invoke('store:railView'),
    setRailView: (view: string) => ipcRenderer.invoke('store:setRailView', view),
    settings: () => ipcRenderer.invoke('store:settings'),
    saveSettings: (patch: Partial<CockpitSettings>) =>
      ipcRenderer.invoke('store:saveSettings', patch),
    onHighlightColorChange: (listener: (id: string) => void) => {
      const wrapped = (_e: unknown, id: string) => listener(id);
      ipcRenderer.on('settings:highlightColor', wrapped);
      return () => ipcRenderer.removeListener('settings:highlightColor', wrapped);
    },
  },
};

contextBridge.exposeInMainWorld('cockpit', bridge);
