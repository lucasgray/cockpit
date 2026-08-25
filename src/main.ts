import './style.css';
import { registerCockpitTheme } from './theme';
import { monaco } from './monaco-env';
import { Cockpit, runStream } from './cockpit';
import { mockSource } from './agent/mockSource';
import { parseAgentStream, requestAgent } from './agent/claudeSource';
import { electronSource } from './agent/electronSource';
import { sampleFile } from './agent/sample';
import { WorktreeRail } from './worktrees';
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
          </div>
        </div>
        <div class="diff" id="diff"></div>
        <div class="changes" id="changes" hidden></div>
        <div class="statusline" id="status"></div>
      </section>
    </main>
  </div>
`;

const cockpit = new Cockpit();
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const promptInput = document.getElementById('prompt') as HTMLTextAreaElement;
const activeWtLabel = document.getElementById('active-wt') as HTMLElement;
const railBody = document.getElementById('rail-body') as HTMLElement;

let activeWorktree: Worktree | null = null;

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
  },
  (path) => {
    if (activeWorktree?.path === path) {
      activeWorktree = null;
      activeWtLabel.textContent = 'no worktree';
      activeWtLabel.classList.remove('set');
      cockpit.resetDiff();
    }
    cockpit.dropPane(path);
  },
);

const viewLiveBtn = document.getElementById('view-live') as HTMLButtonElement;
const viewChangesBtn = document.getElementById('view-changes') as HTMLButtonElement;

function setWorkspaceView(view: 'live' | 'changes') {
  viewLiveBtn.classList.toggle('active', view === 'live');
  viewChangesBtn.classList.toggle('active', view === 'changes');
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

let running = false;
/** The worktree whose turn is in flight — what ■ Stop interrupts. */
let runningCwd: string | null = null;

async function guarded(label: string, cwd: string | null, work: () => Promise<void>) {
  if (running) return;
  running = true;
  runningCwd = cwd;
  sendBtn.disabled = true;
  sendBtn.textContent = label;
  stopBtn.hidden = cwd === null;
  rail.setRunning(cwd);
  try {
    await work();
  } finally {
    running = false;
    runningCwd = null;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    stopBtn.hidden = true;
    rail.setRunning(null);
  }
}

stopBtn.addEventListener('click', () => {
  if (runningCwd) window.cockpit?.agent.interrupt(runningCwd);
});

async function sendPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  // Desktop: continue the live Claude session pinned to the active worktree.
  if (window.cockpit?.agent) {
    if (!activeWorktree) {
      document.getElementById('status')!.textContent = 'Select a worktree in the left rail first.';
      return;
    }
    const cwd = activeWorktree.path;
    promptInput.value = '';
    await guarded('● working…', cwd, async () => {
      await runStream(cockpit, electronSource({ prompt, cwd }), { reset: false });
    });
    rail.refresh();
    return;
  }

  // Browser: the toy /api/agent path, with a mock fallback.
  await guarded('● thinking…', null, async () => {
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
  });
}

sendBtn.addEventListener('click', sendPrompt);
promptInput.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter drops a newline into the box.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
