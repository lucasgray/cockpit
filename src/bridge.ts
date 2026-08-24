export type Worktree = {
  path: string;
  name: string;
  branch: string;
  head: string;
  isMain: boolean;
  dirty: boolean;
};

export type CockpitBridge = {
  worktrees: {
    list: () => Promise<Worktree[]>;
  };
};

declare global {
  interface Window {
    cockpit?: CockpitBridge;
  }
}
