import './style.css';
import { registerCockpitTheme } from './theme';
import { monaco } from './monaco-env';
import { Cockpit, runStream } from './cockpit';
import { mockSource } from './agent/mockSource';
import { parseAgentStream, requestAgent } from './agent/claudeSource';
import { electronSource } from './agent/electronSource';
import { sampleFile } from './agent/sample';
import { WorktreeRail } from './worktrees';
import { FileTree } from './fileTree';
import { FileView } from './fileView';
import { RunPane, runButtonLabel } from './runPane';
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
            <button id="view-run" class="ws-tab">Run</button>
          </div>
        </div>
        <div class="diff" id="diff"></div>
        <div class="changes" id="changes" hidden></div>
        <div class="file-pane" id="file-pane" hidden></div>
        <div class="run-pane" id="run-pane" hidden></div>
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
 * The topbar button mirrors the Run pane, which shows the *active* worktree.
 * Runs are per-worktree, so ▶ Run / ■ Stop always refers to the selected one —
 * a sibling still serving on its own port doesn't change this button.
 */
const runPane = new RunPane(document.getElementById('run-pane') as HTMLElement, (status) => {
  runAppBtn.textContent = runButtonLabel(status);
  runAppBtn.classList.toggle('danger', status.state === 'running');
  runAppBtn.classList.toggle('primary', status.state !== 'running');
  runAppBtn.disabled = !window.cockpit || !activeWorktree;
  runAppBtn.title = activeWorktree
    ? `${status.command || 'run'} — port ${activeWorktree.port} (${status.state})`
    : 'Select a worktree first';
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
    void runPane.setWorktree(wt);
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
      void runPane.setWorktree(null);
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

type WorkspaceView = 'file' | 'live' | 'changes' | 'run';

const el = (id: string) => document.getElementById(id) as HTMLElement;

/**
 * The workspace shows exactly one pane. Keeping the mapping in one table is what
 * makes a fourth view an entry rather than another branch reaching over to hide
 * the other three by hand.
 */
const VIEWS: Record<WorkspaceView, { pane: HTMLElement; tab: HTMLButtonElement }> = {
  file: { pane: el('file-pane'), tab: el('view-file') as HTMLButtonElement },
  live: { pane: el('diff'), tab: el('view-live') as HTMLButtonElement },
  changes: { pane: el('changes'), tab: el('view-changes') as HTMLButtonElement },
  run: { pane: el('run-pane'), tab: el('view-run') as HTMLButtonElement },
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
VIEWS.run.tab.addEventListener('click', () => setWorkspaceView('run'));

VIEWS.changes.tab.addEventListener('click', async () => {
  setWorkspaceView('changes');
  const cwd = activeWorktree?.path;
  const diff = cwd && window.cockpit ? await window.cockpit.worktrees.diff(cwd) : '';
  await cockpit.showChanges(diff);
});

// The button starts (or stops) the run; the pane is where the output is, so
// showing it on the way is the point of pressing the button.
runAppBtn.addEventListener('click', () => {
  setWorkspaceView('run');
  runPane.toggle();
});

// Runs come up and go down in worktrees other than the active one, and the rail
// is where their ports light up — so it refreshes on any status change, not just
// the selected worktree's. Status events fire on transitions only, never on
// output, so this stays cheap.
window.cockpit?.run.onEvent((event) => {
  if (event.type === 'status') rail.refresh();
});

// The create hook runs in the background long after the worktree appears, so its
// outcome lands here rather than in the create call's result.
window.cockpit?.worktrees.onHook((result) => {
  const status = document.getElementById('status')!;
  if (result.error) {
    status.textContent = `${result.branch}: hook could not start — ${result.error}`;
  } else if (result.code === 0) {
    status.textContent = `${result.branch}: ready on port ${result.port} (${result.command})`;
  } else {
    const why = result.tail.trim().split('\n').slice(-1)[0] ?? '';
    status.textContent = `${result.branch}: hook exited ${result.code} — ${why}`;
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
      document.getElementById('status')!.textContent = 'Select a worktree in the left rail first.';
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
