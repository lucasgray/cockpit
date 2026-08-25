import { monaco } from './monaco-env';
import type { AgentEvent, EditOp, PlanItem, TodoItem } from './agent/protocol';

const sleep = (ms: number) =>
  document.hidden ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

// Transcripts are persisted here (keyed by worktree) so a reload — Vite HMR or
// a full nodemon restart — restores the chat instead of wiping it.
const STORE = 'cockpit:transcript:';

type Pos = { lineNumber: number; column: number };

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

  resetDiff() {
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
        this.startEdit(event.file, event.language, event.original);
        break;
      case 'edit_op':
        await this.applyEditOp(event.op);
        break;
      case 'edit_end':
        this.status.textContent = this.status.textContent.replace('✎ editing', '✓ edited');
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
    this.pane.bubbleType = null;
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
        model.setValue(op.text);
        editor.revealLine(1);
        return 1;
      }
      case 'append': {
        const line = model.getLineCount();
        const column = model.getLineMaxColumn(line);
        await this.typeAt(editor, model, { lineNumber: line, column }, `\n${op.text}`);
        return line + 1;
      }
      case 'replaceString': {
        const full = model.getValue();
        const idx = full.indexOf(op.find);
        if (idx === -1) {
          const line = model.getLineCount();
          const column = model.getLineMaxColumn(line);
          await this.typeAt(editor, model, { lineNumber: line, column }, `\n${op.replace}`);
          return line + 1;
        }
        const start = model.getPositionAt(idx);
        const end = model.getPositionAt(idx + op.find.length);
        model.applyEdits([
          { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: '' },
        ]);
        await this.typeAt(editor, model, { lineNumber: start.lineNumber, column: start.column }, op.replace);
        return start.lineNumber;
      }
      case 'insertAfter': {
        const anchorLine = this.findAnchor(model, op.anchor);
        if (anchorLine === -1) return -1;
        const column = model.getLineMaxColumn(anchorLine);
        await this.typeAt(editor, model, { lineNumber: anchorLine, column }, `\n${op.text}`);
        return anchorLine + (op.text.startsWith('\n') ? 2 : 1);
      }
      case 'replaceLine': {
        const anchorLine = this.findAnchor(model, op.anchor);
        if (anchorLine === -1) return -1;
        const maxColumn = model.getLineMaxColumn(anchorLine);
        model.applyEdits([{ range: new monaco.Range(anchorLine, 1, anchorLine, maxColumn), text: '' }]);
        await this.typeAt(editor, model, { lineNumber: anchorLine, column: 1 }, op.text);
        return anchorLine;
      }
    }
  }

  private async typeAt(
    editor: monaco.editor.ICodeEditor,
    model: monaco.editor.ITextModel,
    start: Pos,
    text: string,
  ) {
    let pos: Pos = { ...start };
    for (const ch of text) {
      model.applyEdits([
        { range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: ch },
      ]);
      pos =
        ch === '\n'
          ? { lineNumber: pos.lineNumber + 1, column: 1 }
          : { lineNumber: pos.lineNumber, column: pos.column + 1 };
      editor.revealLineInCenterIfOutsideViewport(pos.lineNumber);
      await sleep(14);
    }
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
}
