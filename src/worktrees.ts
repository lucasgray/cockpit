import type { Worktree } from './bridge';

/** Survives reloads and app restarts so the rail comes back where you left it. */
const SELECTED_KEY = 'cockpit.selectedWorktree';

function readStoredPath(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function writeStoredPath(path: string | null) {
  try {
    if (path === null) localStorage.removeItem(SELECTED_KEY);
    else localStorage.setItem(SELECTED_KEY, path);
  } catch {
    // Private mode / storage disabled — selection just won't persist.
  }
}

export class WorktreeRail {
  private container: HTMLElement;
  private onSelect: (wt: Worktree) => void;
  private activePath: string | null = null;
  private worktrees: Worktree[] = [];

  constructor(container: HTMLElement, onSelect: (wt: Worktree) => void) {
    this.container = container;
    this.onSelect = onSelect;
  }

  async load() {
    if (!window.cockpit) {
      this.container.innerHTML = `<div class="rail-note">Worktrees load in the desktop app.<br />Run <code>npm run app</code>.</div>`;
      return;
    }
    this.container.innerHTML = `<div class="rail-note">Loading worktrees…</div>`;
    try {
      this.worktrees = await window.cockpit.worktrees.list();
      this.restoreSelection();
      this.render();
    } catch (error) {
      this.container.innerHTML = `<div class="rail-note">⚠ ${String(error)}</div>`;
    }
  }

  /** Re-select the worktree from the last session, once its path still exists. */
  private restoreSelection() {
    if (this.activePath && this.worktrees.some((wt) => wt.path === this.activePath)) return;
    const stored = readStoredPath();
    if (!stored) return;
    const wt = this.worktrees.find((candidate) => candidate.path === stored);
    if (!wt) {
      // The worktree was removed since last run; don't keep chasing it.
      writeStoredPath(null);
      return;
    }
    this.activePath = wt.path;
    this.onSelect(wt);
  }

  /** Re-read git state (dirty flags, new branches) without dropping selection. */
  async refresh() {
    if (!window.cockpit) return;
    try {
      this.worktrees = await window.cockpit.worktrees.list();
      this.render();
    } catch {
      // Keep the last good list rather than blanking the rail.
    }
  }

  private render() {
    this.container.innerHTML = '';
    for (const wt of this.worktrees) {
      const item = document.createElement('button');
      item.className = 'wt' + (wt.path === this.activePath ? ' active' : '');
      item.innerHTML = `
        <div class="wt-top">
          <span class="wt-name">${wt.name}</span>
          ${wt.isMain ? '<span class="wt-badge">main</span>' : ''}
          ${wt.dirty ? '<span class="wt-dirty" title="uncommitted changes"></span>' : ''}
        </div>
        <div class="wt-branch">${wt.branch}</div>`;
      item.addEventListener('click', () => {
        this.activePath = wt.path;
        writeStoredPath(wt.path);
        this.render();
        this.onSelect(wt);
      });
      this.container.append(item);
    }
  }
}
