import type { AgentEvent } from './agent/protocol';
import type { CockpitSettings } from './settings';

export type Worktree = {
  path: string;
  name: string;
  branch: string;
  head: string;
  isMain: boolean;
  dirty: boolean;
  /** Uncommitted line counts, new files included. Both 0 on a clean worktree. */
  added: number;
  removed: number;
  /** This worktree's own dev-server port, so siblings don't collide. */
  port: number;
};

export type AgentRunRequest = {
  prompt: string;
  cwd: string;
};

export type WorktreeCreateResult = {
  ok: boolean;
  path?: string;
  branch?: string;
  /** The port assigned to the new worktree, before its create hook ran. */
  port?: number;
  error?: string;
};

export type WorktreeRemoveResult = {
  ok: boolean;
  error?: string;
};

/** How a worktree's create hook finished. Arrives well after `create` resolves. */
export type WorktreeHookResult = {
  cwd: string;
  branch: string;
  command: string;
  port: number;
  /** Exit code, or null when the hook could not be spawned at all. */
  code: number | null;
  /** Last few KB of combined output — enough to see why a hook failed. */
  tail: string;
  error?: string;
};

export type CockpitBridge = {
  worktrees: {
    list: () => Promise<Worktree[]>;
    create: (branch: string) => Promise<WorktreeCreateResult>;
    /** Unified `git diff` of the worktree's uncommitted changes (+ new files). */
    diff: (cwd: string) => Promise<string>;
    /** Delete a non-main worktree and its branch, throwing the work away. */
    remove: (cwd: string) => Promise<WorktreeRemoveResult>;
    /** Subscribe to create-hook completions. Returns an unsubscribe function. */
    onHook: (listener: (result: WorktreeHookResult) => void) => () => void;
  };
  agent: {
    run: (req: AgentRunRequest, onEvent: (event: AgentEvent) => void) => Promise<void>;
    interrupt: (cwd: string) => Promise<void>;
    /** Answer a pending `question` event, unblocking the ask tool's turn. */
    answer: (cwd: string, id: string, selection: string) => Promise<void>;
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
    settings: () => Promise<CockpitSettings>;
    saveSettings: (patch: Partial<CockpitSettings>) => Promise<CockpitSettings>;
  };
};

declare global {
  interface Window {
    cockpit?: CockpitBridge;
  }
}
