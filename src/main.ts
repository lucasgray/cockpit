import './style.css';
import { registerCockpitTheme } from './theme';
import { monaco } from './monaco-env';
import { Cockpit, runStream } from './cockpit';
import { electronSource } from './agent/electronSource';
import { WorktreeRail } from './worktrees';
import { IDLE_STATUS, type RunCommand, type RunStatus } from './runConfig';
import { FileTree } from './fileTree';
import { FileView } from './fileView';
import type { Worktree } from './bridge';
import {
  FALLBACK_MODELS,
  UNLISTED_MODELS,
  type EffortChoice,
  type ModelChoice,
} from './settings';

registerCockpitTheme();
monaco.editor.setTheme('cockpit-dark');

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="dot"></span>
        Cockpit
      </div>
      <span class="active-wt" id="active-wt">no worktree</span>
      <div class="spacer"></div>
      <button id="run-app" class="btn primary" disabled>▶ Run</button>
    </header>
    <main class="body">
      <aside class="rail">
        <div class="rail-switch">
          <button class="rail-tab active" data-view="worktrees">Worktrees</button>
          <button class="rail-tab" data-view="explorer">Files</button>
          <button class="rail-refresh" id="rail-refresh" title="Re-read the file tree" hidden>⟳</button>
        </div>
        <div class="rail-body">
          <div class="rail-view" id="rail-worktrees"></div>
          <div class="rail-view" id="rail-files" hidden></div>
        </div>
      </aside>
      <section class="conversation">
        <div class="transcripts" id="conversation"></div>
        <div class="composer">
          <textarea id="prompt" class="prompt" rows="3"></textarea>
          <div class="composer-actions">
            <button id="thinking" class="btn toggle" aria-pressed="false">✳ Thinking</button>
            <select id="model" class="picker" aria-label="Model"></select>
            <select id="effort" class="picker" aria-label="Effort"></select>
            <div class="spacer"></div>
            <button id="stop" class="btn danger" hidden>■ Stop</button>
            <button id="send" class="btn primary">Send</button>
          </div>
        </div>
      </section>
      <section class="workspace">
        <div class="ws-head">
          <div class="tabs" id="tabs"></div>
          <div class="ws-toggle">
            <button id="view-file" class="ws-tab" hidden>File</button>
            <button id="view-live" class="ws-tab active">Live</button>
            <button id="view-changes" class="ws-tab">Changes</button>
          </div>
        </div>
        <div class="diff" id="diff"></div>
        <div class="changes" id="changes" hidden></div>
        <div class="file-pane" id="file-pane" hidden></div>
        <div class="statusline" id="status"></div>
      </section>
    </main>
  </div>
`;

const cockpit = new Cockpit();
const runAppBtn = document.getElementById('run-app') as HTMLButtonElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const promptInput = document.getElementById('prompt') as HTMLTextAreaElement;
const thinkingBtn = document.getElementById('thinking') as HTMLButtonElement;
const modelPicker = document.getElementById('model') as HTMLSelectElement;
const effortPicker = document.getElementById('effort') as HTMLSelectElement;
const activeWtLabel = document.getElementById('active-wt') as HTMLElement;
// The two rail views get their own containers rather than sharing one: the
// worktree rail re-renders on a 1.5s poll while a turn runs, and that would
// otherwise wipe the file tree out from under whoever is browsing it.
const railWorktrees = document.getElementById('rail-worktrees') as HTMLElement;
const railFiles = document.getElementById('rail-files') as HTMLElement;
const railRefreshBtn = document.getElementById('rail-refresh') as HTMLButtonElement;
const viewFileBtn = document.getElementById('view-file') as HTMLButtonElement;

let activeWorktree: Worktree | null = null;

/**
 * The composer is per-worktree, like the transcript above it: each worktree
 * holds its own half-written prompt, so switching mid-sentence parks what you
 * were saying here and brings back what you'd been saying over there.
 *
 * The live copy is this map, not the store: repainting the box on a switch has
 * to be synchronous, or the first keystroke after a click lands in whichever
 * worktree's draft the read happened to still be resolving. The store is the
 * copy that survives a restart, written behind a short debounce so a long
 * prompt is one write when the typing stops rather than one per key.
 */
const drafts = new Map<string, string>();
const DRAFT_SAVE_MS = 400;
/** A debounced save not yet landed, and the worktree whose text it carries. */
let pendingDraft: { cwd: string; timer: number } | null = null;

/** Push a worktree's draft through to the store now. */
function saveDraft(cwd: string) {
  if (pendingDraft?.cwd === cwd) {
    clearTimeout(pendingDraft.timer);
    pendingDraft = null;
  }
  void window.cockpit?.store.setDraft(cwd, drafts.get(cwd) ?? '');
}

/** The box changed — hold it against the active worktree and save it shortly. */
function noteDraft() {
  const cwd = activeWorktree?.path;
  if (!cwd) return;
  drafts.set(cwd, promptInput.value);
  // A save still pending for another worktree is that worktree's last few
  // keystrokes — land it rather than dropping it with its timer.
  if (pendingDraft && pendingDraft.cwd !== cwd) saveDraft(pendingDraft.cwd);
  if (pendingDraft) clearTimeout(pendingDraft.timer);
  pendingDraft = { cwd, timer: window.setTimeout(() => saveDraft(cwd), DRAFT_SAVE_MS) };
}

/** Park the box's contents on the worktree they were typed at, before the
 *  composer is pointed somewhere else. */
function stashDraft() {
  const cwd = activeWorktree?.path;
  if (!cwd) return;
  // An empty box at a worktree nothing has been typed at yet is not news — and
  // its stored draft may still be in flight, which this would clobber with ''.
  if (!drafts.has(cwd) && !promptInput.value) return;
  drafts.set(cwd, promptInput.value);
  // Don't leave the last keystrokes riding a timer the switch outlives.
  if (pendingDraft?.cwd === cwd) saveDraft(cwd);
}

/**
 * Bring back the prompt a worktree was left mid-typing. Only the first time
 * it's opened this run — after that the map is the live copy and the store is
 * merely following it.
 */
async function restoreDraft(wt: Worktree) {
  if (drafts.has(wt.path)) return;
  const stored = (await window.cockpit?.store.draft(wt.path)) ?? '';
  // Anything typed while that was in flight is newer than what came back.
  if (drafts.has(wt.path)) return;
  drafts.set(wt.path, stored);
  // The rail may have been clicked again — only the selected worktree's draft
  // belongs in the box.
  if (activeWorktree?.path === wt.path) promptInput.value = stored;
}

/**
 * The open file's tab appears only once there is one, and wears the file's own
 * name — the pane below it carries the full path.
 */
const fileView = new FileView(document.getElementById('file-pane') as HTMLElement, (cwd, path) => {
  viewFileBtn.hidden = !path;
  viewFileBtn.textContent = path ? (path.split('/').pop() ?? 'File') : 'File';
  void window.cockpit?.store.setOpenFile(cwd, path);
  // The file went away with its worktree — don't leave the operator staring at
  // a pane with nothing in it.
  if (!path && viewFileBtn.classList.contains('active')) setWorkspaceView('live');
});

/** Clicking a file in the rail is a request to look at it — so go there. */
const fileTree = new FileTree(railFiles, (cwd, path) => {
  setWorkspaceView('file');
  void fileView.open(cwd, path);
});

/**
 * ▶ Run in the topbar: start (or stop) the project the *active* worktree holds.
 *
 * Runs are per-worktree and concurrent, each on its own assigned port, so this
 * button always speaks for the selected worktree — a sibling still serving on its
 * own port doesn't change it. There is no output pane: a run serves on a port and
 * the browser is where you look at it, so all the UI carries is this button's
 * state and, when a run dies, the line it died on in the statusline.
 */
let runState: RunStatus = { ...IDLE_STATUS };
/** What the active worktree *would* run — the tooltip before anything starts. */
let runDetected: RunCommand = { command: '', source: '' };

function setStatusLine(text: string) {
  document.getElementById('status')!.textContent = text;
}

function paintRunButton() {
  const running = runState.state === 'running';
  runAppBtn.textContent = running ? '■ Stop' : '▶ Run';
  runAppBtn.classList.toggle('danger', running);
  runAppBtn.classList.toggle('primary', !running);
  runAppBtn.disabled = !window.cockpit || !activeWorktree;

  if (!activeWorktree) {
    runAppBtn.title = 'Select a worktree first';
    return;
  }
  const command = runState.command || runDetected.command;
  runAppBtn.title = command
    ? `${command} — port ${activeWorktree.port} (${runState.state})`
    : `Nothing in ${activeWorktree.name} says how to run it`;
}

/** Adopt a worktree's run — it may already be serving from an earlier click. */
async function setRunWorktree(wt: Worktree | null) {
  runState = { ...IDLE_STATUS, cwd: wt?.path ?? null };
  runDetected = { command: '', source: '' };
  paintRunButton();
  if (!window.cockpit || !wt) return;

  const [status, detected] = await Promise.all([
    window.cockpit.run.status(wt.path),
    window.cockpit.run.detect(wt.path),
  ]);
  // The rail may have moved on while those were in flight; the newer selection
  // owns the button.
  if (activeWorktree?.path !== wt.path) return;
  runState = status;
  runDetected = detected;
  paintRunButton();
}

/** One line for a run that changed state, in any worktree — the console's heir. */
function reportRun(cwd: string, status: RunStatus) {
  const name = cwd.split('/').filter(Boolean).pop() ?? cwd;
  const why = status.error ? ` — ${status.error}` : '';
  if (status.state === 'running') {
    setStatusLine(`${name}: serving on port ${status.port} (${status.command})`);
  } else if (status.state === 'idle') {
    setStatusLine(`${name}: stopped${why}`);
  } else if (status.state === 'exited') {
    setStatusLine(`${name}: run exited ${status.exitCode}`);
  } else {
    const code = status.exitCode === null ? '' : ` (exit ${status.exitCode})`;
    setStatusLine(`${name}: run failed${code}${why}`);
  }
}

runAppBtn.addEventListener('click', () => {
  const wt = activeWorktree;
  if (!wt || !window.cockpit) return;
  if (runState.state === 'running') {
    void window.cockpit.run.stop(wt.path);
  } else {
    // Starting is slow enough to need an acknowledgement of its own — the next
    // word from the run is a status event, which may be seconds away.
    setStatusLine(`${wt.name}: starting ${runDetected.command || 'run'} on port ${wt.port}…`);
    void window.cockpit.run.start(wt.path);
  }
});

// Runs come up and go down in worktrees other than the active one; status events
// fire on transitions only, never on output, so this stays cheap.
window.cockpit?.run.onEvent(({ cwd, status }) => {
  if (cwd === activeWorktree?.path) {
    runState = status;
    paintRunButton();
  }
  reportRun(cwd, status);
});

const rail = new WorktreeRail(
  railWorktrees,
  (wt) => {
    // Park the half-written prompt on the worktree being left, before the box
    // starts belonging to the new one.
    stashDraft();
    activeWorktree = wt;
    activeWtLabel.textContent = wt.name;
    activeWtLabel.classList.add('set');
    // Each worktree keeps its own live session; show its transcript, replaying
    // the stored one the first time it's opened this run.
    cockpit.showPane(wt.path);
    cockpit.restorePane(wt.path);
    // The composer follows the transcript: this worktree's own draft, from the
    // map if it's been open this run and from the store the first time.
    promptInput.value = drafts.get(wt.path) ?? '';
    void restoreDraft(wt);
    void setRunWorktree(wt);
    void setThinkingWorktree(wt);
    void setAgentWorktree(wt);
    void refreshModels();
    void fileTree.setWorktree(wt);
    void restoreOpenFile(wt);
    // Send/Stop speak for the selected worktree — refresh them on every switch.
    updateSendStop();
    // Picking a worktree is the start of typing at it — go straight to the box.
    promptInput.focus();
  },
  (path) => {
    if (activeWorktree?.path === path) {
      activeWorktree = null;
      activeWtLabel.textContent = 'no worktree';
      activeWtLabel.classList.remove('set');
      // Nothing to type at — and the draft belonged to a directory that no
      // longer exists, so it goes with it rather than into the next worktree.
      promptInput.value = '';
      cockpit.resetDiff();
      // The directory is gone; its run went with it in removeWorktree.
      void setRunWorktree(null);
      void setThinkingWorktree(null);
      void setAgentWorktree(null);
      updateSendStop();
    }
    cockpit.dropPane(path);
    drafts.delete(path);
    saveDraft(path);
    fileTree.dropWorktree(path);
    fileView.dropWorktree(path);
  },
);

/**
 * Reopen the file this worktree was last left on, and expand the tree down to
 * it. The pane is loaded but not shown — coming back to a worktree shouldn't
 * yank the workspace off Live, only make the File tab ready.
 */
async function restoreOpenFile(wt: Worktree) {
  const stored = await window.cockpit?.store.openFile(wt.path);
  // The rail may have been clicked again while this was in flight.
  if (!stored || activeWorktree?.path !== wt.path) return;
  await fileTree.reveal(stored);
  if (activeWorktree?.path !== wt.path) return;
  await fileView.open(wt.path, stored);
}

type WorkspaceView = 'file' | 'live' | 'changes';

const el = (id: string) => document.getElementById(id) as HTMLElement;

/**
 * The workspace shows exactly one pane. Keeping the mapping in one table is what
 * makes a fourth view an entry rather than another branch reaching over to hide
 * the other two by hand.
 */
const VIEWS: Record<WorkspaceView, { pane: HTMLElement; tab: HTMLButtonElement }> = {
  file: { pane: el('file-pane'), tab: el('view-file') as HTMLButtonElement },
  live: { pane: el('diff'), tab: el('view-live') as HTMLButtonElement },
  changes: { pane: el('changes'), tab: el('view-changes') as HTMLButtonElement },
};

function setWorkspaceView(view: WorkspaceView) {
  for (const [name, { pane, tab }] of Object.entries(VIEWS) as [
    WorkspaceView,
    { pane: HTMLElement; tab: HTMLButtonElement },
  ][]) {
    const on = name === view;
    tab.classList.toggle('active', on);
    // The live diff is Monaco's own container: `hidden` leaves it a zero-height
    // box it never measures its way out of, so that one moves by display.
    if (name === 'live') pane.style.display = on ? '' : 'none';
    else pane.hidden = !on;
  }
  // Same story for the editor — it sizes itself to a box that was just revealed.
  if (view === 'file') fileView.layout();
}

VIEWS.file.tab.addEventListener('click', () => setWorkspaceView('file'));
VIEWS.live.tab.addEventListener('click', () => setWorkspaceView('live'));

VIEWS.changes.tab.addEventListener('click', async () => {
  setWorkspaceView('changes');
  const cwd = activeWorktree?.path;
  const diff = cwd && window.cockpit ? await window.cockpit.worktrees.diff(cwd) : '';
  await cockpit.showChanges(diff);
});

// The create hook runs in the background long after the worktree appears, so its
// outcome lands here rather than in the create call's result.
window.cockpit?.worktrees.onHook((result) => {
  if (result.error) {
    setStatusLine(`${result.branch}: hook could not start — ${result.error}`);
  } else if (result.code === 0) {
    setStatusLine(`${result.branch}: ready on port ${result.port} (${result.command})`);
  } else {
    const why = result.tail.trim().split('\n').slice(-1)[0] ?? '';
    setStatusLine(`${result.branch}: hook exited ${result.code} — ${why}`);
  }
  rail.refresh();
});

/**
 * Swap which rail view is on screen. Both keep their own container and their own
 * state, so switching is a toggle rather than a reload — the worktree list isn't
 * re-read from git, and the tree keeps everything it had expanded.
 */
function showRailView(view: string) {
  const files = view === 'explorer';
  document.querySelectorAll<HTMLButtonElement>('.rail-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === view),
  );
  railWorktrees.hidden = files;
  railFiles.hidden = !files;
  railRefreshBtn.hidden = !files;
  // Coming back to a tab that was hidden while the agent worked: catch the tree
  // up now rather than a poll-tick later.
  if (files) void fileTree.setWorktree(activeWorktree).then(() => fileTree.sync());
  void window.cockpit?.store.setRailView(view);
}

document.querySelectorAll<HTMLButtonElement>('.rail-tab').forEach((tab) =>
  tab.addEventListener('click', () => showRailView(tab.dataset.view ?? 'worktrees')),
);

railRefreshBtn.addEventListener('click', () => void fileTree.refresh());

rail.load();
// The rail comes back on the tab it was left on, for the same reason the
// worktree selection does.
void window.cockpit?.store.railView().then((view) => {
  if (view === 'explorer') showRailView(view);
});
updateSendStop();

/** Worktrees with a turn in flight. Runs are per-worktree and concurrent. */
const runningCwds = new Set<string>();
/** Interval repainting the rail's +/- + dirty dots while any run is going. */
let statsPoll = 0;

/**
 * Reflect the *active* worktree's run state on Send/Stop. Runs are per-worktree,
 * so these buttons always speak for the selected one — a sibling running in the
 * background doesn't disable Send here. No-op in the browser, where there is no
 * bridge and so nothing to run.
 */
function updateSendStop() {
  if (!window.cockpit?.agent) return;
  const busy = !!activeWorktree && runningCwds.has(activeWorktree.path);
  sendBtn.disabled = busy || !activeWorktree;
  sendBtn.textContent = busy ? '● working…' : 'Send';
  stopBtn.hidden = !busy;
}

/**
 * A background run edits its worktree with no status event per keystroke, so
 * while anything is running, poll the rail to keep its +/- and dirty dots live.
 */
function syncStatsPoll() {
  if (runningCwds.size && !statsPoll) {
    statsPoll = window.setInterval(() => {
      rail.refresh();
      // Cheap next to the rail's git calls, and it's what makes an open file
      // update under you as the agent rewrites it rather than at turn end.
      if (activeWorktree) void fileView.reconcile(activeWorktree.path);
    }, 1500);
  } else if (!runningCwds.size && statsPoll) {
    clearInterval(statsPoll);
    statsPoll = 0;
  }
}

/**
 * ✳ Thinking: drop the active worktree's session into thinking mode.
 *
 * Per-worktree, like the sessions themselves — one worktree can be reasoning out
 * loud while a sibling grinds through a mechanical turn. Off is the quiet
 * default the app has always had: the model still reasons, but Claude Code omits
 * the blocks and the cockpit shows only its spinner. On asks for summarized
 * thinking, and the reasoning streams into the transcript as ✳ thinking bubbles.
 *
 * The flag lives in the store, and the main process reads it there when a turn
 * starts, so this only ever has to write it — flipping mid-turn lands on the
 * next prompt rather than half-changing the one in flight.
 */
let thinkingOn = false;

function paintThinking() {
  thinkingBtn.classList.toggle('on', thinkingOn);
  thinkingBtn.setAttribute('aria-pressed', String(thinkingOn));
  thinkingBtn.disabled = !window.cockpit || !activeWorktree;
  thinkingBtn.title = !window.cockpit
    ? 'Thinking mode needs the desktop app'
    : !activeWorktree
      ? 'Select a worktree first'
      : thinkingOn
        ? `${activeWorktree.name} is thinking out loud — Tab to stop showing it`
        : `Show ${activeWorktree.name}'s reasoning as it works — Tab`;
}

/** Adopt a worktree's thinking mode; it may have been left on last session. */
async function setThinkingWorktree(wt: Worktree | null) {
  thinkingOn = false;
  paintThinking();
  if (!window.cockpit || !wt) return;
  const on = await window.cockpit.store.thinking(wt.path);
  // The rail may have been clicked again while that was in flight.
  if (activeWorktree?.path !== wt.path) return;
  thinkingOn = on;
  paintThinking();
}

function toggleThinking() {
  const cwd = activeWorktree?.path;
  if (!cwd || !window.cockpit) return;
  thinkingOn = !thinkingOn;
  paintThinking();
  void window.cockpit.store.setThinking(cwd, thinkingOn);
}

thinkingBtn.addEventListener('click', toggleThinking);
// Down here rather than beside the other init calls: those run before
// `thinkingOn` is initialized, and reading it there is a startup crash.
paintThinking();

/**
 * The model and effort switchers, beside ✳ Thinking and per-worktree for the
 * same reason: they speak for the selected worktree only. Pin the worktree
 * holding the hard problem to Opus at max effort and leave the mechanical one on
 * Haiku, and the two run side by side without either one's setting leaking.
 *
 * Both default to unpinned — the CLI's own choice — rather than to an opinion of
 * the cockpit's. Like thinking mode they're written to the store here and read
 * back in the main process when a turn starts, so a change mid-turn lands on the
 * next prompt instead of half-changing the one in flight.
 */
let catalogue: ModelChoice[] = FALLBACK_MODELS;
let modelId = '';
let effortLevel: EffortChoice = '';

/**
 * Every row the switcher offers: what the CLI advertises, then the generation it
 * doesn't. The catalogue wins on collision — if a later Claude Code starts
 * listing Opus 4.8 itself, its own row replaces ours rather than doubling up.
 *
 * The catalogue ships a "Default (recommended)" row that means exactly what the
 * unpinned entry means, so it's dropped here rather than offered twice.
 */
function rows(): ModelChoice[] {
  const listed = catalogue.filter((m) => m.value !== 'default');
  const known = new Set(listed.flatMap((m) => [m.value, m.resolvedModel ?? m.value]));
  return [...listed, ...UNLISTED_MODELS.filter((m) => !known.has(m.value))];
}

/**
 * The catalogue starts as the built-in list and becomes the installed CLI's real
 * one as soon as any session has opened to be asked — so this runs on every
 * worktree switch and at the end of every turn, not just at startup.
 */
async function refreshModels() {
  const live = (await window.cockpit?.agent.models()) ?? [];
  if (!live.length) return;
  catalogue = live;
  adoptCatalogueId();
  paintPickers();
}

/** The pinned model's row, or null when unpinned or pinned to an unknown id. */
function pinnedModel(): ModelChoice | null {
  return rows().find((m) => m.value === modelId || m.resolvedModel === modelId) ?? null;
}

/**
 * Rewrite a pin the arriving catalogue spells differently — `claude-opus-5` from
 * the built-in list where the live one says `opus`. Both reach the same model, so
 * this is cosmetic to the turn, but the switcher can only show a row it can name:
 * left alone, the pin selects nothing and the picker reads "default" while the
 * store still says Opus. Move the pin onto the row instead of showing a lie.
 */
function adoptCatalogueId() {
  const row = pinnedModel();
  if (!row || row.value === modelId) return;
  modelId = row.value;
  const cwd = activeWorktree?.path;
  if (cwd) void window.cockpit?.store.setModel(cwd, modelId);
}

function option(select: HTMLSelectElement, value: string, label: string, hint?: string) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  // The names alone don't distinguish generations — "Opus (1M context)" could be
  // any Opus. The CLI's description does, so hang it off the row.
  if (hint) el.title = hint;
  select.append(el);
}

function paintPickers() {
  const ready = !!window.cockpit && !!activeWorktree;

  modelPicker.replaceChildren();
  option(modelPicker, '', 'Model: default', "Whatever Claude Code picks on its own");
  for (const model of rows()) option(modelPicker, model.value, model.label, model.description);
  // A worktree pinned to something no list names — a model that went away, or a
  // pin written by an older build. Keep it selectable rather than silently
  // repointing the worktree at the default.
  if (modelId && !pinnedModel()) option(modelPicker, modelId, modelId, 'No longer offered');
  modelPicker.value = modelId;
  modelPicker.disabled = !ready;
  modelPicker.classList.toggle('set', !!modelId);
  modelPicker.title = !window.cockpit
    ? 'Switching models needs the desktop app'
    : !activeWorktree
      ? 'Select a worktree first'
      : modelId
        ? `${activeWorktree.name} is pinned to ${pinnedModel()?.description ?? modelId}`
        : `${activeWorktree.name} runs on Claude Code's default model`;

  // Effort is only offered where the model takes one — an unpinned model has no
  // levels to offer, because until one is picked we don't know whose they'd be.
  const levels = pinnedModel()?.effortLevels ?? [];
  effortPicker.replaceChildren();
  option(effortPicker, '', 'Effort: default');
  for (const level of levels) option(effortPicker, level, `Effort: ${level}`);
  // A level this model doesn't list — a pin from before the real catalogue said
  // how far this one goes. It's still what the next turn will send, so show it;
  // a select with no matching option would quietly read "default" instead.
  if (effortLevel && !levels.includes(effortLevel)) {
    option(effortPicker, effortLevel, `Effort: ${effortLevel}`);
  }
  effortPicker.value = effortLevel;
  effortPicker.disabled = !ready || (!levels.length && !effortLevel);
  effortPicker.classList.toggle('set', !!effortLevel);
  effortPicker.title = !ready
    ? 'Select a worktree first'
    : !levels.length
      ? modelId
        ? `${pinnedModel()?.label ?? modelId} has no effort setting`
        : 'Pin a model to choose how hard it works'
      : `How hard ${activeWorktree?.name} thinks before it answers`;
}

/** Adopt a worktree's pins; it may have been left on either last session. */
async function setAgentWorktree(wt: Worktree | null) {
  modelId = '';
  effortLevel = '';
  paintPickers();
  if (!window.cockpit || !wt) return;
  const [model, effort] = await Promise.all([
    window.cockpit.store.model(wt.path),
    window.cockpit.store.effort(wt.path),
  ]);
  // The rail may have been clicked again while those were in flight.
  if (activeWorktree?.path !== wt.path) return;
  modelId = model;
  effortLevel = effort;
  paintPickers();
}

modelPicker.addEventListener('change', () => {
  const cwd = activeWorktree?.path;
  if (!cwd || !window.cockpit) return;
  modelId = modelPicker.value;
  void window.cockpit.store.setModel(cwd, modelId);
  // The new model may not take the effort the old one was set to — Haiku takes
  // none, and the 4.6 generation has no `xhigh`. Drop it rather than sending the
  // next turn a level it rejects.
  const levels = pinnedModel()?.effortLevels ?? [];
  if (effortLevel && !levels.includes(effortLevel)) {
    effortLevel = '';
    void window.cockpit.store.setEffort(cwd, '');
  }
  paintPickers();
});

effortPicker.addEventListener('change', () => {
  const cwd = activeWorktree?.path;
  if (!cwd || !window.cockpit) return;
  effortLevel = effortPicker.value as EffortChoice;
  void window.cockpit.store.setEffort(cwd, effortLevel);
  paintPickers();
});

paintPickers();
void refreshModels();

stopBtn.addEventListener('click', () => {
  if (activeWorktree && runningCwds.has(activeWorktree.path)) {
    window.cockpit?.agent.interrupt(activeWorktree.path);
  }
});

async function sendPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  // Turns run against a worktree through the main process — in the browser there
  // is no bridge and nothing to run against.
  if (!window.cockpit?.agent) {
    setStatusLine('Agent turns need the desktop app — run `npm run app`.');
    return;
  }
  if (!activeWorktree) {
    setStatusLine('Select a worktree in the left rail first.');
    return;
  }

  // Each worktree has its own live session; several can run at once, each
  // unspooling into its own transcript whether or not it's on screen.
  const cwd = activeWorktree.path;
  if (runningCwds.has(cwd)) return; // that worktree's turn is still going
  // Sent, so there's no draft left here — clear it in the store too, or coming
  // back to this worktree would hand back a prompt already in the transcript.
  promptInput.value = '';
  drafts.set(cwd, '');
  saveDraft(cwd);
  runningCwds.add(cwd);
  rail.setRunning(cwd, true);
  updateSendStop();
  syncStatsPoll();
  try {
    await runStream(cockpit, electronSource({ prompt, cwd }), { key: cwd, reset: false });
  } finally {
    runningCwds.delete(cwd);
    rail.setRunning(cwd, false);
    rail.refresh();
    // The turn created, deleted and rewrote files — the tree and whatever is
    // open in the editor are both out of date until this runs.
    void fileTree.refresh();
    void fileView.reconcile(cwd);
    // That turn may have been the first session to open — which is the moment
    // the switcher can stop guessing at the model list and read the real one.
    void refreshModels();
    updateSendStop();
    syncStatsPoll();
  }
}

sendBtn.addEventListener('click', sendPrompt);
promptInput.addEventListener('input', noteDraft);
// Clicking away is the moment a draft is most likely to be abandoned for a
// while — land it now rather than trusting the debounce to outlive the window.
promptInput.addEventListener('blur', () => {
  if (pendingDraft) saveDraft(pendingDraft.cwd);
});
promptInput.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter drops a newline into the box.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
  // Tab toggles thinking mode, as it does in Claude Code. Only from the prompt
  // box — everywhere else Tab stays what it is, a way to move the focus.
  if (e.key === 'Tab' && !e.shiftKey && !thinkingBtn.disabled) {
    e.preventDefault();
    toggleThinking();
  }
});
