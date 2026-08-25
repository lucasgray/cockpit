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
    /** Unified `git diff` of the worktree's uncommitted changes (+ new files). */
    diff: (cwd: string) => Promise<string>;
  };
  agent: {
    run: (req: AgentRunRequest, onEvent: (event: AgentEvent) => void) => Promise<void>;
    interrupt: (cwd: string) => Promise<void>;
    reset: (cwd: string) => Promise<void>;
  };
  /**
   * The app's own SQLite state, in the main process. Transcripts are kept as the
   * `AgentEvent` stream rather than rendered markup, so a restored conversation
   * survives any change to how the UI draws a turn.
   */
  store: {
    transcript: (cwd: string) => Promise<AgentEvent[]>;
    clearTranscript: (cwd: string) => Promise<void>;
    selectedWorktree: () => Promise<string | null>;
    setSelectedWorktree: (cwd: string | null) => Promise<void>;
  };
};

declare global {
  interface Window {
    cockpit?: CockpitBridge;
  }
}
