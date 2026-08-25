import type { Worktree } from './bridge';
import { IDLE_STATUS, type RunChunk, type RunStatus } from './runConfig';

/**
 * The Run tab: what command starts this worktree, a button to start it, the port
 * it will bind, and the output it produces.
 *
 * The command field *is* the config surface. Empty means "resolve it from the
 * repo" and the resolved command shows as placeholder text; typing in it pins an
 * override in the cockpit's settings, and clearing it goes back to automatic.
 * Nothing is written into the repo being worked on.
 *
 * The pane shows one worktree at a time while runs continue in all of them, so
 * every event is filtered against the worktree currently on screen.
 */

/** Output beyond this is dropped from the DOM; the pane is a tail, not a log. */
const MAX_NODES = 1_500;

function label(status: RunStatus): string {
  return status.state === 'running' ? '■ Stop' : '▶ Run';
}

export class RunPane {
  private cmdInput: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private sourceLabel: HTMLElement;
  private out: HTMLElement;

  private worktree: Worktree | null = null;
  private status: RunStatus = { ...IDLE_STATUS };
  /** Notified so the topbar button can mirror this pane's state. */
  private onStatus: (status: RunStatus) => void;

  constructor(root: HTMLElement, onStatus: (status: RunStatus) => void) {
    this.onStatus = onStatus;
    root.innerHTML = `
      <div class="run-head">
        <input class="run-cmd" type="text" spellcheck="false" autocapitalize="off" />
        <button class="run-go btn">▶ Run</button>
      </div>
      <div class="run-source"></div>
      <div class="run-out"></div>`;

    this.cmdInput = root.querySelector('.run-cmd') as HTMLInputElement;
    this.goBtn = root.querySelector('.run-go') as HTMLButtonElement;
    this.sourceLabel = root.querySelector('.run-source') as HTMLElement;
    this.out = root.querySelector('.run-out') as HTMLElement;

    this.goBtn.addEventListener('click', () => this.toggle());
    this.cmdInput.addEventListener('change', () => this.saveOverride());
    this.cmdInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.saveOverride().then(() => this.start());
    });

    const bridge = window.cockpit?.run;
    if (!bridge) {
      this.sourceLabel.textContent = 'Running a worktree needs the desktop app.';
      this.cmdInput.disabled = true;
      this.goBtn.disabled = true;
      return;
    }

    bridge.onEvent((event) => {
      // Other worktrees keep running while this pane shows one of them.
      if (event.cwd !== this.worktree?.path) return;
      if (event.type === 'status') this.applyStatus(event.status);
      else if (event.type === 'output') this.write(event.chunk);
      else this.out.replaceChildren();
    });
  }

  /** Switch the pane to a worktree, replaying whatever its run has produced. */
  async setWorktree(wt: Worktree | null) {
    this.worktree = wt;
    this.out.replaceChildren();
    this.status = { ...IDLE_STATUS, cwd: wt?.path ?? null };

    const bridge = window.cockpit?.run;
    if (bridge && wt) {
      for (const chunk of await bridge.buffer(wt.path)) this.write(chunk);
      // A run already in flight here — the pane may be opened mid-run.
      this.status = await bridge.status(wt.path);
    }

    await this.refreshCommand();
    this.applyStatus(this.status);
  }

  /** Show the override if there is one, else the command the repo implies. */
  private async refreshCommand() {
    const bridge = window.cockpit;
    if (!bridge || !this.worktree) {
      this.cmdInput.placeholder = '';
      this.sourceLabel.textContent = this.worktree ? '' : 'Select a worktree in the left rail.';
      return;
    }

    const port = `Port ${this.worktree.port}`;
    const override = (await bridge.store.settings()).runCommand;
    this.cmdInput.value = override;

    if (override) {
      this.cmdInput.placeholder = '';
      this.sourceLabel.textContent = `${port} · override from cockpit settings — clear the field to auto-detect.`;
      return;
    }

    const detected = await bridge.run.detect(this.worktree.path);
    this.cmdInput.placeholder = detected.command || 'no run command found — type one';
    this.sourceLabel.textContent = detected.source
      ? `${port} · auto-detected from ${detected.source}`
      : `${port} · nothing in this repo says how to run it. Type a command to pin one.`;
  }

  /** Persist the field as the override, or drop it when emptied. */
  private async saveOverride() {
    const bridge = window.cockpit;
    if (!bridge) return;
    await bridge.store.saveSettings({ runCommand: this.cmdInput.value.trim() });
    await this.refreshCommand();
  }

  private applyStatus(status: RunStatus) {
    this.status = status;
    this.syncButton();
    this.onStatus(status);
  }

  private syncButton() {
    this.goBtn.textContent = label(this.status);
    this.goBtn.classList.toggle('danger', this.status.state === 'running');
    this.goBtn.classList.toggle('primary', this.status.state !== 'running');
    this.goBtn.disabled = !window.cockpit || !this.worktree;
  }

  toggle() {
    if (!this.worktree) return;
    if (this.status.state === 'running') void window.cockpit?.run.stop(this.worktree.path);
    else void this.start();
  }

  /** Start in the active worktree. The field wins over resolution for this run. */
  async start() {
    if (!this.worktree) return;
    await window.cockpit?.run.start(this.worktree.path, this.cmdInput.value.trim() || undefined);
  }

  private write(chunk: RunChunk) {
    // Only follow the tail if the reader is already there — scrolling back to
    // read a stack trace shouldn't be yanked away by the next log line.
    const atBottom = this.out.scrollHeight - this.out.scrollTop - this.out.clientHeight < 40;

    const node = document.createElement('span');
    if (chunk.stream === 'err') node.className = 'run-err';
    node.textContent = chunk.text;
    this.out.appendChild(node);

    while (this.out.childElementCount > MAX_NODES) this.out.firstElementChild?.remove();
    if (atBottom) this.out.scrollTop = this.out.scrollHeight;
  }
}

export { label as runButtonLabel };
