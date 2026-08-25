import './style.css';
import { registerCockpitTheme } from './theme';
import { monaco } from './monaco-env';
import { Cockpit, runStream } from './cockpit';
import { mockSource } from './agent/mockSource';
import { parseAgentStream, requestAgent } from './agent/claudeSource';
import { electronSource } from './agent/electronSource';
import { sampleFile } from './agent/sample';
import { WorktreeRail } from './worktrees';
import { IDLE_STATUS, type RunCommand, type RunStatus } from './runConfig';
import { FileTree } from './fileTree';
import { FileView } from './fileView';
import type { Worktree } from './bridge';

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
    activeWorktree = wt;
    activeWtLabel.textContent = wt.name;
    activeWtLabel.classList.add('set');
    // Each worktree keeps its own live session; show its transcript, replaying
    // the stored one the first time it's opened this run.
    cockpit.showPane(wt.path);
    cockpit.restorePane(wt.path);
    void setRunWorktree(wt);
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
      cockpit.resetDiff();
      // The directory is gone; its run went with it in removeWorktree.
      void setRunWorktree(null);
      updateSendStop();
    }
    cockpit.dropPane(path);
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
  if (files) void fileTree.setWorktree(activeWorktree);
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
 * background doesn't disable Send here. No-op in the browser, where there are no
 * worktrees and the mock path drives the button itself.
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

stopBtn.addEventListener('click', () => {
  if (activeWorktree && runningCwds.has(activeWorktree.path)) {
    window.cockpit?.agent.interrupt(activeWorktree.path);
  }
});

async function sendPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  // Desktop: each worktree has its own live session; several can run at once,
  // each unspooling into its own transcript whether or not it's on screen.
  if (window.cockpit?.agent) {
    if (!activeWorktree) {
      setStatusLine('Select a worktree in the left rail first.');
      return;
    }
    const cwd = activeWorktree.path;
    if (runningCwds.has(cwd)) return; // that worktree's turn is still going
    promptInput.value = '';
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
      updateSendStop();
      syncStatsPoll();
    }
    return;
  }

  // Browser: the toy /api/agent path, with a mock fallback.
  sendBtn.disabled = true;
  sendBtn.textContent = '● thinking…';
  try {
    let res: Response;
    try {
      res = await requestAgent(prompt, sampleFile);
    } catch {
      await runStream(cockpit, mockSource());
      return;
    }
    if (!res.ok || !res.body) {
      await runStream(cockpit, mockSource());
      return;
    }
    await runStream(cockpit, parseAgentStream(res));
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }
}

sendBtn.addEventListener('click', sendPrompt);
promptInput.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter drops a newline into the box.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
