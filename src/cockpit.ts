import { monaco } from './monaco-env';
import { renderMarkdown } from './markdown';
import { storedImageUrl } from './images';
import type {
  AgentEvent,
  EditOp,
  QuestionSpec,
  TodoItem,
  TranscriptImage,
} from './agent/protocol';

const sleep = (ms: number) =>
  document.hidden ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** Tools whose row names a file — clicking one opens it in the File pane
 *  instead of expanding its (mostly unhelpful) raw detail in place. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);

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
  /** This pane's own typewriter timer, so panes can reveal concurrently. A
   *  timeout — not requestAnimationFrame — because an occluded or backgrounded
   *  window produces no frames, which would freeze the stream mid-reveal until
   *  the user interacted; timers keep advancing the DOM even while unpainted. */
  revealTimer: number;
  tools: Map<string, HTMLElement>;
  /** Live subagent rows, keyed by the Task tool_use id, so their inner tool
   *  calls can be counted onto them as a working heartbeat. The row outlives its
   *  own tool_end — the SDK delivers a subagent's Task tool_result up front,
   *  before the forwarded inner calls stream in — so the end is stashed here
   *  (`ended`/`ok`/`detail`) and applied when the turn settles, not on tool_end. */
  subagents: Map<string, { steps: number; label: HTMLElement; ended?: boolean; ok?: boolean; detail?: string }>;
  todos: HTMLElement | null;
  /** The "thinking" spinner under the prompt (+ its interval), while it thinks. */
  spinner: HTMLElement | null;
  spinnerTimer: number;
  /** Whether a turn is in flight in this pane — set on the user's prompt, cleared
   *  on `done`. Gates the working spinner so it never lingers between turns. */
  turnLive: boolean;
  /** Whether the stored transcript has been replayed into this pane yet. */
  restored: boolean;
};

export class Cockpit {
  private conversations: HTMLElement;
  private status: HTMLElement;
  private diffEditor: monaco.editor.IStandaloneDiffEditor;
  private models: monaco.editor.ITextModel[] = [];

  private panes = new Map<string, Pane>();
  /** The current render target — the visible pane, except while a background
   * run's event is being handled (swapped for that call only). */
  private pane!: Pane;
  /** The pane actually on screen. Scrolling and the diff surface follow this. */
  private visible!: Pane;

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

  /** A Read/Edit/Write/MultiEdit row was clicked — open that file in the File pane. */
  private onOpenFile: (cwd: string, path: string) => void;
  /** A plan was approved in the transcript — let the composer leave plan mode. */
  private onPlanApproved: (cwd: string) => void;

  constructor(
    onOpenFile: (cwd: string, path: string) => void,
    onPlanApproved: (cwd: string) => void,
  ) {
    this.onOpenFile = onOpenFile;
    this.onPlanApproved = onPlanApproved;
    this.conversations = document.getElementById('conversation')!;
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

    this.pane = this.visible = this.paneFor('default');
    this.showPane('default');
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
        revealTimer: 0,
        tools: new Map(),
        subagents: new Map(),
        todos: null,
        spinner: null,
        spinnerTimer: 0,
        turnLive: false,
        restored: false,
      };
      this.panes.set(key, pane);
    }
    return pane;
  }

  /**
   * Markdown renders from the bubble's whole (revealed) source, because a delta
   * that closes a fence or starts a list changes blocks already on screen.
   */
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
    const pane = this.pane;
    // Snap the typewriter to the end so a bubble never freezes half-revealed.
    if (pane.revealTimer) {
      clearTimeout(pane.revealTimer);
      pane.revealTimer = 0;
    }
    pane.bubbleShown = pane.bubbleText.length;
    if (pane.bubbleBody) this.draw(pane);
    pane.bubbleType = null;
    pane.bubbleBody = null;
    pane.bubbleText = '';
    pane.bubbleShown = 0;
  }

  /** Drop a pane's drawn transcript and every live handle into it. */
  private blankPane(pane: Pane) {
    if (pane.revealTimer) {
      clearTimeout(pane.revealTimer);
      pane.revealTimer = 0;
    }
    if (pane.spinnerTimer) {
      clearInterval(pane.spinnerTimer);
      pane.spinnerTimer = 0;
    }
    pane.spinner = null;
    pane.turnLive = false;
    pane.el.innerHTML = '';
    pane.bubbleType = null;
    pane.bubbleBody = null;
    pane.bubbleText = '';
    pane.bubbleShown = 0;
    pane.tools.clear();
    pane.subagents.clear();
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
    // handleEvent aims each event at `key`'s pane and runs synchronously, so the
    // whole replay lands atomically — no way to switch panes mid-stream.
    for (const event of events) this.handleEvent(key, event, true);
  }

  /**
   * Make `key`'s transcript the visible one. Panes are kept in the DOM, so
   * switching worktrees mid-flight never loses a conversation.
   */
  showPane(key: string) {
    this.visible = this.pane = this.paneFor(key);
    for (const [k, p] of this.panes) p.el.classList.toggle('visible', k === key);
    // The diff/status surface is shared and single — it can't show two worktrees
    // at once, so clear it on switch. The now-visible run rebuilds it on its next
    // edit, and the Changes tab is the reliable per-worktree view meanwhile.
    this.resetDiff();
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
    if (this.visible === pane) this.showPane('default');
  }

  /**
   * Full teardown of a worktree's transcript plus the diff surface. Defaults to
   * the visible pane (the `/clear` path), but takes a key so the rail's "Reset
   * session" button can clear a worktree that isn't currently on screen.
   */
  reset(key: string = this.visible.key) {
    const pane = this.panes.get(key);
    if (pane) {
      this.blankPane(pane);
      // A cleared pane must not replay its now-deleted events if reopened.
      pane.restored = true;
    }
    window.cockpit?.store.clearTranscript(key);
    // The diff surface is shared and shows the visible worktree — only wipe it
    // when the worktree being reset is the one on screen.
    if (key === this.visible.key) this.resetDiff();
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
    this.status.textContent = '';
    this.diffEditor.setModel(null);
    this.models.forEach((m) => m.dispose());
    this.models = [];
    this.thoughts = [];
    this.thoughtCollection = null;
  }

  /**
   * The reliable "what changed" view: a worktree's unified git diff. Only the
   * contents — which pane is on screen belongs to the workspace switcher in
   * main.ts, so the two can't disagree about what's visible.
   */
  async showChanges(diff: string) {
    document.getElementById('changes')!.innerHTML = diff.trim()
      ? await monaco.editor.colorize(diff, 'diff', {})
      : '<div class="changes-empty">No uncommitted changes in this worktree.</div>';
  }

  /**
   * Route one event into `key`'s pane. Swapping the render target for just this
   * synchronous call is what lets several worktrees stream at once without their
   * transcripts bleeding together. A live event also marks the pane current, so
   * a later click never replays the store on top of it.
   */
  handleEvent(key: string, event: AgentEvent, replaying = false) {
    const target = this.paneFor(key);
    if (!replaying) target.restored = true;
    const prev = this.pane;
    this.pane = target;
    try {
      this.handle(event, replaying);
    } finally {
      this.pane = prev;
    }
  }

  /**
   * Draw one event into the current render target (`this.pane`). Synchronous, so
   * handleEvent's pane swap stays atomic. `replaying` marks events coming back
   * from the store — same transcript, but nothing live to animate.
   */
  private handle(event: AgentEvent, replaying = false) {
    switch (event.type) {
      case 'user':
        this.addUser(event.text, event.images ?? []);
        break;
      case 'thinking':
        // Thinking text is usually omitted (empty). Don't open a blank bubble
        // for it — the spinner (kept alive by syncSpinner below) is what carries
        // "thinking, nothing shown yet". Only draw a bubble for real content.
        if (!event.text.trim()) break;
        this.appendDelta('thinking', event.text, replaying);
        break;
      case 'say':
        this.appendDelta('say', event.text, replaying);
        break;
      case 'plan':
        this.renderPlan(event.id, event.text, replaying);
        break;
      case 'tool_start':
        this.startTool(event.id, event.name, event.summary, event.detail, event.parent);
        break;
      case 'tool_end':
        this.endTool(event.id, event.ok, event.detail);
        break;
      case 'todos':
        this.renderTodos(event.items);
        break;
      case 'question':
        this.renderQuestion(event.id, event.questions, replaying);
        break;
      case 'edit_start':
        // Break the transcript bubble now, in event order; the diff catches up.
        this.closeBubble();
        // The diff is one shared surface, so only the *visible* worktree's run
        // drives it. A background run's edits still record as tool rows in its
        // own transcript, and show in its Changes tab via git. (Replayed history
        // drops the contents + ops, so there is nothing to type out either way.)
        if (!replaying && this.pane === this.visible) {
          this.enqueue(() => this.startEdit(event.file, event.language, event.original));
        }
        break;
      case 'edit_op':
        if (this.pane === this.visible) this.enqueue(() => this.applyEditOp(event.op));
        break;
      case 'edit_end':
        if (this.pane === this.visible) {
          this.enqueue(() => {
            const done = this.status.textContent.replace('✎ editing', '✓ edited');
            this.status.textContent = this.appliedWhole ? `${done} · applied at once` : done;
          });
        }
        break;
      case 'error':
        this.closeBubble();
        this.addMessage('error').textContent = `⚠ ${event.message}`;
        break;
      case 'done':
        this.endTurn(event.interrupted);
        break;
    }
    // History replays instantly — there's nothing live to spin for.
    if (!replaying) this.syncSpinner(event);
  }

  /**
   * Keep a "working" spinner pinned to the bottom of the transcript for exactly
   * as long as the agent is churning with nothing visible to show. The old wiring
   * tore it down on any non-text event and only ever brought it back on an empty
   * `thinking` delta — so a running tool, and above all a subagent whose forwarded
   * heartbeat is the only traffic, would sit spinner-less and the pane looked
   * frozen. Here one rule drives it: spin while the turn is live and the agent is
   * neither streaming visible text (the typewriter is its own signal) nor blocked
   * on the operator (a question or plan) nor done.
   */
  private syncSpinner(event: AgentEvent) {
    if (event.type === 'user') this.pane.turnLive = true;
    else if (event.type === 'done') this.pane.turnLive = false;

    const streamingText = event.type === 'say' || (event.type === 'thinking' && !!event.text.trim());
    const waitingOnOperator = event.type === 'question' || event.type === 'plan';

    if (this.pane.turnLive && !streamingText && !waitingOnOperator && event.type !== 'done') {
      this.ensureSpinner();
    } else {
      this.stopSpinner();
    }
  }

  private scrollDown() {
    // Only the visible pane is on screen; a background run must not yank scroll.
    if (this.pane !== this.visible) return;
    this.conversations.scrollTop = this.conversations.scrollHeight;
  }

  private addMessage(cls: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    this.pane.el.appendChild(el);
    this.scrollDown();
    return el;
  }

  /**
   * The operator's turn. Screenshots sit above the words they were pasted with —
   * the order Claude reads them in — and stay thumbnails until clicked, so a
   * turn that carried four of them doesn't push the conversation off the screen.
   */
  private addUser(text: string, images: TranscriptImage[] = []) {
    this.closeBubble();
    const wrap = this.addMessage('user');

    if (images.length) {
      const strip = document.createElement('div');
      strip.className = 'user-images';
      for (const image of images) {
        const thumb = document.createElement('img');
        thumb.className = 'user-image';
        thumb.src = image.kind === 'inline' ? image.dataUrl : storedImageUrl(image.file);
        thumb.alt = 'pasted image';
        thumb.title = 'Click to enlarge';
        thumb.addEventListener('click', () => thumb.classList.toggle('zoomed'));
        strip.append(thumb);
      }
      wrap.append(strip);
    }

    // A screenshot on its own is a whole prompt — don't leave an empty line
    // under it where the text would have been.
    if (text) {
      const body = document.createElement('div');
      body.className = 'user-text';
      body.textContent = text;
      wrap.append(body);
    }
    this.scrollDown();
  }

  private startTool(id: string, name: string, summary: string, detail?: string, parent?: string) {
    // A tool that ran inside a subagent isn't a row of its own — it's one tick
    // of that subagent's work. Count it onto the subagent's row instead.
    if (parent) {
      const sub = this.pane.subagents.get(parent);
      if (sub) {
        sub.steps++;
        this.paintSubagent(parent);
        return;
      }
      // Parent unknown (its row scrolled out of a replay, say) — fall through
      // and draw it as an ordinary row rather than dropping it.
    }

    this.closeBubble();
    const isSubagent = name === 'Task' || name === 'Agent';
    const row = this.addMessage('tool running');
    if (isSubagent) row.classList.add('subagent');
    // The file itself, not its raw tool output, is what's useful to look at —
    // route the click to the File pane instead of the usual expand-in-place.
    const filePath = FILE_TOOLS.has(name) ? summary : '';
    const cwd = this.pane.key;
    if (filePath) row.classList.add('openable');

    const head = document.createElement('div');
    head.className = 'tool-head';
    head.innerHTML =
      '<span class="tool-glyph"></span><span class="tool-name"></span>' +
      '<span class="tool-summary"></span><span class="tool-steps"></span><span class="tool-caret"></span>';
    head.querySelector('.tool-name')!.textContent = isSubagent ? 'Subagent' : name;
    head.querySelector('.tool-summary')!.textContent = summary;
    if (filePath) head.title = 'Open in File pane';

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
      if (filePath) {
        this.onOpenFile(cwd, filePath);
        return;
      }
      if (body.childElementCount > 0) row.classList.toggle('expanded');
    });
    this.syncToolBody(row);
    this.pane.tools.set(id, row);
    if (isSubagent) {
      this.pane.subagents.set(id, { steps: 0, label: head.querySelector('.tool-steps')! });
      this.paintSubagent(id);
    }
  }

  /** The subagent row's live status — "working" while it churns, then its final
   *  step count once it's done. */
  private paintSubagent(id: string, done = false) {
    const sub = this.pane.subagents.get(id);
    if (!sub) return;
    const steps = sub.steps === 1 ? '1 step' : `${sub.steps} steps`;
    sub.label.textContent = done
      ? `· done · ${steps}`
      : sub.steps
        ? `· working… · ${steps}`
        : '· working…';
  }

  private endTool(id: string, ok: boolean, detail?: string) {
    const row = this.pane.tools.get(id);
    if (!row) return;
    // A subagent's tool_end is its Task tool_result, which the SDK delivers up
    // front — before the subagent's forwarded inner tool calls stream in as
    // parented heartbeat events. Settling (and deleting) the row here would
    // un-fold every one of those late calls: they'd draw as stray rows that tear
    // the transcript, and the step tally would freeze at zero. So defer it —
    // stash the outcome, leave the row "working" and in the maps so children
    // keep folding onto it, and settle every open subagent at endTurn instead.
    const sub = this.pane.subagents.get(id);
    if (sub) {
      sub.ended = true;
      sub.ok = ok;
      if (detail) sub.detail = detail;
      return;
    }
    this.pane.tools.delete(id);
    this.settleTool(row, ok, detail);
  }

  /** Flip a finished tool row from running to its ✓/✘ state and hang its output
   *  body off it (unless the row opens a file on click instead of expanding). */
  private settleTool(row: HTMLElement, ok: boolean, detail?: string) {
    row.classList.remove('running');
    row.classList.add(ok ? 'ok' : 'failed');
    // An openable row's click opens the file, not the raw result — skip
    // building an expandable body it can never be clicked open to reveal.
    if (detail && !row.classList.contains('openable')) {
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

  /**
   * An interactive multiple-choice question from the agent. The turn is blocked
   * in the SDK until answer() feeds a result back, so this stays clickable until
   * the operator picks. A single single-select question submits on one click;
   * anything richer collects selections behind a "Send answer" button.
   */
  private renderQuestion(id: string, questions: QuestionSpec[], replaying = false) {
    this.closeBubble();
    const cwd = this.pane.key;
    const wrap = this.addMessage('question');
    const picks: Set<string>[] = questions.map(() => new Set<string>());
    const submitBtns: HTMLButtonElement[] = [];
    const singleShot = questions.length === 1 && !questions[0]?.multiSelect;

    const finish = () => {
      if (wrap.classList.contains('answered')) return;
      wrap.classList.add('answered');
      wrap.querySelectorAll('button').forEach((b) => (b.disabled = true));
      const summary = questions
        .map((q, i) => `${q.header}: ${[...picks[i]].join(', ')}`)
        .join('\n');
      const chosen = document.createElement('div');
      chosen.className = 'question-answer';
      chosen.textContent = `↳ ${questions.map((_, i) => [...picks[i]].join(', ')).filter(Boolean).join(' · ')}`;
      wrap.append(chosen);
      void window.cockpit?.agent.answer(cwd, id, summary);
    };

    const refreshSubmit = () => {
      const ready = picks.every((s) => s.size > 0);
      for (const b of submitBtns) b.disabled = !ready;
    };

    questions.forEach((q, i) => {
      const qEl = document.createElement('div');
      qEl.className = 'question-item';
      qEl.innerHTML =
        '<div class="question-head"><span class="question-chip"></span>' +
        '<span class="question-text"></span></div>';
      qEl.querySelector('.question-chip')!.textContent = q.header;
      qEl.querySelector('.question-text')!.textContent = q.question;

      const opts = document.createElement('div');
      opts.className = 'question-options';
      for (const opt of q.options) {
        const b = document.createElement('button');
        b.className = 'question-option';
        b.innerHTML = '<span class="opt-label"></span><span class="opt-desc"></span>';
        b.querySelector('.opt-label')!.textContent = opt.label;
        b.querySelector('.opt-desc')!.textContent = opt.description;
        b.addEventListener('click', () => {
          if (wrap.classList.contains('answered')) return;
          if (q.multiSelect) {
            if (picks[i].has(opt.label)) {
              picks[i].delete(opt.label);
              b.classList.remove('selected');
            } else {
              picks[i].add(opt.label);
              b.classList.add('selected');
            }
          } else {
            picks[i].clear();
            picks[i].add(opt.label);
            opts.querySelectorAll('.question-option').forEach((o) => o.classList.remove('selected'));
            b.classList.add('selected');
          }
          if (singleShot) finish();
          else refreshSubmit();
        });
        opts.append(b);
      }
      qEl.append(opts);
      wrap.append(qEl);
    });

    if (!singleShot) {
      const submit = document.createElement('button');
      submit.className = 'question-submit';
      submit.textContent = 'Send answer';
      submit.disabled = true;
      submit.addEventListener('click', finish);
      submitBtns.push(submit);
      wrap.append(submit);
    }

    // A replayed question is history — the turn that asked it is long over.
    if (replaying) {
      wrap.classList.add('answered', 'past');
      wrap.querySelectorAll('button').forEach((b) => (b.disabled = true));
    }

    this.scrollDown();
  }

  private endTurn(interrupted?: boolean) {
    // Stop means stop: typing dumps its remaining text instead of playing on.
    if (interrupted) this.fastForward = true;
    this.closeBubble();
    // Settle the subagent rows whose tool_end we deferred so their forwarded
    // heartbeat could keep folding: paint the final count and land the ✓/✘ and
    // report body now. A subagent that never saw its end (interrupted before the
    // Task returned) settles as failed, like any other cut-off tool.
    for (const [id, sub] of this.pane.subagents) {
      this.paintSubagent(id, true);
      const row = this.pane.tools.get(id);
      if (row) {
        this.pane.tools.delete(id);
        this.settleTool(row, sub.ended ? sub.ok ?? true : false, sub.detail);
      }
    }
    this.pane.subagents.clear();
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
   * Typewriter: advance the revealed length toward the received text one tick at
   * a time. The step scales with the backlog so a fast stream still clears within
   * ~half a second, but never lands fewer than a couple chars per tick. Ticks are
   * timeouts, not animation frames: an occluded or backgrounded window produces
   * no frames, so an rAF loop would freeze the reveal mid-stream and only flush
   * when the user next interacted — a timer keeps the DOM advancing regardless,
   * so returning to the window shows the finished transcript, not a frozen half.
   */
  private revealTick(pane: Pane) {
    if (pane.revealTimer) return;
    const step = () => {
      pane.revealTimer = 0;
      const remaining = pane.bubbleText.length - pane.bubbleShown;
      if (remaining <= 0) return;
      pane.bubbleShown += Math.max(2, Math.ceil(remaining / 30));
      if (pane.bubbleShown > pane.bubbleText.length) pane.bubbleShown = pane.bubbleText.length;
      this.draw(pane);
      // This pane may be a background run — only follow scroll if it's on screen.
      if (pane === this.visible) this.conversations.scrollTop = this.conversations.scrollHeight;
      if (pane.bubbleShown < pane.bubbleText.length) pane.revealTimer = window.setTimeout(step, 16);
    };
    pane.revealTimer = window.setTimeout(step, 16);
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

  /**
   * Show the spinner, or — if it's already going — move it back below whatever
   * content just landed so it stays the last thing in the transcript. Moving the
   * node keeps the animation running; recreating it would reset the frame on
   * every step and read as a stutter rather than a steady spin.
   */
  private ensureSpinner() {
    if (this.pane.spinner) {
      this.pane.el.appendChild(this.pane.spinner);
      this.scrollDown();
      return;
    }
    this.startSpinner();
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

  /**
   * The agent's plan, from ExitPlanMode, awaiting approval. Like renderQuestion,
   * the turn is blocked in the SDK until answer() feeds a decision back, so the
   * buttons stay live until the operator picks. Approve lets the turn carry the
   * plan out (and clears the composer's ◈ Plan toggle); Reject sends it back to
   * revise, keeping the session in plan mode.
   */
  private renderPlan(id: string, text: string, replaying = false) {
    this.closeBubble();
    const cwd = this.pane.key;
    const wrap = this.addMessage('plan');

    const heading = document.createElement('div');
    heading.className = 'plan-title';
    heading.textContent = '◈ Plan';
    wrap.append(heading);

    const body = document.createElement('div');
    body.className = 'plan-body text';
    body.innerHTML = renderMarkdown(text || '_(no plan text)_');
    wrap.append(body);

    const actions = document.createElement('div');
    actions.className = 'plan-actions';

    const decide = (decision: 'approve' | 'reject', label: string) => {
      if (wrap.classList.contains('answered')) return;
      wrap.classList.add('answered');
      wrap.querySelectorAll('button').forEach((b) => (b.disabled = true));
      const chosen = document.createElement('div');
      chosen.className = 'plan-decision';
      chosen.textContent = `↳ ${label}`;
      wrap.append(chosen);
      if (decision === 'approve') this.onPlanApproved(cwd);
      void window.cockpit?.agent.answer(cwd, id, decision);
    };

    const approve = document.createElement('button');
    approve.className = 'plan-approve';
    approve.textContent = 'Approve plan';
    approve.addEventListener('click', () => decide('approve', 'Approved'));

    const reject = document.createElement('button');
    reject.className = 'plan-reject';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => decide('reject', 'Rejected'));

    actions.append(approve, reject);
    wrap.append(actions);

    // A replayed plan is history — the turn that proposed it is long since over.
    if (replaying) {
      wrap.classList.add('answered', 'past');
      wrap.querySelectorAll('button').forEach((b) => (b.disabled = true));
    }

    this.scrollDown();
  }

  private startEdit(file: string, language: string, original: string) {
    this.appliedWhole = false;
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
  { key = 'default', reset = true }: { key?: string; reset?: boolean } = {},
) {
  if (reset) ui.reset();
  for await (const event of source) {
    // Route to this run's own worktree pane, so it keeps unspooling there even
    // while another worktree is on screen.
    ui.handleEvent(key, event);
    if (event.type === 'done') break;
  }
  // Events are done, but the diff may still be typing the last edit out.
  await ui.settleEdits();
}
