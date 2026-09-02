// driver.js — helpers injected ahead of an `eval-file` script (see cdp.mjs) so a probe
// can drive synthetic agent turns and measure scroll/reveal state without re-writing the
// same boilerplate every investigation. It runs INSIDE the async IIFE cdp.mjs builds, so
// the caller's script gets top-level `await` and may `return` a JSON-serializable result.
//
// Requires the DEV-only `window.__cockpit` handle (src/main.ts, gated to probe instances)
// — the live transcript controller. All event shapes are AgentEvent (src/agent/protocol.ts):
//   {type:'user',text}  {type:'thinking',text}  {type:'say',text}  {type:'done'}  ...
//
// Vocabulary exposed to the caller's script:
//   p, conv            the controller and the .transcripts scroll container
//   sleep(ms)
//   feed(event[,key])  fire one AgentEvent into a pane (default: the visible one)
//   stream(type,text,{chunk,delay,key})   deltas, like a real stream
//   turn({user,thinking,say,key,settle})  full user->think->say->done, awaits the settle
//   paragraph(lines)   a viewport-wide block of filler text
//   caretY()           bottom of newest content, viewport-relative (mirrors cockpit.ts)
//   snapshot()         scroll + reveal state, with every message's box
//   poll(fn,n,interval) sample fn() over time — for watching a settle converge

const p = window.__cockpit;
if (!p || typeof p.handleEvent !== 'function') {
  throw new Error(
    'window.__cockpit missing — the probe hook only exists in a DEV build on the probe ' +
      'port range (see src/main.ts import.meta.env.DEV gate). Relaunch via probe.sh.',
  );
}
const conv = document.querySelector('.transcripts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = () => p.visible?.key ?? 'default';

const feed = (event, key = KEY()) => p.handleEvent(key, event);

const stream = async (type, text, { chunk = 25, delay = 5, key = KEY() } = {}) => {
  for (let i = 0; i < text.length; i += chunk) {
    p.handleEvent(key, { type, text: text.slice(i, i + chunk) });
    await sleep(delay);
  }
};

const turn = async ({ user = 'q', thinking = '', say = '', key = KEY(), settle = 900 } = {}) => {
  p.handleEvent(key, { type: 'user', text: user });
  await sleep(30);
  if (thinking) await stream('thinking', thinking, { key });
  if (say) await stream('say', say, { key });
  await sleep(settle);
  p.handleEvent(key, { type: 'done' });
  await sleep(settle);
};

const paragraph = (lines = 25) => {
  const s = 'The quick brown fox jumped over the lazy dog and kept running past the viewport edge. ';
  let out = '';
  for (let i = 0; i < lines; i++) out += s;
  return out;
};

const caretY = () => {
  const el = p.visible?.el?.lastElementChild;
  if (!el) return 0;
  return Math.round(el.getBoundingClientRect().bottom - conv.getBoundingClientRect().top);
};

const snapshot = () => {
  const c = conv.getBoundingClientRect();
  const msgs = [...p.visible.el.children].map((e) => {
    const r = e.getBoundingClientRect();
    return {
      cls: e.className.replace('msg ', ''),
      top: Math.round(r.top - c.top),
      bot: Math.round(r.bottom - c.top),
    };
  });
  return {
    scrollTop: Math.round(conv.scrollTop),
    scrollH: conv.scrollHeight,
    clientH: conv.clientHeight,
    maxScroll: conv.scrollHeight - conv.clientHeight,
    caretY: caretY(),
    autoFollow: p.autoFollow,
    trail: !!p.trailOn,
    chase: !!p.chaseRaf,
    bounce: !!p.bounceRaf,
    order: msgs.map((m) => m.cls),
    msgs,
  };
};

const poll = async (fn, n = 12, interval = 100) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    await sleep(interval);
    out.push({ ms: (i + 1) * interval, ...fn() });
  }
  return out;
};

// Silence "declared but never used" from linters when a script uses only a subset.
void [feed, stream, turn, paragraph, snapshot, poll];
