import './style.css';
import { registerCockpitTheme } from './theme';
import { monaco } from './monaco-env';
import { Cockpit, runStream } from './cockpit';
import { mockSource } from './agent/mockSource';
import { parseAgentStream, requestAgent } from './agent/claudeSource';
import { sampleFile } from './agent/sample';

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
      <div class="spacer"></div>
      <input id="prompt" class="prompt" placeholder="Ask the agent to change ${sampleFile.path}…" />
      <button id="send" class="btn primary">Send</button>
      <button id="run" class="btn">▶ Demo</button>
    </header>
    <main class="body">
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
