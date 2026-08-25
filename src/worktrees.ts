import type { Worktree, WorktreeRemoveResult } from './bridge';

/**
 * Survives reloads and app restarts so the rail comes back where you left it.
 * Kept in the app's own store rather than localStorage, which is scoped to the
 * page origin — that differs between the dev server and a packaged build, so
 * anything kept there quietly vanishes the first time the app ships.
 */
async function readStoredPath(): Promise<string | null> {
  return (await window.cockpit?.store.selectedWorktree()) ?? null;
}

function writeStoredPath(path: string | null) {
  window.cockpit?.store.setSelectedWorktree(path);
}

export class WorktreeRail {
  private container: HTMLElement;
  private onSelect: (wt: Worktree) => void;
  private onRemoved: (path: string) => void;
  private activePath: string | null = null;
  private worktrees: Worktree[] = [];
  /** The worktree showing its delete confirmation, if any. */
  private confirmPath: string | null = null;
  /** Set while a removal is in flight, so the rail can't be acted on twice. */
  private busy: { path: string; label: string } | null = null;
  private error: { path: string; message: string } | null = null;
  /** The worktree whose agent turn is in flight — its dot pulses. */
  private runningPath: string | null = null;
  /** Live status dots by worktree path, so a turn starting can repaint just
   * those without re-rendering the rail out from under an open input. */
  private dots = new Map<string, HTMLElement>();

  constructor(
    container: HTMLElement,
    onSelect: (wt: Worktree) => void,
    onRemoved: (path: string) => void,
  ) {
    this.container = container;
    this.onSelect = onSelect;
    this.onRemoved = onRemoved;
  }

  async load() {
    if (!window.cockpit) {
      this.container.innerHTML = `<div class="rail-note">Worktrees load in the desktop app.<br />Run <code>npm run app</code>.</div>`;
      return;
    }
    this.container.innerHTML = `<div class="rail-note">Loading worktrees…</div>`;
    try {
      this.worktrees = await window.cockpit.worktrees.list();
      await this.restoreSelection();
      this.render();
    } catch (error) {
      this.container.innerHTML = `<div class="rail-note">⚠ ${String(error)}</div>`;
    }
  }

  /** Re-select the worktree from the last session, once its path still exists. */
  private async restoreSelection() {
    if (this.activePath && this.worktrees.some((wt) => wt.path === this.activePath)) return;
    const stored = await readStoredPath();
    if (!stored) return;
    const wt = this.worktrees.find((candidate) => candidate.path === stored);
    if (!wt) {
      // The worktree is gone since last run; clear the stale pointer.
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

  /**
   * Mark which worktree has a turn in flight. Patches the affected dots in
   * place instead of re-rendering: a turn can start or end while the "+ New
   * worktree" input is open, and a re-render would throw that input away.
   */
  setRunning(path: string | null) {
    if (this.runningPath === path) return;
    const changed = [this.runningPath, path].filter((p): p is string => p !== null);
    this.runningPath = path;
    for (const p of changed) {
      const dot = this.dots.get(p);
      const wt = this.worktrees.find((candidate) => candidate.path === p);
      if (dot && wt) this.paintDot(dot, wt);
    }
  }

  private render() {
    this.container.innerHTML = '';
    this.dots.clear();
    this.container.append(this.newControl());
    for (const wt of this.worktrees) this.container.append(this.row(wt));
  }

  /**
   * One rail entry. The row is a container rather than a single button so the
   * status/remove gutter can sit inside it without nesting interactive
   * elements. That gutter is a fixed-width column present on every row —
   * including main, which has no ✕ — so the dots line up down one edge.
   */
  private row(wt: Worktree): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wt-row';

    if (this.busy?.path === wt.path) {
      row.classList.add('pending');
      const note = document.createElement('div');
      note.className = 'wt-pending';
      note.textContent = `${this.busy.label}…`;
      row.append(note);
      return row;
    }

    const item = document.createElement('button');
    item.className = 'wt' + (wt.path === this.activePath ? ' active' : '');
    item.innerHTML = `
      <div class="wt-top">
        <span class="wt-name">${wt.name}</span>
        ${wt.isMain ? '<span class="wt-badge">main</span>' : ''}
      </div>
      <div class="wt-branch">${wt.branch}</div>`;
    item.addEventListener('click', () => {
      this.confirmPath = null;
      this.activePath = wt.path;
      writeStoredPath(wt.path);
      this.render();
      this.onSelect(wt);
    });
    row.append(item);
    row.append(this.gutter(wt));

    if (this.confirmPath === wt.path) {
      row.classList.add('confirming');
      row.append(this.confirmControls(wt));
    }
    if (this.error?.path === wt.path) {
      const err = document.createElement('div');
      err.className = 'wt-error';
      err.textContent = `⚠ ${this.error.message}`;
      row.append(err);
    }
    return row;
  }

  /** The right-hand column: status dot on top, ✕ directly underneath it. */
  private gutter(wt: Worktree): HTMLElement {
    const col = document.createElement('div');
    col.className = 'wt-gutter';

    // The slot is a fixed height so the dot centres on the name line whether or
    // not the row carries a badge.
    const slot = document.createElement('div');
    slot.className = 'wt-status';
    const dot = document.createElement('span');
    this.paintDot(dot, wt);
    this.dots.set(wt.path, dot);
    slot.append(dot);
    col.append(slot);

    // The main checkout is where the branches land — never removable from here.
    if (!wt.isMain) {
      const remove = document.createElement('button');
      remove.className = 'wt-remove';
      remove.textContent = '✕';
      remove.title = 'Remove this worktree';
      remove.addEventListener('click', () => {
        this.confirmPath = this.confirmPath === wt.path ? null : wt.path;
        this.error = null;
        this.render();
      });
      col.append(remove);
    }
    return col;
  }

  /**
   * The dot is the worktree's state at a glance: pulsing while its agent is
   * mid-turn, filled when the tree has uncommitted work, hollow when it's
   * clean and idle. It's always drawn — an empty slot would break the column.
   */
  private paintDot(dot: HTMLElement, wt: Worktree) {
    const running = this.runningPath === wt.path;
    const state = running ? 'running' : wt.dirty ? 'dirty' : 'clean';
    dot.className = `wt-dot ${state}`;
    dot.title = running
      ? 'agent is working'
      : wt.dirty
        ? 'uncommitted changes'
        : 'clean — no uncommitted changes';
  }

  /** Deleting a worktree drops its branch and any uncommitted work — so confirm. */
  private confirmControls(wt: Worktree): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wt-confirm';

    const note = document.createElement('span');
    note.className = 'wt-confirm-note';
    note.textContent = wt.dirty ? 'Delete, losing uncommitted work?' : 'Delete worktree?';

    const confirm = document.createElement('button');
    confirm.className = 'wt-confirm-btn discard';
    confirm.textContent = 'Delete';
    confirm.title = `Removes the worktree and deletes branch ${wt.branch}`;
    confirm.addEventListener('click', () => void this.remove(wt));

    wrap.append(note, confirm);
    return wrap;
  }

  private async remove(wt: Worktree) {
    if (this.busy) return;
    this.confirmPath = null;
    this.error = null;
    this.busy = { path: wt.path, label: 'deleting' };
    this.render();

    // `busy` clears in the finally no matter what: an IPC call that rejects —
    // a stale main process with no handler for this channel, say — would
    // otherwise leave the row spinning forever with nothing to explain it.
    let res: WorktreeRemoveResult;
    try {
      res = await window.cockpit!.worktrees.remove(wt.path);
    } catch (error) {
      res = { ok: false, error: String(error) };
    } finally {
      this.busy = null;
    }

    if (!res.ok) {
      this.error = { path: wt.path, message: res.error ?? 'failed' };
      this.render();
      return;
    }

    // Its transcript and session went with it; fall back to main so the
    // composer is never pointed at a directory that no longer exists.
    this.onRemoved(wt.path);
    const wasActive = this.activePath === wt.path;
    if (wasActive) {
      this.activePath = null;
      writeStoredPath(null);
    }
    try {
      this.worktrees = await window.cockpit!.worktrees.list();
    } catch {
      // Drop it from the list we already have rather than stranding the rail.
      this.worktrees = this.worktrees.filter((candidate) => candidate.path !== wt.path);
    }
    const main = this.worktrees.find((candidate) => candidate.isMain);
    if (wasActive && main) {
      this.activePath = main.path;
      writeStoredPath(main.path);
      this.onSelect(main);
    }
    this.render();
  }

  /** The "+ New worktree" affordance that expands into a branch-name input. */
  private newControl(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wt-new';
    const btn = document.createElement('button');
    btn.className = 'wt-new-btn';
    btn.textContent = '+ New worktree';
    btn.disabled = !window.cockpit;
    btn.addEventListener('click', () => this.showNewInput(wrap));
    wrap.append(btn);
    return wrap;
  }

  private showNewInput(wrap: HTMLElement) {
    wrap.innerHTML = '';
    const input = document.createElement('input');
    input.className = 'wt-new-input';
    input.placeholder = 'new branch name…';
    wrap.append(input);
    input.focus();

    const submit = async () => {
      const branch = input.value.trim();
      if (!branch) return this.render();
      input.disabled = true;
      input.value = '';
      input.placeholder = 'creating worktree…';
      const res = await window.cockpit!.worktrees.create(branch);
      if (!res.ok) {
        input.disabled = false;
        input.placeholder = `⚠ ${res.error ?? 'failed'}`;
        input.focus();
        return;
      }
      await this.load();
      const created = this.worktrees.find((w) => w.path === res.path);
      if (created) {
        this.activePath = created.path;
        this.render();
        this.onSelect(created);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit();
      else if (e.key === 'Escape') this.render();
    });
    input.addEventListener('blur', () => {
      if (!input.disabled) this.render();
    });
  }
}
