import type { Worktree } from './bridge';

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
      this.render();
    } catch (error) {
      this.container.innerHTML = `<div class="rail-note">⚠ ${String(error)}</div>`;
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
        this.render();
        this.onSelect(wt);
      });
      this.container.append(item);
    }
  }
}
