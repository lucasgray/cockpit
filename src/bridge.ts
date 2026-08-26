import type { AgentEvent } from './agent/protocol';
import type { CockpitSettings } from './settings';
import type { RunCommand, RunEvent, RunStatus } from './runConfig';

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

/** One row in the file tree. `path` is relative to the worktree, POSIX-style. */
export type FileEntry = {
  name: string;
  path: string;
  kind: 'dir' | 'file';
};

export type FileContents = {
  path: string;
  text: string;
  bytes: number;
  /** Why `text` is empty, when it is — the viewer says so instead of drawing it. */
  reason?: 'binary' | 'too-large';
  /**
   * mtime at the moment of the read, echoed back on write. The agent edits these
   * same files, so a save has to be able to tell it isn't clobbering a newer one.
   */
  mtime: number;
};

export type FileWriteResult = {
  ok: boolean;
  mtime?: number;
  /** The file changed under us — the operator chooses reload or overwrite. */
  conflict?: boolean;
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
   * Browsing and editing what a worktree holds. Every path is relative to the
   * worktree root, and the main process refuses anything that resolves outside
   * it — this is a file API for the tree, not for the disk.
   */
  files: {
    /** One directory's entries. Lazy: the tree asks again on each expand. */
    list: (cwd: string, dir: string) => Promise<FileEntry[]>;
    /**
     * When each of these directories last changed shape, by relative path — a
     * stat apiece, so the tree can poll for added and deleted files and only
     * re-list what actually moved. A missing directory reads as 0.
     */
    stamps: (cwd: string, dirs: string[]) => Promise<Record<string, number>>;
    read: (cwd: string, path: string) => Promise<FileContents>;
    /** `mtime` is the one from the matching `read`; a newer file is a conflict. */
    write: (cwd: string, path: string, text: string, mtime: number) => Promise<FileWriteResult>;
  };
  /**
   * Starting the project a worktree holds — one run per worktree, concurrently,
   * each on its own assigned port. Starting one already up restarts it.
   *
   * A run has no pane of its own: it serves on a port, and the browser is where
   * you look at it. All the UI carries is the button's state and, when a run
   * dies, the line it died on.
   */
  run: {
    /** The command that would run, and where it was resolved from. */
    detect: (cwd: string) => Promise<RunCommand>;
    /** Start in `cwd`; `command` overrides resolution for this run only. */
    start: (cwd: string, command?: string) => Promise<RunStatus>;
    stop: (cwd: string) => Promise<RunStatus>;
    status: (cwd: string) => Promise<RunStatus>;
    /** Subscribe to status changes in every worktree. Returns unsubscribe. */
    onEvent: (listener: (event: RunEvent) => void) => () => void;
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
    /** The file each worktree had open, so the app reopens where it was left. */
    openFile: (cwd: string) => Promise<string | null>;
    setOpenFile: (cwd: string, path: string | null) => Promise<void>;
    /** Which left-rail tab was showing: 'worktrees' or 'explorer'. */
    railView: () => Promise<string | null>;
    setRailView: (view: string) => Promise<void>;
    settings: () => Promise<CockpitSettings>;
    saveSettings: (patch: Partial<CockpitSettings>) => Promise<CockpitSettings>;
  };
};

declare global {
  interface Window {
    cockpit?: CockpitBridge;
  }
}
