import './style.css';
import { registerCockpitTheme } from './theme';
import { monaco } from './monaco-env';
import { Cockpit, runStream } from './cockpit';
import { mockSource } from './agent/mockSource';
import { parseAgentStream, requestAgent } from './agent/claudeSource';
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
        <span class="tag">toy</span>
      </div>
      <span class="active-wt" id="active-wt">no worktree</span>
      <div class="spacer"></div>
      <input id="prompt" class="prompt" placeholder="Ask the agent to change ${sampleFile.path}…" />
      <button id="send" class="btn primary">Send</button>
      <button id="run" class="btn">▶ Demo</button>
    </header>
    <main class="body">
      <aside class="rail">
        <div class="rail-switch">
          <button class="rail-tab active" data-view="worktrees">Worktrees</button>
          <button class="rail-tab" data-view="explorer">Files</button>
        </div>
        <div class="rail-body" id="rail-body"></div>
      </aside>
      <section class="conversation" id="conversation"></section>
      <section class="workspace">
        <div class="tabs" id="tabs"></div>
        <div class="diff" id="diff"></div>
        <div class="statusline" id="status"></div>
      </section>
    </main>
  </div>
`;

const cockpit = new Cockpit();
const runBtn = document.getElementById('run') as HTMLButtonElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const promptInput = document.getElementById('prompt') as HTMLInputElement;
const activeWtLabel = document.getElementById('active-wt') as HTMLElement;
const railBody = document.getElementById('rail-body') as HTMLElement;

let activeWorktree: Worktree | null = null;

const rail = new WorktreeRail(railBody, (wt) => {
  activeWorktree = wt;
  activeWtLabel.textContent = wt.name;
  activeWtLabel.classList.add('set');
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

async function guarded(label: string, work: () => Promise<void>) {
  if (running) return;
  running = true;
  runBtn.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = label;
  try {
    await work();
  } finally {
    running = false;
    runBtn.disabled = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    runBtn.textContent = '↺ Demo';
  }
}

runBtn.addEventListener('click', () =>
  guarded('…', async () => {
    await runStream(cockpit, mockSource());
  }),
);

async function sendPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  await guarded('● thinking…', async () => {
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
  if (e.key === 'Enter') sendPrompt();
});
