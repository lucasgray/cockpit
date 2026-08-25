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

export type WorktreeCreateResult = {
  ok: boolean;
  path?: string;
  branch?: string;
  error?: string;
};

export type CockpitBridge = {
  worktrees: {
    list: () => Promise<Worktree[]>;
    create: (branch: string) => Promise<WorktreeCreateResult>;
  };
  agent: {
    run: (req: AgentRunRequest, onEvent: (event: AgentEvent) => void) => Promise<void>;
    interrupt: (cwd: string) => Promise<void>;
    reset: (cwd: string) => Promise<void>;
  };
};

declare global {
  interface Window {
    cockpit?: CockpitBridge;
  }
}
