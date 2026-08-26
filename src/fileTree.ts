import type { FileEntry, Worktree } from './bridge';

/**
 * The Files rail: the active worktree's directory tree, one lazily-listed
 * directory at a time.
 *
 * Every worktree keeps its own expansion and selection, so switching away and
 * back lands on the same view rather than a collapsed root — the rail is a place
 * you navigate, and losing your place on each worktree click would make it
 * useless for exactly the thing you'd use it for.
 *
 * Listing is lazy and cached per directory. Keeping that cache honest is the
 * whole problem: the agent creates and deletes files while you watch, so a tree
 * that only matched the moment you opened it goes stale within seconds.
 *
 * Two things keep it current. `refresh()` re-lists everything open, which a turn
 * ending in this worktree calls. Between those, a poll asks the main process only
 * for each open directory's mtime — a stat apiece, no readdir, no `git
 * check-ignore` — and re-lists just the directories whose shape actually moved,
 * so an added or deleted file shows up about a second after it happens rather
 * than at the end of the turn. The poll idles whenever the rail is on its other
 * tab; there's nothing to keep current that nobody is looking at.
 */

/** The root directory's key. Paths below it are relative and POSIX-separated. */
const ROOT = '';

/** How often the open directories are checked for added/removed entries. */
const SYNC_MS = 1_000;

type TreeState = {
  /** Directories currently open, by relative path. */
  expanded: Set<string>;
  selected: string | null;
  children: Map<string, FileEntry[]>;
  /** Why a directory wouldn't list, shown on the row that asked. */
  errors: Map<string, string>;
  /** Last mtime seen per listed directory — what the poll compares against. */
  stamps: Map<string, number>;
};

function newState(): TreeState {
  return {
    expanded: new Set(),
    selected: null,
    children: new Map(),
    errors: new Map(),
    stamps: new Map(),
  };
}

export class FileTree {
  private container: HTMLElement;
  private onOpen: (cwd: string, path: string) => void;
  private cwd: string | null = null;
  /** Per-worktree navigation state, keyed by worktree path. */
  private states = new Map<string, TreeState>();
  /** Directories with a listing in flight, so a double click doesn't double-list. */
  private loading = new Set<string>();
  /** A sync already in flight — ticks don't stack up behind a slow one. */
  private syncing = false;

  constructor(container: HTMLElement, onOpen: (cwd: string, path: string) => void) {
    this.container = container;
    this.onOpen = onOpen;
    window.setInterval(() => void this.sync(), SYNC_MS);
  }

  private state(): TreeState {
    if (!this.cwd) return newState();
    let state = this.states.get(this.cwd);
    if (!state) {
      state = newState();
      this.states.set(this.cwd, state);
    }
    return state;
  }

  /** Point the tree at a worktree, restoring whatever it was showing there. */
  async setWorktree(wt: Worktree | null) {
    this.cwd = wt?.path ?? null;
    this.render();
    if (this.cwd) await this.ensureDir(ROOT);
  }

  /** Forget a worktree's tree entirely — its directory no longer exists. */
  dropWorktree(cwd: string) {
    this.states.delete(cwd);
    if (this.cwd === cwd) {
      this.cwd = null;
      this.render();
    }
  }

  /** Re-list everything open, keeping the shape. Cheap enough to call on a turn end. */
  async refresh() {
    if (!this.cwd || !window.cockpit) return;
    const open = [ROOT, ...this.state().expanded];
    await Promise.all(open.map((dir) => this.ensureDir(dir, true)));
  }

  /**
   * One tick of the poll: re-list only the open directories whose mtime moved.
   *
   * The common case is that nothing did, and that case costs a stat per open
   * directory and no repaint at all — which is what makes running this every
   * second reasonable while the agent rewrites the worktree underneath it.
   */
  async sync() {
    if (this.syncing || this.container.hidden || !this.cwd || !window.cockpit) return;
    const cwd = this.cwd;
    const state = this.state();
    const open = [ROOT, ...state.expanded];

    this.syncing = true;
    try {
      const stamps = await window.cockpit.files.stamps(cwd, open);
      // The rail may have been pointed elsewhere while that was in flight.
      if (this.cwd !== cwd) return;

      const changed: string[] = [];
      let pruned = false;
      for (const dir of open) {
        const stamp = stamps[dir] ?? 0;
        if (stamp === state.stamps.get(dir)) continue;
        // Stamp 0 is a directory that is no longer there. Its parent's re-list
        // drops the row; forget the subtree so it stops being polled for.
        if (!stamp && dir !== ROOT) {
          state.expanded.delete(dir);
          state.children.delete(dir);
          state.stamps.delete(dir);
          pruned = true;
        } else {
          changed.push(dir);
        }
      }
      if (changed.length) await Promise.all(changed.map((dir) => this.ensureDir(dir, true)));
      else if (pruned) this.render();
    } catch {
      // A worktree deleted mid-flight, mostly. The next tick sorts it out.
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Expand down to `file` and select it, without opening it — how a remembered
   * file from the last session comes back highlighted in the tree it lives in.
   */
  async reveal(file: string) {
    if (!this.cwd) return;
    const state = this.state();
    const parts = file.split('/').slice(0, -1);
    let dir = ROOT;
    for (const part of parts) {
      dir = dir ? `${dir}/${part}` : part;
      state.expanded.add(dir);
    }
    state.selected = file;
    // Sequential: each level has to be listed before the next one is known to
    // exist, and a vanished directory should stop the walk rather than throw.
    let at = ROOT;
    await this.ensureDir(at);
    for (const part of parts) {
      at = at ? `${at}/${part}` : part;
      await this.ensureDir(at);
    }
    this.render();
  }

  /**
   * List a directory, then repaint. Errors land on the row that asked.
   *
   * `force` re-lists one already cached — and does it without dropping the old
   * entries first, so a re-list swaps the rows in place instead of blinking the
   * subtree through a "…" and back on every poll.
   */
  private async ensureDir(dir: string, force = false) {
    const cwd = this.cwd;
    if (!cwd || !window.cockpit) return;
    const state = this.state();
    if ((state.children.has(dir) && !force) || this.loading.has(`${cwd}:${dir}`)) return;

    this.loading.add(`${cwd}:${dir}`);
    try {
      // Stamped before the listing, never after: if the directory changes
      // between the two, the stamp is the older one and the next poll re-lists.
      // A wasted listing is the harmless direction to be wrong in; recording a
      // stamp newer than the entries it goes with would hide the change for good.
      const stamps = await window.cockpit.files.stamps(cwd, [dir]);
      const entries = await window.cockpit.files.list(cwd, dir);
      // The worktree may have been switched while this was in flight; the state
      // is keyed by path, so write it back to the one that asked either way.
      const asked = this.states.get(cwd);
      asked?.children.set(dir, entries);
      asked?.stamps.set(dir, stamps[dir] ?? 0);
      asked?.errors.delete(dir);
    } catch (error) {
      this.states.get(cwd)?.errors.set(dir, String(error));
    } finally {
      this.loading.delete(`${cwd}:${dir}`);
    }
    if (this.cwd === cwd) this.render();
  }

  private note(html: string) {
    this.container.innerHTML = `<div class="rail-note">${html}</div>`;
  }

  private render() {
    if (!window.cockpit) {
      this.note('Files load in the desktop app.<br />Run <code>npm run app</code>.');
      return;
    }
    if (!this.cwd) {
      this.note('Select a worktree to browse its files.');
      return;
    }

    const state = this.state();
    const rootError = state.errors.get(ROOT);
    if (rootError) {
      this.note(`⚠ ${rootError}`);
      return;
    }
    if (!state.children.has(ROOT)) {
      this.note('Loading files…');
      return;
    }

    const rows: HTMLElement[] = [];
    this.rowsFor(ROOT, 0, rows);
    this.container.replaceChildren(...rows);
  }

  /** Walk the cached tree, emitting a row per visible entry, depth-first. */
  private rowsFor(dir: string, depth: number, out: HTMLElement[]) {
    const state = this.state();
    const error = state.errors.get(dir);
    if (error) {
      out.push(this.messageRow(`⚠ ${error}`, depth));
      return;
    }

    const entries = state.children.get(dir);
    if (!entries) {
      out.push(this.messageRow('…', depth));
      return;
    }
    if (!entries.length) {
      out.push(this.messageRow('empty', depth));
      return;
    }

    for (const entry of entries) {
      out.push(this.row(entry, depth));
      if (entry.kind === 'dir' && state.expanded.has(entry.path)) {
        this.rowsFor(entry.path, depth + 1, out);
      }
    }
  }

  private messageRow(text: string, depth: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'file-msg';
    el.style.paddingLeft = `${8 + depth * 12}px`;
    el.textContent = text;
    return el;
  }

  private row(entry: FileEntry, depth: number): HTMLElement {
    const state = this.state();
    const isDir = entry.kind === 'dir';
    const open = isDir && state.expanded.has(entry.path);

    const row = document.createElement('button');
    row.className = `file-row ${entry.kind}` + (state.selected === entry.path ? ' active' : '');
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.title = entry.path;

    const chevron = document.createElement('span');
    chevron.className = 'file-chevron';
    // Files get the same element so their names line up under a folder's.
    chevron.textContent = isDir ? (open ? '▾' : '▸') : '';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = entry.name;

    row.append(chevron, name);
    row.addEventListener('click', () => {
      if (isDir) this.toggle(entry.path);
      else this.open(entry.path);
    });
    return row;
  }

  private toggle(dir: string) {
    const state = this.state();
    if (state.expanded.has(dir)) {
      state.expanded.delete(dir);
      this.render();
      return;
    }
    state.expanded.add(dir);
    this.render();
    void this.ensureDir(dir);
  }

  private open(file: string) {
    if (!this.cwd) return;
    this.state().selected = file;
    this.render();
    this.onOpen(this.cwd, file);
  }
}
