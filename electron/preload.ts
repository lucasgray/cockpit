import { contextBridge, ipcRenderer } from 'electron';
import type { CockpitBridge } from '../src/bridge';

const bridge: CockpitBridge = {
  worktrees: {
    list: () => ipcRenderer.invoke('worktrees:list'),
  },
};

contextBridge.exposeInMainWorld('cockpit', bridge);
