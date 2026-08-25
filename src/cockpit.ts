import { monaco } from './monaco-env';
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

// Transcripts are persisted here (keyed by worktree) so a reload — Vite HMR or
// a full nodemon restart — restores the chat instead of wiping it.
const STORE = 'cockpit:transcript:';

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
  tools: Map<string, HTMLElement>;
  todos: HTMLElement | null;
};

export class Cockpit {
  private conversations: HTMLElement;
  private tabs: HTMLElement;
  private status: HTMLElement;
  private diffEditor: monaco.editor.IStandaloneDiffEditor;
  private models: monaco.editor.ITextModel[] = [];

  private panes = new Map<string, Pane>();
  private pane: Pane;

  private thoughts: monaco.editor.IModelDeltaDecoration[] = [];
  private thoughtCollection: monaco.editor.IEditorDecorationsCollection | null = null;
  private persistTimer: number | null = null;

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
      pane = { key, el, bubbleType: null, bubbleBody: null, tools: new Map(), todos: null };
      this.panes.set(key, pane);
      // Restore a persisted transcript so a reload keeps the chat.
      const saved = localStorage.getItem(STORE + key);
      if (saved) {
        el.innerHTML = saved;
        pane.todos = el.querySelector<HTMLElement>('.todos');
      }
    }
    return pane;
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

  /** Clear one transcript (the model-side session is dropped separately). */
  clearPane(key: string) {
    const pane = this.paneFor(key);
    pane.el.innerHTML = '';
    pane.bubbleType = null;
    pane.bubbleBody = null;
    pane.tools.clear();
    pane.todos = null;
    localStorage.removeItem(STORE + key);
  }

  /** Full teardown of the visible transcript plus the diff surface. */
  reset() {
    this.pane.el.innerHTML = '';
    this.pane.bubbleType = null;
    this.pane.bubbleBody = null;
    this.pane.tools.clear();
    this.pane.todos = null;
    localStorage.removeItem(STORE + this.pane.key);
    this.resetDiff();
  }

  /** Debounced snapshot of the active transcript to localStorage. */
  private persist() {
    const pane = this.pane;
    if (this.persistTimer !== null) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      try {
        localStorage.setItem(STORE + pane.key, pane.el.innerHTML);
      } catch {
        // quota or serialization failure — a lost transcript beats a crash
      }
    }, 200);
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

  async handle(event: AgentEvent) {
    switch (event.type) {
      case 'user':
        this.addUser(event.text);
        break;
      case 'thinking':
      case 'say':
        this.appendDelta(event.type, event.text);
        break;
      case 'plan':
        await this.renderPlan(event.title, event.items);
        break;
      case 'tool_start':
        this.startTool(event.id, event.name, event.summary);
        break;
      case 'tool_end':
        this.endTool(event.id, event.ok, event.detail);
        break;
      case 'todos':
        this.renderTodos(event.items);
        break;
      case 'edit_start':
        // Break the transcript bubble now, in event order; the diff catches up.
        this.pane.bubbleType = null;
        this.enqueue(() => this.startEdit(event.file, event.language, event.original));
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
        this.pane.bubbleType = null;
        this.addMessage('error').textContent = `⚠ ${event.message}`;
        break;
      case 'done':
        this.endTurn(event.interrupted);
        break;
    }
    this.persist();
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
    this.pane.bubbleType = null;
    this.addMessage('user').textContent = text;
  }

  private startTool(id: string, name: string, summary: string) {
    this.pane.bubbleType = null;
    const row = this.addMessage('tool running');
    row.innerHTML = `
      <span class="tool-glyph"></span>
      <span class="tool-name"></span>
      <span class="tool-summary"></span>
      <span class="tool-detail"></span>`;
    row.querySelector('.tool-name')!.textContent = name;
    row.querySelector('.tool-summary')!.textContent = summary;
    this.pane.tools.set(id, row);
  }

  private endTool(id: string, ok: boolean, detail?: string) {
    const row = this.pane.tools.get(id);
    if (!row) return;
    this.pane.tools.delete(id);
    row.classList.remove('running');
    row.classList.add(ok ? 'ok' : 'failed');
    if (detail) row.querySelector('.tool-detail')!.textContent = detail;
    this.scrollDown();
  }

  /**
   * The todo list is one live block that rewrites in place — TodoWrite fires
   * on every status flip and appending each version would bury the transcript.
   */
  private renderTodos(items: TodoItem[]) {
    this.pane.bubbleType = null;
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
    this.pane.bubbleType = null;
    // Any tool still marked running was cut off — don't leave it spinning.
    for (const row of this.pane.tools.values()) {
      row.classList.remove('running');
      row.classList.add('failed');
    }
    this.pane.tools.clear();

    // Like CC desktop: a normal turn just ends. Only surface an interrupt.
    if (interrupted) this.addMessage('turn-end').textContent = 'Stopped';
  }

  private appendDelta(type: 'thinking' | 'say', text: string) {
    if (this.pane.bubbleType !== type || !this.pane.bubbleBody) {
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
    }
    this.pane.bubbleBody.textContent += text;
    this.scrollDown();
  }

  private async renderPlan(title: string, items: PlanItem[]) {
    this.pane.bubbleType = null;
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
