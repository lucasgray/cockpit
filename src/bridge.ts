import type { AgentEvent } from './agent/protocol';

export type Worktree = {
  path: string;
  name: string;
  branch: string;
  head: string;
  isMain: boolean;
  dirty: boolean;
};

export type AgentRunRequest = {
  prompt: string;
  cwd: string;
};

export type CockpitBridge = {
  worktrees: {
    list: () => Promise<Worktree[]>;
  };
  agent: {
    run: (req: AgentRunRequest, onEvent: (event: AgentEvent) => void) => Promise<void>;
  };
};

declare global {
  interface Window {
    cockpit?: CockpitBridge;
  }
}
