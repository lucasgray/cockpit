import './style.css';
import { registerCockpitTheme } from './theme';
import { monaco } from './monaco-env';
import { Cockpit, runStream } from './cockpit';
import { mockSource } from './agent/mockSource';
import { parseAgentStream, requestAgent } from './agent/claudeSource';
import { electronSource } from './agent/electronSource';
import { sampleFile } from './agent/sample';
import { WorktreeRail } from './worktrees';
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
        </div>
        <div class="rail-body" id="rail-body"></div>
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
            <button id="view-live" class="ws-tab active">Live</button>
            <button id="view-changes" class="ws-tab">Changes</button>
            <button id="view-run" class="ws-tab">Run</button>
          </div>
        </div>
        <div class="diff" id="diff"></div>
        <div class="changes" id="changes" hidden></div>
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
const railBody = document.getElementById('rail-body') as HTMLElement;

let activeWorktree: Worktree | null = null;

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
  railBody,
  (wt) => {
    activeWorktree = wt;
    activeWtLabel.textContent = wt.name;
    activeWtLabel.classList.add('set');
    // Each worktree keeps its own live session; show its transcript, replaying
    // the stored one the first time it's opened this run.
    cockpit.showPane(wt.path);
    cockpit.restorePane(wt.path);
    void runPane.setWorktree(wt);
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
  },
);

const viewLiveBtn = document.getElementById('view-live') as HTMLButtonElement;
const viewChangesBtn = document.getElementById('view-changes') as HTMLButtonElement;
const viewRunBtn = document.getElementById('view-run') as HTMLButtonElement;
const runPaneEl = document.getElementById('run-pane') as HTMLElement;

function setWorkspaceView(view: 'live' | 'changes' | 'run') {
  viewLiveBtn.classList.toggle('active', view === 'live');
  viewChangesBtn.classList.toggle('active', view === 'changes');
  viewRunBtn.classList.toggle('active', view === 'run');
  runPaneEl.hidden = view !== 'run';
  if (view === 'run') {
    // Monaco's container is display-toggled rather than hidden, so the Run pane
    // has to put both of the other two away itself.
    document.getElementById('changes')!.hidden = true;
    document.getElementById('diff')!.style.display = 'none';
  }
}

viewLiveBtn.addEventListener('click', () => {
  setWorkspaceView('live');
  cockpit.showLive();
});

viewChangesBtn.addEventListener('click', async () => {
  setWorkspaceView('changes');
  const cwd = activeWorktree?.path;
  const diff = cwd && window.cockpit ? await window.cockpit.worktrees.diff(cwd) : '';
  await cockpit.showChanges(diff);
});

viewRunBtn.addEventListener('click', () => setWorkspaceView('run'));

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

function showRailView(view: string) {
  document.querySelectorAll<HTMLButtonElement>('.rail-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === view),
  );
  if (view === 'worktrees') {
    rail.load();
  } else {
    railBody.innerHTML = `<div class="rail-note">File tree — coming next.<br />Scoped to the active worktree.</div>`;
  }
}

document.querySelectorAll<HTMLButtonElement>('.rail-tab').forEach((tab) =>
  tab.addEventListener('click', () => showRailView(tab.dataset.view ?? 'worktrees')),
);

rail.load();
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
    statsPoll = window.setInterval(() => rail.refresh(), 1500);
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
