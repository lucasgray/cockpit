/**
 * The file tab strip across the top of the workspace.
 *
 * Every file opened in the File pane keeps a tab here, in the order it was first
 * opened, and the tabs stay put while the workspace is showing Live or Changes —
 * the set of files you have open is yours, not the current view's. When there are
 * more tabs than the strip is wide, the rightmost ones fold into a `⋯` menu rather
 * than shrinking to nothing. Right-clicking any tab offers to close the rest.
 *
 * This is only the chrome: it holds no buffers and no source of truth. `FileView`
 * owns the open set and drives this by handing it a fresh list of descriptors;
 * every gesture here calls straight back out to `FileView` through the handlers.
 */

export type TabDescriptor = {
  cwd: string;
  path: string;
  /** The file's own name — the strip is too narrow for the full path. */
  name: string;
  dirty: boolean;
  active: boolean;
};

export type TabHandlers = {
  select: (cwd: string, path: string) => void;
  close: (cwd: string, path: string) => void;
  closeOthers: (cwd: string, path: string) => void;
  closeAll: () => void;
};

const key = (cwd: string, path: string) => `${cwd} ${path}`;

export class FileTabs {
  private root: HTMLElement;
  private handlers: TabHandlers;
  private strip: HTMLElement;
  private overflowBtn: HTMLButtonElement;
  private tabs: TabDescriptor[] = [];
  private els = new Map<string, HTMLElement>();
  /** The open popup (overflow list or right-click menu), so a second gesture — or
   *  a click anywhere else — takes it back down. */
  private popup: HTMLElement | null = null;

  constructor(root: HTMLElement, handlers: TabHandlers) {
    this.root = root;
    this.handlers = handlers;
    root.classList.add('file-tabs');

    this.strip = document.createElement('div');
    this.strip.className = 'file-tab-strip';

    this.overflowBtn = document.createElement('button');
    this.overflowBtn.className = 'file-tab-overflow';
    this.overflowBtn.textContent = '⋯';
    this.overflowBtn.title = 'More open files';
    this.overflowBtn.hidden = true;
    this.overflowBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openOverflow();
    });

    root.replaceChildren(this.strip, this.overflowBtn);
    root.hidden = true;

    // The strip's width follows the window and the conversation pane beside it;
    // recompute what fits whenever the box changes rather than only on render.
    new ResizeObserver(() => this.layout()).observe(root);
    // Any click outside a popup dismisses it — including one that lands on the
    // strip itself, which is what makes a second right-click feel like a toggle.
    document.addEventListener('click', () => this.closePopup());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closePopup();
    });
  }

  /** Rebuild the strip from a fresh list — the open set or the active tab moved. */
  render(tabs: TabDescriptor[]) {
    this.tabs = tabs;
    this.closePopup();
    this.strip.replaceChildren();
    this.els.clear();
    for (const tab of tabs) {
      const el = this.tabEl(tab);
      this.els.set(key(tab.cwd, tab.path), el);
      this.strip.append(el);
    }
    this.root.hidden = tabs.length === 0;
    // Widths are readable synchronously once the tabs are in the DOM — reading
    // one forces the layout — so fold now rather than waiting on a frame that an
    // occluded window never paints.
    this.layout();
  }

  /**
   * Flip one tab's unsaved dot without rebuilding the strip — this fires on every
   * keystroke in the editor, so it stays a single class toggle.
   */
  setDirty(cwd: string, path: string, dirty: boolean) {
    this.els.get(key(cwd, path))?.classList.toggle('dirty', dirty);
    const desc = this.tabs.find((t) => t.cwd === cwd && t.path === path);
    if (desc) desc.dirty = dirty;
  }

  private tabEl(tab: TabDescriptor): HTMLElement {
    const el = document.createElement('div');
    el.className = 'file-tab';
    el.classList.toggle('active', tab.active);
    el.classList.toggle('dirty', tab.dirty);
    el.title = tab.path;

    const dot = document.createElement('span');
    dot.className = 'file-tab-dot';
    dot.textContent = '●';

    const name = document.createElement('span');
    name.className = 'file-tab-name';
    name.textContent = tab.name;

    const close = document.createElement('button');
    close.className = 'file-tab-close';
    close.textContent = '×';
    close.title = 'Close';

    el.append(dot, name, close);

    el.addEventListener('click', (event) => {
      if (event.target === close) return;
      this.handlers.select(tab.cwd, tab.path);
    });
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handlers.close(tab.cwd, tab.path);
    });
    // Middle-click closes, the way it does on a browser tab.
    el.addEventListener('mousedown', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        this.handlers.close(tab.cwd, tab.path);
      }
    });
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openContext(event.clientX, event.clientY, tab);
    });
    return el;
  }

  /**
   * Fold the tabs that run off the end into the `⋯` button. Tabs are hidden from
   * the right — but never the active one, which always stays on screen, so
   * opening a file never tucks its own tab away out of sight.
   */
  private layout() {
    const entries = this.tabs.map((tab) => ({ tab, el: this.els.get(key(tab.cwd, tab.path))! }));
    for (const { el } of entries) el.hidden = false;
    this.overflowBtn.hidden = true;
    this.overflowBtn.classList.remove('has-active');
    if (!entries.length || this.strip.scrollWidth <= this.strip.clientWidth) return;

    // Revealing the button shrinks the strip beside it, so re-measure live as we
    // fold: each hidden tab reflows the ones before it.
    this.overflowBtn.hidden = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (this.strip.scrollWidth <= this.strip.clientWidth) break;
      if (entries[i].tab.active) continue; // the current file stays visible
      entries[i].el.hidden = true;
    }
    // Only if the active tab alone can't fit the strip — mark the button so the
    // current file isn't silently invisible.
    const active = entries.find((e) => e.tab.active);
    this.overflowBtn.classList.toggle('has-active', !!active?.el.hidden);
  }

  private openOverflow() {
    const hidden = this.tabs.filter((tab) => this.els.get(key(tab.cwd, tab.path))?.hidden);
    if (!hidden.length) return;

    const menu = document.createElement('div');
    menu.className = 'tab-menu overflow';
    for (const tab of hidden) {
      const row = document.createElement('div');
      row.className = 'tab-menu-item';
      row.classList.toggle('active', tab.active);

      const label = document.createElement('span');
      label.className = 'tab-menu-name';
      label.textContent = tab.name;
      label.title = tab.path;

      const close = document.createElement('button');
      close.className = 'tab-menu-close';
      close.textContent = '×';
      close.title = 'Close';

      row.append(label, close);
      row.addEventListener('click', (event) => {
        if (event.target === close) return;
        this.closePopup();
        this.handlers.select(tab.cwd, tab.path);
      });
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.handlers.close(tab.cwd, tab.path);
      });
      menu.append(row);
    }

    const rect = this.overflowBtn.getBoundingClientRect();
    this.showPopup(menu, rect.right, rect.bottom + 4, true);
  }

  private openContext(x: number, y: number, tab: TabDescriptor) {
    const menu = document.createElement('div');
    menu.className = 'tab-menu';
    const item = (label: string, run: () => void, disabled = false) => {
      const el = document.createElement('div');
      el.className = 'tab-menu-item';
      el.classList.toggle('disabled', disabled);
      el.textContent = label;
      if (!disabled) {
        el.addEventListener('click', () => {
          this.closePopup();
          run();
        });
      }
      menu.append(el);
    };
    const many = this.tabs.length > 1;
    item('Close', () => this.handlers.close(tab.cwd, tab.path));
    item('Close Others', () => this.handlers.closeOthers(tab.cwd, tab.path), !many);
    item('Close All', () => this.handlers.closeAll());
    this.showPopup(menu, x, y, false);
  }

  /**
   * Drop a popup onto the page and keep it inside the window. `alignRight` hangs
   * it off its right edge (the overflow button sits at the strip's far end).
   */
  private showPopup(menu: HTMLElement, x: number, y: number, alignRight: boolean) {
    this.closePopup();
    menu.style.visibility = 'hidden';
    document.body.append(menu);
    // A click inside the popup is not a click that should also close it.
    menu.addEventListener('click', (event) => event.stopPropagation());

    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = alignRight ? x - width : x;
    left = Math.max(6, Math.min(left, window.innerWidth - width - 6));
    const top = Math.min(y, window.innerHeight - height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(6, top)}px`;
    menu.style.visibility = '';
    this.popup = menu;
  }

  private closePopup() {
    this.popup?.remove();
    this.popup = null;
  }
}
