import { monaco } from './monaco-env';
import type { AgentEvent, EditOp, PlanItem } from './agent/protocol';

const sleep = (ms: number) =>
  document.hidden ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

type Pos = { lineNumber: number; column: number };

export class Cockpit {
  private conversation: HTMLElement;
  private tabs: HTMLElement;
  private status: HTMLElement;
  private diffEditor: monaco.editor.IStandaloneDiffEditor;
  private models: monaco.editor.ITextModel[] = [];

  private bubbleType: 'thinking' | 'say' | null = null;
  private bubbleBody: HTMLElement | null = null;

  private thoughts: monaco.editor.IModelDeltaDecoration[] = [];
  private thoughtCollection: monaco.editor.IEditorDecorationsCollection | null = null;

  constructor() {
    this.conversation = document.getElementById('conversation')!;
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

  reset() {
    this.conversation.innerHTML = '';
    this.tabs.innerHTML = '';
    this.status.textContent = '';
    this.diffEditor.setModel(null);
    this.models.forEach((m) => m.dispose());
    this.models = [];
    this.bubbleType = null;
    this.bubbleBody = null;
    this.thoughts = [];
    this.thoughtCollection = null;
  }

  async handle(event: AgentEvent) {
    switch (event.type) {
      case 'thinking':
      case 'say':
        this.appendDelta(event.type, event.text);
        break;
      case 'plan':
        await this.renderPlan(event.title, event.items);
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
        this.bubbleType = null;
        this.addMessage('error').textContent = `⚠ ${event.message}`;
        break;
      case 'done':
        break;
    }
  }

  private scrollDown() {
    this.conversation.scrollTop = this.conversation.scrollHeight;
  }

  private addMessage(cls: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    this.conversation.appendChild(el);
    this.scrollDown();
    return el;
  }

  private appendDelta(type: 'thinking' | 'say', text: string) {
    if (this.bubbleType !== type || !this.bubbleBody) {
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
      this.bubbleType = type;
      this.bubbleBody = body;
    }
    this.bubbleBody.textContent += text;
    this.scrollDown();
  }

  private async renderPlan(title: string, items: PlanItem[]) {
    this.bubbleType = null;
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
    this.bubbleType = null;
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

export async function runStream(ui: Cockpit, source: AsyncIterable<AgentEvent>) {
  ui.reset();
  for await (const event of source) {
    await ui.handle(event);
    if (event.type === 'done') break;
  }
}
