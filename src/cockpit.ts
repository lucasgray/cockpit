import { monaco } from './monaco-env';
import { renderMarkdown } from './markdown';
import type { AgentEvent, EditOp, PlanItem, TodoItem } from './agent/protocol';

const sleep = (ms: number) =>
  document.hidden ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Typewriter pacing. One tick is roughly one frame; the chunk size — how many
 * characters land per tick — scales up so a big edit still finishes on time.
 * Past MAX_CHUNK the effect stops reading as typing and starts reading as
 * stuttering, so an edit that would need a bigger chunk is applied whole.
 */
const TICK_MS = 16;
const MAX_CHUNK = 24;
/** Ceiling for any single edit, so one huge rewrite can't hog the turn. */
const EDIT_BUDGET_MS = 6_000;
/** Ceiling for all typing in one turn. Later edits snap in once it's spent. */
const TURN_BUDGET_MS = 20_000;

type Pos = { lineNumber: number; column: number };

/** Where the caret lands after `text` is inserted at `pos`. */
function advance(pos: Pos, text: string): Pos {
  const lastBreak = text.lastIndexOf('\n');
  if (lastBreak === -1) return { lineNumber: pos.lineNumber, column: pos.column + text.length };
  const breaks = text.length - text.replaceAll('\n', '').length;
  return { lineNumber: pos.lineNumber + breaks, column: text.length - lastBreak };
}

/** Per-conversation scroll + streaming state, so panes can be swapped intact. */
type Pane = {
  key: string;
  el: HTMLElement;
  bubbleType: 'thinking' | 'say' | null;
  bubbleBody: HTMLElement | null;
  /** Markdown source for the open bubble, re-rendered as deltas land. */
  bubbleText: string;
  /** Characters of bubbleText revealed so far — the text typewriters in. */
  bubbleShown: number;
  tools: Map<string, HTMLElement>;
  todos: HTMLElement | null;
  /** The "thinking" spinner under the prompt (+ its interval), while it thinks. */
  spinner: HTMLElement | null;
  spinnerTimer: number;
  /** Whether the stored transcript has been replayed into this pane yet. */
  restored: boolean;
};

export class Cockpit {
  private conversations: HTMLElement;
  private tabs: HTMLElement;
  private status: HTMLElement;
  private diffEditor: monaco.editor.IStandaloneDiffEditor;
  private models: monaco.editor.ITextModel[] = [];

  private panes = new Map<string, Pane>();
  private pane: Pane;

  /** Bubbles holding deltas that haven't been drawn yet. */
  private dirty = new Set<Pane>();
  /** Pending render frame, or 0 when nothing is scheduled. */
  private frame = 0;
  /** Pending typewriter-reveal frame, or 0 when the text has caught up. */
  private revealFrame = 0;

  private thoughts: monaco.editor.IModelDeltaDecoration[] = [];
  private thoughtCollection: monaco.editor.IEditorDecorationsCollection | null = null;
  /** Serializes transcript replays against each other. */
  private restoreQueue: Promise<void> = Promise.resolve();

  /**
   * Edits animate off the critical path: `handle` drops them on this queue and
   * returns, so thinking, tool rows and the rest of the turn keep streaming in
   * while the diff types itself out. The queue is serial — ops still land in
   * the order the agent emitted them.
   */
  private editQueue: Promise<void> = Promise.resolve();
  /** Bumped whenever the diff is torn down; in-flight typing checks it and bails. */
  private editGen = 0;
  private turnBudget = TURN_BUDGET_MS;
  /** Set on interrupt — typing dumps the rest of its text and stops. */
  private fastForward = false;
  /** Whether the current edit was too big to type, for the status line. */
  private appliedWhole = false;

  constructor() {
    this.conversations = document.getElementById('conversation')!;
    this.pane = this.paneFor('default');
    this.showPane('default');
    this.tabs = document.getElementById('tabs')!;
    this.status = document.getElementById('status')!;
    const diffContainer = document.getElementById('diff')!;

    this.diffEditor = monaco.editor.createDiffEditor(diffContainer, {
      theme: 'cockpit-dark',
      automaticLayout: true,
      renderSideBySide: true,
      readOnly: true,
      originalEditable: false,
      glyphMargin: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    });
  }

  private paneFor(key: string): Pane {
    let pane = this.panes.get(key);
    if (!pane) {
      const el = document.createElement('div');
      el.className = 'transcript';
      this.conversations.append(el);
      pane = {
        key,
        el,
        bubbleType: null,
        bubbleBody: null,
        bubbleText: '',
        bubbleShown: 0,
        tools: new Map(),
        todos: null,
        spinner: null,
        spinnerTimer: 0,
        restored: false,
      };
      this.panes.set(key, pane);
    }
    return pane;
  }

  /**
   * Markdown renders from the bubble's whole source, because a delta that closes
   * a fence or starts a list changes blocks already on screen. Per delta that
   * would be a full innerHTML swap per token — enough to drop frames, and to
   * drop any selection the reader is holding — so renders coalesce to one a
   * frame, which is as often as the change could be seen anyway.
   */
  private scheduleRender(pane: Pane) {
    this.dirty.add(pane);
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      for (const p of this.dirty) this.draw(p);
      this.dirty.clear();
      this.scrollDown();
    });
  }

  private draw(pane: Pane) {
    if (pane.bubbleBody) {
      pane.bubbleBody.innerHTML = renderMarkdown(pane.bubbleText.slice(0, pane.bubbleShown));
    }
  }

  /**
   * End the open bubble, so whatever comes next starts a fresh one. Anything
   * still pending is drawn first: a replay loop never yields to a frame, so the
   * scheduled render might otherwise land after the bubble had been let go.
   */
  private closeBubble() {
    // Snap the typewriter to the end so a bubble never freezes half-revealed.
    if (this.revealFrame) {
      cancelAnimationFrame(this.revealFrame);
      this.revealFrame = 0;
    }
    this.pane.bubbleShown = this.pane.bubbleText.length;
    this.dirty.delete(this.pane);
    if (this.pane.bubbleBody) this.draw(this.pane);
    this.pane.bubbleType = null;
    this.pane.bubbleBody = null;
    this.pane.bubbleText = '';
    this.pane.bubbleShown = 0;
  }

  /** Drop a pane's drawn transcript and every live handle into it. */
  private blankPane(pane: Pane) {
    this.dirty.delete(pane);
    if (pane.spinnerTimer) {
      clearInterval(pane.spinnerTimer);
      pane.spinnerTimer = 0;
    }
    pane.spinner = null;
    pane.el.innerHTML = '';
    pane.bubbleType = null;
    pane.bubbleBody = null;
    pane.bubbleText = '';
    pane.bubbleShown = 0;
    pane.tools.clear();
    pane.todos = null;
  }

  /**
   * Rebuild a worktree's transcript by replaying its stored events. Replaying
   * the stream — rather than restoring saved markup — is what lets tool rows,
   * todo lists and streaming bubbles come back as live objects the rest of the
   * turn can still address by id.
   */
  restorePane(key: string): Promise<void> {
    // Serial: two quick worktree clicks would otherwise interleave their draws.
    const run = this.restoreQueue.then(() => this.replayInto(key));
    this.restoreQueue = run.catch(() => {});
    return run;
  }

  private async replayInto(key: string) {
    const pane = this.paneFor(key);
    if (pane.restored) return;
    pane.restored = true;
    const events = (await window.cockpit?.store.transcript(key)) ?? [];
    if (!events.length) return;

    // handle() draws into the active pane, so aim it at the one being restored.
    const previous = this.pane;
    this.pane = pane;
    try {
      for (const event of events) {
        if (this.pane !== pane) {
          // Switched away mid-replay. Drop the half-drawn transcript rather
          // than leak the rest of it into whatever pane is active now; the
          // next visit replays from the store cleanly.
          this.blankPane(pane);
          pane.restored = false;
          return;
        }
        await this.handle(event, true);
      }
    } finally {
      if (this.pane === pane) this.pane = previous;
    }
  }

  /**
   * Make `key`'s transcript the visible one. Panes are kept in the DOM, so
   * switching worktrees mid-flight never loses a conversation.
   */
  showPane(key: string) {
    this.pane = this.paneFor(key);
    for (const [k, p] of this.panes) p.el.classList.toggle('visible', k === key);
    this.scrollDown();
  }

  /**
   * Forget a transcript entirely — for a worktree that no longer exists. The
   * pane has to go rather than just be blanked, or a worktree recreated at the
   * same path would reopen onto the dead one's conversation.
   */
  dropPane(key: string) {
    const pane = this.panes.get(key);
    if (!pane) return;
    this.blankPane(pane);
    pane.el.remove();
    this.panes.delete(key);
    if (this.pane === pane) this.showPane('default');
  }

  /** Full teardown of the visible transcript plus the diff surface. */
  reset() {
    this.blankPane(this.pane);
    this.pane.restored = true;
    window.cockpit?.store.clearTranscript(this.pane.key);
    this.resetDiff();
  }

  /** Queue diff work behind whatever is still typing, dropping stale generations. */
  private enqueue(work: () => Promise<void> | void) {
    const gen = this.editGen;
    this.editQueue = this.editQueue
      .then(() => {
        if (gen !== this.editGen) return;
        return work();
      })
      .catch(() => {
        // A disposed model or a torn-down editor — the next edit starts clean.
      });
  }

  /**
   * Resolve once the diff has stopped moving. A turn isn't really over while
   * its last edit is still unspooling; the budgets bound how long this waits.
   */
  async settleEdits() {
    let seen: Promise<void> | null = null;
    while (seen !== this.editQueue) {
      seen = this.editQueue;
      await seen;
    }
  }

  resetDiff() {
    this.editGen++;
    this.turnBudget = TURN_BUDGET_MS;
    this.fastForward = false;
    this.tabs.innerHTML = '';
    this.status.textContent = '';
    this.diffEditor.setModel(null);
    this.models.forEach((m) => m.dispose());
    this.models = [];
    this.thoughts = [];
    this.thoughtCollection = null;
  }

  /** The reliable "what changed" view: a worktree's unified git diff. */
  async showChanges(diff: string) {
    const changes = document.getElementById('changes')!;
    changes.innerHTML = diff.trim()
      ? await monaco.editor.colorize(diff, 'diff', {})
      : '<div class="changes-empty">No uncommitted changes in this worktree.</div>';
    document.getElementById('diff')!.style.display = 'none';
    changes.hidden = false;
  }

  /** Back to the live typewriter diff of the current turn. */
  showLive() {
    document.getElementById('changes')!.hidden = true;
    document.getElementById('diff')!.style.display = '';
  }

  /**
   * Draw one event. `replaying` marks events coming back from the store rather
   * than off a live run — same transcript, but nothing to animate.
   */
  async handle(event: AgentEvent, replaying = false) {
    // The spinner means "thinking, nothing shown yet" — any real output ends it.
    if (!replaying && event.type !== 'user' && event.type !== 'thinking') this.stopSpinner();
    switch (event.type) {
      case 'user':
        this.addUser(event.text);
        if (!replaying) this.startSpinner();
        break;
      case 'thinking':
        // Thinking text is usually omitted (empty). Keep the spinner rather than
        // open a blank bubble; only draw a bubble when there's real content.
        if (!event.text.trim()) {
          if (!replaying) this.ensureSpinner();
          break;
        }
        if (!replaying) this.stopSpinner();
        this.appendDelta('thinking', event.text, replaying);
        break;
      case 'say':
        this.appendDelta('say', event.text, replaying);
        break;
      case 'plan':
        await this.renderPlan(event.title, event.items);
        break;
      case 'tool_start':
        this.startTool(event.id, event.name, event.summary, event.detail);
        break;
      case 'tool_end':
        this.endTool(event.id, event.ok, event.detail);
        break;
      case 'todos':
        this.renderTodos(event.items);
        break;
      case 'edit_start':
        // Break the transcript bubble now, in event order; the diff catches up.
        this.closeBubble();
        // Stored transcripts keep this event for that break, but drop the file
        // contents and the ops that followed — the diff pane is live-only
        // state, so on replay there is nothing to type out.
        if (!replaying) {
          this.enqueue(() => this.startEdit(event.file, event.language, event.original));
        }
        break;
      case 'edit_op':
        this.enqueue(() => this.applyEditOp(event.op));
        break;
      case 'edit_end':
        this.enqueue(() => {
          const done = this.status.textContent.replace('✎ editing', '✓ edited');
          this.status.textContent = this.appliedWhole ? `${done} · applied at once` : done;
        });
        break;
      case 'error':
        this.closeBubble();
        this.addMessage('error').textContent = `⚠ ${event.message}`;
        break;
      case 'done':
        this.endTurn(event.interrupted);
        break;
    }
  }

  private scrollDown() {
    this.conversations.scrollTop = this.conversations.scrollHeight;
  }

  private addMessage(cls: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    this.pane.el.appendChild(el);
    this.scrollDown();
    return el;
  }

  private addUser(text: string) {
    this.closeBubble();
    this.addMessage('user').textContent = text;
  }

  private startTool(id: string, name: string, summary: string, detail?: string) {
    this.closeBubble();
    const row = this.addMessage('tool running');

    const head = document.createElement('div');
    head.className = 'tool-head';
    head.innerHTML =
      '<span class="tool-glyph"></span><span class="tool-name"></span>' +
      '<span class="tool-summary"></span><span class="tool-caret"></span>';
    head.querySelector('.tool-name')!.textContent = name;
    head.querySelector('.tool-summary')!.textContent = summary;

    const body = document.createElement('div');
    body.className = 'tool-body';
    if (detail) {
      const cmd = document.createElement('pre');
      cmd.className = 'tool-cmd';
      cmd.textContent = detail;
      body.append(cmd);
    }

    row.append(head, body);
    // The whole head toggles the body — but only once there's something in it.
    head.addEventListener('click', () => {
      if (body.childElementCount > 0) row.classList.toggle('expanded');
    });
    this.syncToolBody(row);
    this.pane.tools.set(id, row);
  }

  private endTool(id: string, ok: boolean, detail?: string) {
    const row = this.pane.tools.get(id);
    if (!row) return;
    this.pane.tools.delete(id);
    row.classList.remove('running');
    row.classList.add(ok ? 'ok' : 'failed');
    if (detail) {
      const out = document.createElement('pre');
      out.className = 'tool-out';
      out.textContent = detail;
      row.querySelector('.tool-body')!.append(out);
    }
    this.syncToolBody(row);
    this.scrollDown();
  }

  /** Show the caret/pointer only when the row actually has an expandable body. */
  private syncToolBody(row: HTMLElement) {
    const body = row.querySelector('.tool-body');
    row.classList.toggle('has-body', !!body && body.childElementCount > 0);
  }

  /**
   * The todo list is one live block that rewrites in place — TodoWrite fires
   * on every status flip and appending each version would bury the transcript.
   */
  private renderTodos(items: TodoItem[]) {
    this.closeBubble();
    if (!this.pane.todos) {
      this.pane.todos = this.addMessage('todos');
    }
    const done = items.filter((t) => t.status === 'completed').length;
    this.pane.todos.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'todos-title';
    head.textContent = `☑ ${done}/${items.length}`;
    this.pane.todos.append(head);

    for (const item of items) {
      const row = document.createElement('div');
      row.className = `todo ${item.status}`;
      const glyph = document.createElement('span');
      glyph.className = 'todo-glyph';
      glyph.textContent = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : '·';
      const text = document.createElement('span');
      text.textContent = item.text;
      row.append(glyph, text);
      this.pane.todos.append(row);
    }
    this.scrollDown();
  }

  private endTurn(interrupted?: boolean) {
    // Stop means stop: typing dumps its remaining text instead of playing on.
    if (interrupted) this.fastForward = true;
    this.closeBubble();
    // Any tool still marked running was cut off — don't leave it spinning.
    for (const row of this.pane.tools.values()) {
      row.classList.remove('running');
      row.classList.add('failed');
    }
    this.pane.tools.clear();

    // Like CC desktop: a normal turn just ends. Only surface an interrupt.
    if (interrupted) this.addMessage('turn-end').textContent = 'Stopped';
  }

  private appendDelta(type: 'thinking' | 'say', text: string, instant = false) {
    if (this.pane.bubbleType !== type || !this.pane.bubbleBody) {
      this.closeBubble();
      const wrap = this.addMessage(type);
      if (type === 'thinking') {
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = '✳ thinking';
        wrap.append(label);
      }
      const body = document.createElement('div');
      body.className = 'text';
      wrap.append(body);
      this.pane.bubbleType = type;
      this.pane.bubbleBody = body;
      this.pane.bubbleText = '';
      this.pane.bubbleShown = 0;
    }
    this.pane.bubbleText += text;
    if (instant) {
      // Replayed history: show it all at once, nothing to animate.
      this.pane.bubbleShown = this.pane.bubbleText.length;
      this.draw(this.pane);
    } else {
      this.revealTick(this.pane);
    }
  }

  /**
   * Typewriter: advance the revealed length toward the received text one frame
   * at a time. The step scales with the backlog so a fast stream still clears
   * within ~half a second, but never lands fewer than a couple chars per frame.
   */
  private revealTick(pane: Pane) {
    if (this.revealFrame) return;
    const step = () => {
      this.revealFrame = 0;
      const remaining = pane.bubbleText.length - pane.bubbleShown;
      if (remaining <= 0) return;
      pane.bubbleShown += Math.max(2, Math.ceil(remaining / 30));
      if (pane.bubbleShown > pane.bubbleText.length) pane.bubbleShown = pane.bubbleText.length;
      this.draw(pane);
      this.scrollDown();
      if (pane.bubbleShown < pane.bubbleText.length) this.revealFrame = requestAnimationFrame(step);
    };
    this.revealFrame = requestAnimationFrame(step);
  }

  /** A tight |/-\ spinner under the prompt while Claude thinks with no output yet. */
  private startSpinner() {
    this.stopSpinner();
    const el = this.addMessage('spinner');
    const frames = ['|', '/', '-', '\\'];
    let i = 0;
    el.textContent = frames[0];
    const pane = this.pane;
    pane.spinner = el;
    pane.spinnerTimer = window.setInterval(() => {
      i = (i + 1) % frames.length;
      el.textContent = frames[i];
    }, 80);
  }

  private ensureSpinner() {
    if (!this.pane.spinner) this.startSpinner();
  }

  private stopSpinner() {
    const pane = this.pane;
    if (pane.spinnerTimer) {
      clearInterval(pane.spinnerTimer);
      pane.spinnerTimer = 0;
    }
    pane.spinner?.remove();
    pane.spinner = null;
  }

  private async renderPlan(title: string, items: PlanItem[]) {
    this.closeBubble();
    const wrap = this.addMessage('plan');
    const heading = document.createElement('div');
    heading.className = 'plan-title';
    heading.textContent = `◈ ${title}`;
    wrap.append(heading);

    for (const [i, item] of items.entries()) {
      const row = document.createElement('div');
      row.className = 'plan-item';
      const head = document.createElement('div');
      head.className = 'plan-item-head';
      head.textContent = `${i + 1}. ${item.text}`;
      row.append(head);
      if (item.snippet) {
        const snip = document.createElement('div');
        snip.className = 'snippet';
        snip.innerHTML = await monaco.editor.colorize(item.snippet.code, item.snippet.lang, {});
        row.append(snip);
      }
      wrap.append(row);
      this.scrollDown();
      await sleep(200);
    }
  }

  private startEdit(file: string, language: string, original: string) {
    this.appliedWhole = false;
    this.tabs.innerHTML = '';
    const tab = document.createElement('div');
    tab.className = 'tab active';
    tab.textContent = file;
    this.tabs.append(tab);

    this.models.forEach((m) => m.dispose());
    const originalModel = monaco.editor.createModel(original, language);
    const modifiedModel = monaco.editor.createModel(original, language);
    this.models = [originalModel, modifiedModel];
    this.diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    this.thoughts = [];
    this.thoughtCollection = this.diffEditor.getModifiedEditor().createDecorationsCollection([]);
    this.status.textContent = `✎ editing ${file}`;
  }

  private async applyEditOp(op: EditOp) {
    const editor = this.diffEditor.getModifiedEditor();
    const model = editor.getModel();
    if (!model) return;

    const line = await this.applyOp(editor, model, op);
    if (op.note && line > 0) this.pinThought(model, line, op.note);
  }

  private findAnchor(model: monaco.editor.ITextModel, anchor: string): number {
    for (let i = 1; i <= model.getLineCount(); i++) {
      if (model.getLineContent(i).includes(anchor)) return i;
    }
    return -1;
  }

  private async applyOp(
    editor: monaco.editor.ICodeEditor,
    model: monaco.editor.ITextModel,
    op: EditOp,
  ): Promise<number> {
    switch (op.kind) {
      case 'setContent': {
        model.setValue('');
        editor.revealLine(1);
        await this.write(editor, model, { lineNumber: 1, column: 1 }, op.text);
        return 1;
      }
      case 'append': {
        const line = model.getLineCount();
        const column = model.getLineMaxColumn(line);
        await this.write(editor, model, { lineNumber: line, column }, `\n${op.text}`);
        return line + 1;
      }
      case 'replaceString': {
        const full = model.getValue();
        const idx = full.indexOf(op.find);
        if (idx === -1) {
          const line = model.getLineCount();
          const column = model.getLineMaxColumn(line);
          await this.write(editor, model, { lineNumber: line, column }, `\n${op.replace}`);
          return line + 1;
        }
        const start = model.getPositionAt(idx);
        const end = model.getPositionAt(idx + op.find.length);
        model.applyEdits([
          { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: '' },
        ]);
        await this.write(editor, model, { lineNumber: start.lineNumber, column: start.column }, op.replace);
        return start.lineNumber;
      }
      case 'insertAfter': {
        const anchorLine = this.findAnchor(model, op.anchor);
        if (anchorLine === -1) return -1;
        const column = model.getLineMaxColumn(anchorLine);
        await this.write(editor, model, { lineNumber: anchorLine, column }, `\n${op.text}`);
        return anchorLine + (op.text.startsWith('\n') ? 2 : 1);
      }
      case 'replaceLine': {
        const anchorLine = this.findAnchor(model, op.anchor);
        if (anchorLine === -1) return -1;
        const maxColumn = model.getLineMaxColumn(anchorLine);
        model.applyEdits([{ range: new monaco.Range(anchorLine, 1, anchorLine, maxColumn), text: '' }]);
        await this.write(editor, model, { lineNumber: anchorLine, column: 1 }, op.text);
        return anchorLine;
      }
    }
  }

  /**
   * How many characters to land per tick for an insert of `chars`, or null when
   * there's no way to show it as typing inside the budget. Small edits get one
   * character a tick — the familiar cadence; bigger ones speed up until the
   * chunk would be too coarse to read, at which point the caller drops the text
   * in whole rather than making anyone sit through it.
   */
  private chunkFor(chars: number): number | null {
    const budget = Math.min(EDIT_BUDGET_MS, this.turnBudget);
    if (budget < TICK_MS * 4) return null;
    const chunk = Math.ceil(chars / Math.floor(budget / TICK_MS));
    return chunk > MAX_CHUNK ? null : chunk;
  }

  /** Insert `text` at `pos` — typed out when it fits the budget, instant when not. */
  private async write(
    editor: monaco.editor.ICodeEditor,
    model: monaco.editor.ITextModel,
    pos: Pos,
    text: string,
  ) {
    const chunk = this.chunkFor(text.length);
    if (chunk === null) {
      this.appliedWhole = true;
      this.insert(model, pos, text);
      editor.revealLineInCenterIfOutsideViewport(pos.lineNumber);
      return;
    }

    const gen = this.editGen;
    const started = performance.now();
    let at = { ...pos };
    for (let i = 0; i < text.length; i += chunk) {
      if (gen !== this.editGen || model.isDisposed()) return;
      if (this.fastForward) {
        this.insert(model, at, text.slice(i));
        break;
      }
      const slice = text.slice(i, i + chunk);
      this.insert(model, at, slice);
      at = advance(at, slice);
      editor.revealLineInCenterIfOutsideViewport(at.lineNumber);
      await sleep(TICK_MS);
    }
    this.turnBudget -= performance.now() - started;
  }

  private insert(model: monaco.editor.ITextModel, pos: Pos, text: string) {
    model.applyEdits([
      { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text },
    ]);
  }

  private pinThought(model: monaco.editor.ITextModel, line: number, note: string) {
    if (!this.thoughtCollection) return;
    const endColumn = model.getLineMaxColumn(line);
    this.thoughts.push({
      range: new monaco.Range(line, 1, line, endColumn),
      options: {
        glyphMarginClassName: 'thought-glyph',
        glyphMarginHoverMessage: { value: note },
        hoverMessage: { value: `**why:** ${note}` },
        after: { content: `   ✳ ${note}`, inlineClassName: 'thought-inline' },
      },
    });
    this.thoughtCollection.set(this.thoughts);
  }
}

/**
 * Drive the cockpit from one turn's worth of events. `reset` clears the whole
 * transcript first — right for a one-shot demo, wrong for a live session where
 * each turn appends to the conversation already on screen.
 */
export async function runStream(
  ui: Cockpit,
  source: AsyncIterable<AgentEvent>,
  { reset = true }: { reset?: boolean } = {},
) {
  if (reset) ui.reset();
  else ui.resetDiff();
  for await (const event of source) {
    await ui.handle(event);
    if (event.type === 'done') break;
  }
  // Events are done, but the diff may still be typing the last edit out.
  await ui.settleEdits();
}
