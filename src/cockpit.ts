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
/** How close to the bottom (px) still counts as "following the stream", so the
 *  operator has to scroll back to within this slack to re-lock auto-follow. */
const FOLLOW_SLACK = 32;
/** Per-glyph reveal: each freshly-typed character eases up from below and fades
 *  in over this long (kept in sync with the `tw-in` keyframe in style.css). */
const REVEAL_FADE_MS = 280;
/** How many trailing glyphs are mid-fade at once. A glyph older than this is
 *  settled to plain text — so the animated window stays small and cheap even as
 *  the whole bubble re-renders each tick. */
const REVEAL_FADE_WINDOW = 24;
/** Typewriter cadence: reveal this many chars per tick as a steady baseline, so a
 *  bubble types at a constant rate rather than lurching with the network's chunk
 *  boundaries — a single-char delta no longer flashes and freezes. */
const REVEAL_STEP = 2;
/** Chars the reveal is allowed to trail the received text before it stops pacing
 *  and accelerates to catch up. Below this, the drain holds the steady REVEAL_STEP
 *  cadence; above it (a flood, or a backlog piled up while occluded) the step
 *  jumps to pull the lag back to this cap, so catch-up lands in ~0.7s rather than
 *  dribbling for seconds. It also bounds the tail a closing bubble finishes on its
 *  own clock (see `closeBubble`). */
const REVEAL_MAX_LAG = 90;
/** Chunky follow: don't start chasing until the caret has drifted this far (px)
 *  below its resting line. Small reveals type in place; only a real chunk earns a
 *  chase, so slow typing reads as deliberate overscroll-typewriter-overscroll
 *  beats rather than a per-tick creep. Once chasing, the caret is tracked
 *  continuously (a fast burst never waits for the next chunk). */
const CHUNK_TRIGGER = 48;
/** Where the caret (bottom of the newest content) rests once the chase catches
 *  up: this far (px) above the viewport bottom, so the live text is always in
 *  view with room beneath it to type into. Must exceed CHUNK_TRIGGER so the
 *  caret's whole drift band stays above the fold. The turn-end settle leaves the
 *  caret right here (see `settleDown`) rather than tightening to the bottom, so
 *  the transcript never bumps UP as a turn ends — which means the resting
 *  `.transcripts` bottom padding is kept equal to this value, so dropping the
 *  trailing pad lands the caret in the same spot with no clamp. Keep them in sync. */
const REST_GAP = 100;
/** Fraction of the remaining caret distance the chase closes per 16ms frame — a
 *  critically-damped approach, so scrollTop eases toward the live target and
 *  self-adjusts as text floods or dribbles. Re-read every frame (unlike a
 *  time-based ease), it tracks a moving target without ever overshooting, which
 *  is what keeps a reflowing bubble smooth instead of jittery. */
const CHASE_RATE = 0.22;
/** Ceiling on how fast the chase scrolls (px per 16ms frame). The exponential
 *  alone would take a huge first step to close a big backlog — smooth on paper
 *  but a jarring zoom on screen. Capping the speed turns a long catch-up into a
 *  deliberate glide that then eases in, without slowing the common short hops. */
const MAX_CHASE_STEP = 64;
/** Duration of the overscroll bounce that flourishes a caught-up chase. */
const BOUNCE_MS = 200;
/** How far (px) the content rubber-bands past the resting line when a chase
 *  catches up, before easing back. While a turn is live the bounce scrolls into
 *  the trailing pad; the collapsed `.transcripts` padding reserves it for the
 *  final settle too, so the overshoot is always a real scroll, never a clamp. */
const OVERSCROLL = 14;
/** Trailing slack added below the content while a turn streams (as a spacer
 *  child, see `beginTrail`), as a multiple of the viewport, so the caret always
 *  floats and a fast burst can never push scrollTop to the max — which is what
 *  bottomed the follow out and jittered. */
const TRAIL_VIEWPORTS = 1.5;

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

  /** While true, the transcript pins to the bottom as the agent types. The
   *  operator scrolling up releases it (they take over); scrolling back to the
   *  bottom, or the next turn starting, re-locks it. See `onScroll`. */
  private autoFollow = true;
  /** Last seen scrollTop, to tell an operator's upward scroll (which releases
   *  auto-follow) from our own downward pins (which never should). */
  private lastScrollTop = 0;
  /** The exact scrollTop we last wrote ourselves. `onScroll` ignores an event
   *  landing here — only a gesture the operator made lands somewhere else — so
   *  our own glides and the upward settle of the bounce never read as a takeover. */
  private writtenTop = 0;
  /** rAF handle for the in-flight caret chase (0 = idle). */
  private chaseRaf = 0;
  /** rAF handle for the in-flight overscroll bounce (0 = idle). */
  private bounceRaf = 0;
  /** Whether the large trailing pad is applied. It un-tethers the content bottom
   *  from `scrollHeight` while a turn streams, so growing text never shifts a
   *  hop's captured target underneath it. Dropped when the turn settles, the
   *  operator takes over, or the pane switches. See `beginTrail`/`endTrail`. */
  private trailOn = false;
  /** The trailing-slack element (see `beginTrail`), reused across turns. */
  private trailSpacer: HTMLElement | null = null;

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
    this.conversations.addEventListener('scroll', () => this.onScroll());
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
  private draw(pane: Pane, animate = false) {
    if (!pane.bubbleBody) return;
    this.drawInto(pane.bubbleBody, pane.bubbleText, pane.bubbleShown, animate);
  }

  /** Render `shown` chars of `text` into a specific bubble body. Split out from
   *  `draw` so a bubble detached from the pane slot (a close that finishes typing
   *  on its own clock, see `drainDetached`) can keep rendering into its own node
   *  after `pane.bubbleBody` has moved on to the next bubble. */
  private drawInto(body: HTMLElement, text: string, shown: number, animate: boolean) {
    body.innerHTML = renderMarkdown(text.slice(0, shown));
    if (animate) this.fadeInTail(body);
  }

  /**
   * Fade the freshly-revealed tail in, one glyph at a time — each eases up from
   * below (see the `tw-in` keyframe). The markdown is re-rendered whole every
   * tick, so we can't just append: instead we wrap the last REVEAL_FADE_WINDOW
   * glyphs and seek each one — via a negative `animation-delay` set from its
   * distance back from the caret — to where its fade should be. A glyph drifts
   * back through the window as more text arrives and is plain, settled text by
   * the time it leaves, so its animation reads as continuous across re-renders.
   * Whitespace stays unwrapped, so word wrapping and line breaks are unaffected.
   */
  private fadeInTail(root: HTMLElement) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    let rank = 0; // 0 = the caret-most glyph, counting back through the window.
    for (let t = texts.length - 1; t >= 0 && rank < REVEAL_FADE_WINDOW; t--) {
      const node = texts[t];
      const data = node.data;
      const take = Math.min(REVEAL_FADE_WINDOW - rank, data.length);
      const splitAt = data.length - take;
      const frag = document.createDocumentFragment();
      if (splitAt > 0) frag.append(document.createTextNode(data.slice(0, splitAt)));
      for (let i = splitAt; i < data.length; i++) {
        const ch = data[i];
        // Rank climbs right→left: the rightmost (newest) glyph is the least aged.
        const r = rank + (data.length - 1 - i);
        if (/\s/.test(ch)) {
          frag.append(document.createTextNode(ch));
          continue;
        }
        const span = document.createElement('span');
        span.className = 'tw-in';
        span.textContent = ch;
        span.style.animationDelay = `${-(r / REVEAL_FADE_WINDOW) * REVEAL_FADE_MS}ms`;
        frag.append(span);
      }
      node.replaceWith(frag);
      rank += take;
    }
  }

  /**
   * End the open bubble, so whatever comes next starts a fresh one. Anything
   * still pending is drawn first: a replay loop never yields to a frame, so the
   * scheduled render might otherwise land after the bubble had been let go.
   */
  private closeBubble(snap = false) {
    const pane = this.pane;
    if (pane.revealTimer) {
      clearTimeout(pane.revealTimer);
      pane.revealTimer = 0;
    }
    // A bubble that's still mid-reveal finishes typing on its own clock rather
    // than snapping to full — otherwise a type switch, a tool row, or a plan
    // makes the open text jump to completion with no typewriter (the "instant
    // chunk" jitter). `snap` forces the old instant behaviour where the reveal
    // must not play on: an operator turn, an error, or the turn ending (whose
    // settle wants a stable final height). A bubble already fully revealed, or
    // with no body, has nothing to drain and is torn down at once regardless.
    const body = pane.bubbleBody;
    if (body) {
      if (snap || pane.bubbleShown >= pane.bubbleText.length) {
        pane.bubbleShown = pane.bubbleText.length;
        this.draw(pane);
      } else {
        this.drainDetached(pane, body, pane.bubbleText, pane.bubbleShown);
      }
    }
    pane.bubbleType = null;
    pane.bubbleBody = null;
    pane.bubbleText = '';
    pane.bubbleShown = 0;
  }

  /** Finish typing a bubble that's been let go of the pane slot: it keeps its own
   *  captured text/index and self-schedules to completion, so the next bubble can
   *  claim the slot and stream immediately while this one types out its tail. The
   *  tail is bounded by REVEAL_MAX_LAG, so it never lags more than a beat. Stops
   *  if the node is torn out of the DOM (a pane wipe), so a `/clear` mid-drain
   *  leaves no orphaned timer painting a detached node. */
  private drainDetached(pane: Pane, body: HTMLElement, text: string, shown: number) {
    const animate = pane === this.visible;
    const step = () => {
      if (!body.isConnected) return;
      const remaining = text.length - shown;
      if (remaining <= 0) return;
      shown = Math.min(text.length, shown + Math.max(REVEAL_STEP, remaining - REVEAL_MAX_LAG));
      this.drawInto(body, text, shown, animate);
      if (shown < text.length) window.setTimeout(step, TICK_MS);
    };
    window.setTimeout(step, TICK_MS);
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
    // A freshly-shown conversation follows the stream again; the shared scroll
    // position doesn't carry a per-pane offset to restore anyway. Snap (not
    // glide) so the pane appears already at the bottom, not scrolling toward it.
    this.autoFollow = true;
    this.snapBottom();
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
        // A new turn re-locks auto-follow: even if the operator had scrolled up
        // to read the last turn, their message and the reply that follows snap
        // back into view. (Only the on-screen conversation, not a background run.)
        if (this.pane === this.visible) this.autoFollow = true;
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
        this.closeBubble(true);
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

  /** A discrete new row (a turn, a tool, a plan) — glide to the bottom now,
   *  regardless of how little it added. Streaming reveals use `follow(false)`. */
  private scrollDown() {
    this.follow(true);
  }

  /**
   * Chunky auto-follow, anchored to the caret (the bottom of the newest content)
   * rather than to `scrollHeight`. While a turn streams, a large trailing pad
   * (see `beginTrail`) floats the content bottom in slack, so a fast burst can
   * never shove scrollTop to the max — which is what bottomed the old follow out
   * and jittered. The caret is meant to rest REST_GAP above the fold; once it has
   * drifted CHUNK_TRIGGER past that line we start a chase, so slow typing reads as
   * deliberate overscroll-typewriter-overscroll beats. `force` (discrete rows)
   * starts on any drift, not just a chunk.
   */
  private follow(force: boolean) {
    // Only the visible pane is on screen; a background run must not yank scroll.
    if (this.pane !== this.visible) return;
    // The operator scrolled up to read — leave their position alone until they
    // return to the bottom or the next turn re-locks follow.
    if (!this.autoFollow) return;
    // Occluded windows get no rAF frames (see revealTick), so an eased chase
    // would freeze mid-scroll — snap instead, so returning to the window shows
    // the tail rather than a stalled position.
    if (document.hidden) return this.snapBottom();
    // A chase is already running — it re-reads the caret every frame, so it's
    // already tracking whatever just arrived. A bounce re-checks on settle.
    if (this.chaseRaf || this.bounceRaf) return;
    const el = this.conversations;
    // How far the caret has drifted below its resting line.
    const overshoot = this.caretY() - (el.clientHeight - REST_GAP);
    if (overshoot <= (force ? 0.5 : CHUNK_TRIGGER)) return;
    this.beginTrail();
    this.chase(REST_GAP, true);
  }

  /** The caret's Y within the viewport: distance (px) from the top of the visible
   *  area to the bottom of the newest message. Rect-based, so it's immune to the
   *  trailing pad — unlike `scrollHeight`, which the pad inflates. */
  private caretY(): number {
    const last = this.pane.el.lastElementChild as HTMLElement | null;
    if (!last) return 0;
    return last.getBoundingClientRect().bottom - this.conversations.getBoundingClientRect().top;
  }

  /**
   * Exponential-smoothing chase: each frame, move scrollTop a fixed fraction
   * (CHASE_RATE, frame-rate corrected) of the way toward putting the caret `gap`
   * px above the viewport bottom. The target is re-read every frame from the
   * live caret, so a bubble reflowing underneath is tracked smoothly — the
   * approach is monotonic and never overshoots, which is precisely what a
   * time-based ease against a moving target could not do (it lurched). When the
   * caret has sat on its line for a few frames (the stream paused or ended) the
   * chase ends: `flourish` finishes with an overscroll bounce, else `then` runs.
   */
  private chase(gap: number, flourish: boolean, then?: () => void) {
    let last = 0;
    let stable = 0;
    const tick = (now: number) => {
      // Released, or switched away — abandon the chase.
      if (this.pane !== this.visible || !this.autoFollow) return void (this.chaseRaf = 0);
      const el = this.conversations;
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      const dist = this.caretY() - (el.clientHeight - gap);
      const k = 1 - Math.pow(1 - CHASE_RATE, dt / 16);
      // Exponential step, capped to a deliberate top speed so a big backlog
      // glides rather than snaps. dt-scaled, so the cap holds at any frame rate.
      const cap = MAX_CHASE_STEP * (dt / 16);
      const step = Math.max(-cap, Math.min(cap, dist * k));
      const before = el.scrollTop;
      this.setScroll(el.scrollTop + step);
      const moved = Math.abs(el.scrollTop - before);
      // End when the chase is at rest — either caught up (content stopped
      // growing), OR unable to make progress: near the target the step can fall
      // below the browser's scrollTop rounding granularity, so scrollTop never
      // actually moves and `dist` never crosses the 1.5px line. That spun the
      // rAF forever — the settle never dropped the trailing pad (dead space +
      // stranded scroll) and the live chaseRaf blocked `follow`, freezing auto-
      // follow until the next turn. Treating "can't move" as settled ends it.
      // (Also lands the short-content case, where scrollTop is pinned at 0/max.)
      const atRest = Math.abs(dist) < 1.5 || moved < 0.5;
      if (atRest) {
        if (++stable >= 3) {
          this.chaseRaf = 0;
          if (flourish) this.bounce(then);
          else then?.();
          return;
        }
      } else {
        stable = 0;
      }
      this.chaseRaf = requestAnimationFrame(tick);
    };
    this.chaseRaf = requestAnimationFrame(tick);
  }

  /** The overscroll flourish: content rubber-bands OVERSCROLL px past where the
   *  chase settled and eases back, a there-and-back sine so it lands with no
   *  discontinuity. The overshoot lives in the trailing pad, so it never exceeds
   *  the scroll max — no clamp. `then` runs on settle (default: re-check for a
   *  chunk that piled up during the bounce). */
  private bounce(then?: () => void) {
    const base = this.conversations.scrollTop;
    let t0 = 0;
    const tick = (now: number) => {
      if (this.pane !== this.visible || !this.autoFollow) return void (this.bounceRaf = 0);
      if (!t0) t0 = now;
      const q = Math.min(1, (now - t0) / BOUNCE_MS);
      this.setScroll(base + OVERSCROLL * Math.sin(Math.PI * q));
      if (q < 1) return void (this.bounceRaf = requestAnimationFrame(tick));
      this.bounceRaf = 0;
      this.setScroll(base);
      then ? then() : this.follow(false);
    };
    this.bounceRaf = requestAnimationFrame(tick);
  }

  /** The turn is over: chase the caret down to its natural resting line (just
   *  breathing room above the bottom) so the *full* final text lands cleanly in
   *  view, then drop the trailing pad and pin exactly — invisibly, since the pad
   *  is all below the fold once the caret has settled there. */
  private settle() {
    if (this.pane !== this.visible || !this.trailOn) return;
    // Released or occluded — no chase to run; just collapse the pad in place.
    if (!this.autoFollow || document.hidden) return this.snapBottom();
    if (this.chaseRaf) cancelAnimationFrame(this.chaseRaf), (this.chaseRaf = 0);
    if (this.bounceRaf) cancelAnimationFrame(this.bounceRaf), (this.bounceRaf = 0);
    this.settleDown();
  }

  /**
   * End of turn: leave the caret exactly where it streamed and drop the pad.
   *
   * DOWN-ONLY. The transcript must never scroll UP to settle — an upward "bump"
   * as a turn ends (after a fast burst fills the screen) reads as broken. So the
   * caret is only ever eased DOWN, and only if the turn ended with it still below
   * its rest line (a burst the chase hadn't caught up to yet); if it's already at
   * or above the line, nothing moves at all. The resting `.transcripts` bottom
   * padding equals REST_GAP, so once the caret is at rest, dropping the (below-
   * the-fold) trailing pad lands it in exactly the same place — no clamp, no jump.
   * Re-reads the caret each frame, so a late reflow can't leave the last line
   * clipped. Mirrors `chase`'s stuck-detection (`moved < 0.5`) so a sub-pixel
   * residual can't spin the rAF forever.
   */
  private settleDown() {
    const el = this.conversations;
    let last = 0;
    let stable = 0;
    const tick = (now: number) => {
      if (this.pane !== this.visible || !this.autoFollow) return void (this.chaseRaf = 0);
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      // Positive = caret below its rest line (still catching up); clamp to >= 0 so
      // a caret already at/above rest is never pulled upward.
      const down = Math.max(0, this.caretY() - (el.clientHeight - REST_GAP));
      const k = 1 - Math.pow(1 - CHASE_RATE, dt / 16);
      const step = Math.min(MAX_CHASE_STEP * (dt / 16), down * k);
      const before = el.scrollTop;
      this.setScroll(el.scrollTop + step);
      const moved = el.scrollTop - before;
      if (down < 1.5 || moved < 0.5) {
        if (++stable >= 3) {
          this.chaseRaf = 0;
          this.endTrail();
          return;
        }
      } else {
        stable = 0;
      }
      this.chaseRaf = requestAnimationFrame(tick);
    };
    this.chaseRaf = requestAnimationFrame(tick);
  }

  /** Un-tether the content bottom: TRAIL_VIEWPORTS of trailing slack so the caret
   *  floats and a fast burst can never push scrollTop to the max. A spacer *child*
   *  of the scroll container — NOT `padding-bottom`, which escapes the flex/grid
   *  sizing and grows the pane, shoving the composer off screen; a child is
   *  contained by `overflow` exactly as message content is. It sits after the
   *  panes, so `caretY` (which reads inside the pane) never measures it.
   *  Idempotent for the life of a turn. */
  private beginTrail() {
    if (this.trailOn) return;
    this.trailOn = true;
    const el = this.conversations;
    if (!this.trailSpacer) {
      this.trailSpacer = document.createElement('div');
      this.trailSpacer.setAttribute('aria-hidden', 'true');
    }
    this.trailSpacer.style.height = `${Math.round(el.clientHeight * TRAIL_VIEWPORTS)}px`;
    el.appendChild(this.trailSpacer);
  }

  /** Drop the trailing spacer back to the CSS resting state. */
  private endTrail() {
    if (!this.trailOn) return;
    this.trailOn = false;
    this.trailSpacer?.remove();
  }

  /** Jump straight to the natural bottom — for pane switches, occluded windows,
   *  and the exact landing after a settle chase. Drops the trailing pad first so
   *  "bottom" means the content's bottom, not the pad's. */
  private snapBottom() {
    if (this.chaseRaf) cancelAnimationFrame(this.chaseRaf), (this.chaseRaf = 0);
    if (this.bounceRaf) cancelAnimationFrame(this.bounceRaf), (this.bounceRaf = 0);
    this.endTrail();
    const el = this.conversations;
    this.setScroll(el.scrollHeight - el.clientHeight - OVERSCROLL);
  }

  /** Every programmatic scroll goes through here so `writtenTop` records the
   *  landed (clamped/rounded) value — that's how `onScroll` tells our writes
   *  apart from a real operator gesture. */
  private setScroll(v: number) {
    const el = this.conversations;
    el.scrollTop = v;
    this.writtenTop = el.scrollTop;
    this.lastScrollTop = this.writtenTop;
  }

  /**
   * The transcript follows the stream while the agent types. The moment the
   * operator scrolls up, they take over: auto-follow releases and their position
   * holds until they scroll back to the bottom or the next turn re-locks it (see
   * the `user` case in `handle` and `showPane`).
   *
   * An event that lands where we last wrote is our own glide/bounce and is
   * ignored; anything else is the operator, so an upward move hands them the
   * scroll (and kills any in-flight glide) and a return to the bottom re-locks.
   */
  private onScroll() {
    const el = this.conversations;
    const top = el.scrollTop;
    if (Math.abs(top - this.writtenTop) <= 1.5) {
      // Our own programmatic scroll — not a takeover.
      this.lastScrollTop = top;
      return;
    }
    if (top < this.lastScrollTop - 1) {
      // Scrolled up — hand the operator the scroll and stop chasing. Collapse the
      // trailing pad too, so "bottom" (for re-locking below) means the content's
      // bottom rather than a viewport of slack they'd have to scroll through.
      this.autoFollow = false;
      if (this.chaseRaf) cancelAnimationFrame(this.chaseRaf), (this.chaseRaf = 0);
      if (this.bounceRaf) cancelAnimationFrame(this.bounceRaf), (this.bounceRaf = 0);
      this.endTrail();
    } else if (el.scrollHeight - top - el.clientHeight <= FOLLOW_SLACK) {
      // Back at the bottom — resume following the stream.
      this.autoFollow = true;
    }
    this.lastScrollTop = top;
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
    this.closeBubble(true);
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
    // Snap: the turn is over, so the final text lands complete before `settle`
    // eases the caret down against a now-stable height (a live drain would fight
    // the pad drop). Interrupt already means stop-means-stop.
    this.closeBubble(true);
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

    // Turn's done: ease the caret down to the natural bottom and drop the pad.
    this.settle();
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
      // Steady cadence: REVEAL_STEP chars/tick, so the reveal reads as a constant
      // typewriter decoupled from how the deltas actually arrived. Only once the
      // backlog exceeds REVEAL_MAX_LAG does the step grow, pulling the lag back to
      // the cap — a flood catches up in ~0.7s without the reveal ever snapping.
      pane.bubbleShown += Math.max(REVEAL_STEP, remaining - REVEAL_MAX_LAG);
      if (pane.bubbleShown > pane.bubbleText.length) pane.bubbleShown = pane.bubbleText.length;
      // Only the on-screen pane's glyphs are worth animating; a background run
      // just fills its text in (it'll be settled by the time it's shown).
      this.draw(pane, pane === this.visible);
      // Chunky follow: let the reveal pile up, then glide to catch it (follow()
      // guards the visible-pane and auto-follow checks itself). The final tick of
      // a burst forces a settle, so no sub-chunk slack is left once it drains.
      const done = pane.bubbleShown >= pane.bubbleText.length;
      if (pane === this.visible) this.follow(done);
      if (!done) pane.revealTimer = window.setTimeout(step, 16);
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
