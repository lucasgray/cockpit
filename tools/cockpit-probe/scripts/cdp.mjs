#!/usr/bin/env node
//
// cdp.mjs — drive a cockpit *probe* over the Chrome DevTools Protocol, zero deps.
// Node 22+ ships a global WebSocket + fetch, so there is no ws / puppeteer to install.
// Invoked by probe.sh; reads $PROBE_DIR/probe.json for the ports.
//
// SAFETY RAIL (never-touch-the-main-cockpit-instance): we ONLY ever attach to the page
// target whose URL host:port is 127.0.0.1:<vitePort> from probe.json. Lucas's main
// cockpit runs on a different vite port and is launched with NO --remote-debugging-port
// at all, so it is unreachable over CDP by construction — but we assert the match here
// anyway and bail loudly rather than ever risk driving the wrong window.
//
// Subcommands:
//   screenshot <out.png> [--no-reload]   reload (default) then capture a PNG
//   eval "<js>"                          Runtime.evaluate, returnByValue + awaitPromise
//   reload                               Page.reload + wait for load
//   pageport                             print the live page's location.port (health)

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PROBE_DIR = process.env.PROBE_DIR;
if (!PROBE_DIR) fail('PROBE_DIR is not set (run this via probe.sh, not directly)');

let probe;
try {
  probe = JSON.parse(readFileSync(path.join(PROBE_DIR, 'probe.json'), 'utf8'));
} catch (e) {
  fail(`cannot read ${path.join(PROBE_DIR, 'probe.json')}: ${e.message}`);
}
const { cdpPort, vitePort } = probe;

function fail(msg) {
  console.error(`cdp: ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find the page target that belongs to OUR vite server — and no other.
async function pageTarget() {
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    targets = await res.json();
  } catch (e) {
    fail(`CDP endpoint not reachable on :${cdpPort} (probe down?): ${e.message}`);
  }
  const pages = targets.filter((t) => t.type === 'page');
  const mine = pages.find((t) => {
    try {
      const u = new URL(t.url);
      return u.hostname === '127.0.0.1' && u.port === String(vitePort);
    } catch {
      return false;
    }
  });
  if (!mine) {
    const seen = pages.map((p) => p.url).join(', ') || 'none';
    fail(`no page target on 127.0.0.1:${vitePort} — refusing to attach (saw: ${seen})`);
  }
  return mine;
}

// Minimal CDP client over a single WebSocket: id/result correlation + event listeners.
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('websocket error')));
      this.ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners.get(msg.method) || []) l(msg.params);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method) {
    return new Promise((resolve) => {
      const arr = this.listeners.get(method) || [];
      const fn = (p) => {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
        resolve(p);
      };
      arr.push(fn);
      this.listeners.set(method, arr);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function withPage(fn) {
  const target = await pageTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open();
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

// Reload and block until the load event fires (or a timeout), so renderer edits show
// through vite's deliberate hmr:false. Then a short settle for the first paint.
async function reload(cdp) {
  await cdp.send('Page.enable');
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.reload', { ignoreCache: true });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(300);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'screenshot') {
  const noReload = rest.includes('--no-reload');
  const out = rest.find((a) => a !== '--no-reload');
  if (!out) fail('screenshot needs an output path');
  await withPage(async (cdp) => {
    if (!noReload) await reload(cdp);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(out);
  });
} else if (cmd === 'eval') {
  const expression = rest.join(' ');
  if (!expression) fail('eval needs a JS expression');
  await withPage(async (cdp) => {
    await cdp.send('Runtime.enable');
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      fail(exceptionDetails.exception?.description || exceptionDetails.text || 'evaluation threw');
    }
    console.log(JSON.stringify(result.value ?? null, null, 2));
  });
} else if (cmd === 'reload') {
  await withPage(async (cdp) => {
    await reload(cdp);
    console.log('reloaded');
  });
} else if (cmd === 'pageport') {
  // Health probe: prints the live page's own location.port. pageTarget() has already
  // guaranteed the target URL matches our vite port before we get here.
  await withPage(async (cdp) => {
    await cdp.send('Runtime.enable');
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'location.port',
      returnByValue: true,
    });
    console.log(result.value ?? '');
  });
} else {
  fail(`unknown command: ${cmd || '(none)'} — expected screenshot|eval|reload|pageport`);
}
