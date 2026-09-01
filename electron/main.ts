import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { AgentEvent, OutboundImage } from '../src/agent/protocol';
import type { Worktree, WorktreeCreateResult, WorktreeRemoveResult } from '../src/bridge';
import {
  answerAgent,
  closeAgent,
  closeAllAgents,
  interruptAgent,
  modelCatalog,
  resetAgent,
  runAgent,
} from './agentRunner';
import { dirStamps, listDir, readFileContents, writeFileContents } from './files';
import { dropImages, openImageStore, readImage, saveImages } from './images';
import {
  closeRun,
  detectRunCommand,
  onRunEvent,
  runEnv,
  runStatus,
  startRun,
  stopRun,
} from './runner';
import { openPr, prStatus } from './pr';
import { ensurePort } from './ports';
import { buildMenu } from './menu';
import { getStore, openStore } from './store';
import type { CockpitSettings, EffortChoice } from '../src/settings';
import { resolvePort } from '../src/port';

const execFileAsync = promisify(execFile);

/**
 * The git repository the cockpit manages — every git call runs with this as its
 * cwd. Point the cockpit at a repo with `COCKPIT_PROJECT_ROOT`; unset, it falls
 * back to the directory the app was launched from, which under `npm run app` is
 * the repo itself.
 *
 * This used to default to one machine's absolute path. A missing env var then
 * sent every git call `chdir`ing into a directory this account can't read, and
 * the failed chdir surfaced as a cryptic `spawn git EACCES` — see the assertion
 * in `whenReady` that now turns a bad root into a legible error instead.
 */
const PROJECT_ROOT = path.resolve(process.env.COCKPIT_PROJECT_ROOT || process.cwd());

/**
 * How a transcript names a screenshot it is holding.
 *
 * Pasted images are files beside the database rather than base64 in the event
 * stream, so the renderer needs some way to put one in an `<img src>`. A scheme
 * of the cockpit's own does it without opening `file://` to the page: the handler
 * below resolves every request inside the image store and refuses the rest.
 *
 * Registered at module scope because privileged schemes have to be declared
 * before the app is ready — the handler itself is installed in whenReady.
 */
const IMAGE_SCHEME = 'cockpit-image';
protocol.registerSchemesAsPrivileged([
  // Standard so the URL parses host-then-path, secure so a page served over http
  // in dev isn't refused it as mixed content. Nothing more: these images are only
  // ever loaded by an <img>, never fetched.
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } },
]);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/**
 * Fail fast, and legibly, if `PROJECT_ROOT` isn't a git repo we can reach.
 *
 * Every feature runs git in this directory, so a wrong or unreadable root breaks
 * all of them the same cryptic way (`spawn git EACCES` from a failed chdir). One
 * check at startup trades that for a message that names the actual problem and
 * how to fix it. Returns whether the root is usable; the caller decides.
 */
async function assertProjectRoot(): Promise<boolean> {
  try {
    await git(PROJECT_ROOT, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    const message =
      `COCKPIT_PROJECT_ROOT is not a readable git repository:\n\n${PROJECT_ROOT}\n\n` +
      `Launch the cockpit pointed at your repo, e.g.\n` +
      `  COCKPIT_PROJECT_ROOT=/path/to/repo npm run app`;
    console.error(message);
    dialog.showErrorBox('Cockpit: no project repository', message);
    return false;
  }
}

/** Fallback create hook when settings don't pin one. */
const WORKTREE_CREATE_HOOK = process.env.COCKPIT_WORKTREE_CREATE_HOOK || 'npm install';

function dirForBranch(branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  return path.join(path.dirname(PROJECT_ROOT), `${path.basename(PROJECT_ROOT)}--${safe}`);
}

async function branchExists(branch: string): Promise<boolean> {
  try {
    await git(PROJECT_ROOT, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the worktree-create hook in a brand-new worktree.
 *
 * Backgrounded on purpose: the worktree is editable the moment git returns, and
 * only running something in it needs the install finished. Output is piped so a
 * failing hook can say why instead of vanishing — the tail goes to the renderer
 * when it exits.
 */
function runCreateHook(dir: string, branch: string, port: number) {
  const command = getStore().settings().worktreeCreateHook || WORKTREE_CREATE_HOOK;
  if (!command) return;

  let tail = '';
  const child = spawn(command, {
    cwd: dir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // The hook's whole reason for existing: it can bake the port into a file
      // at the one moment the worktree is new — the same env a run would get.
      ...runEnv(port),
      COCKPIT_WORKTREE: dir,
      COCKPIT_BRANCH: branch,
    },
  });

  const collect = (data: Buffer) => {
    tail = (tail + data.toString()).slice(-4_000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const report = (code: number | null, error?: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('worktrees:hook', { cwd: dir, branch, command, port, code, tail, error });
      }
    }
  };

  child.on('error', (error) => report(null, error.message));
  child.on('exit', (code) => report(code));
}

async function createWorktree(branch: string): Promise<WorktreeCreateResult> {
  const name = branch.trim();
  if (!name) return { ok: false, error: 'Branch name required' };

  const dir = dirForBranch(name);
  try {
    const base = ['worktree', 'add', dir];
    const args = (await branchExists(name)) ? [...base, name] : [...base, '-b', name];
    await git(PROJECT_ROOT, args);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.trim() : String(error) };
  }

  // Assigned before the hook runs, so the hook is the first thing that sees it.
  const port = await ensurePort(dir);
  runCreateHook(dir, name, port);

  return { ok: true, path: dir, branch: name, port };
}

/** Run git and return stdout even on a non-zero exit (diff exits 1 on changes). */
async function gitOut(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

/**
 * A unified diff of everything the agent changed in a worktree since its last
 * commit: tracked edits via `git diff HEAD`, plus each new untracked file diffed
 * against /dev/null so created files show up too.
 */
async function worktreeDiff(cwd: string): Promise<string> {
  let out = await gitOut(cwd, ['--no-pager', 'diff', 'HEAD']);
  const untracked = (await gitOut(cwd, ['ls-files', '--others', '--exclude-standard'])).trim();
  if (untracked) {
    for (const file of untracked.split('\n').filter(Boolean).slice(0, 50)) {
      out += `\n${await gitOut(cwd, ['--no-pager', 'diff', '--no-index', '--', '/dev/null', file])}`;
    }
  }
  return out.trim();
}

/**
 * Every line of a new file is an insertion, so untracked files are counted here
 * rather than diffed — one read beats one `git diff --no-index` per file. Binary
 * content has no lines to count, which is also what git reports for it.
 */
async function countLines(file: string): Promise<number> {
  try {
    const buf = await readFile(file);
    if (!buf.length || buf.includes(0)) return 0;
    let lines = 0;
    for (const byte of buf) if (byte === 0x0a) lines++;
    return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
  } catch {
    return 0;
  }
}

/** The +/- behind the dirty flag: tracked edits plus every new untracked file. */
async function worktreeStat(cwd: string): Promise<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;

  for (const line of (await gitOut(cwd, ['--no-pager', 'diff', '--numstat', 'HEAD'])).split('\n')) {
    const [add, del] = line.split('\t');
    // Binary files report "-" for both counts; Number() makes those NaN → 0.
    added += Number(add) || 0;
    removed += Number(del) || 0;
  }

  const untracked = (await gitOut(cwd, ['ls-files', '--others', '--exclude-standard'])).trim();
  for (const file of untracked ? untracked.split('\n').filter(Boolean).slice(0, 200) : []) {
    added += await countLines(path.join(cwd, file));
  }

  return { added, removed };
}

/**
 * Worktree paths from the most recent listing. This is the allowlist the file
 * API checks against: the renderer can name a root, but only one the cockpit
 * has actually seen git report.
 */
const knownWorktrees = new Set<string>();

async function worktreeRoot(cwd: string): Promise<string> {
  // A worktree made since the last listing deserves one refresh before a refusal.
  if (!knownWorktrees.has(cwd)) await listWorktrees();
  if (!knownWorktrees.has(cwd)) throw new Error(`Not a worktree of this project: ${cwd}`);
  return cwd;
}

async function listWorktrees(): Promise<Worktree[]> {
  const out = await git(PROJECT_ROOT, ['worktree', 'list', '--porcelain']);
  const blocks = out.trim().split('\n\n');
  const worktrees: Worktree[] = [];

  for (const [index, block] of blocks.entries()) {
    let wtPath = '';
    let head = '';
    let branch = '(detached)';

    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace('refs/heads/', '');
      else if (line === 'detached') branch = '(detached)';
    }
    if (!wtPath) continue;

    let dirty = false;
    try {
      dirty = (await git(wtPath, ['status', '--porcelain'])).trim().length > 0;
    } catch {
      // worktree may be locked/missing — treat as clean
    }

    // Only a dirty worktree has anything to count.
    const { added, removed } = dirty ? await worktreeStat(wtPath) : { added: 0, removed: 0 };

    worktrees.push({
      path: wtPath,
      name: path.basename(wtPath),
      branch,
      head: head.slice(0, 7),
      isMain: index === 0,
      dirty,
      added,
      removed,
      // Assigned on the first listing that sees the worktree — including ones
      // made outside the cockpit — so the create hook and anything started in
      // the worktree by hand agree on a stable number.
      port: await ensurePort(wtPath),
    });
  }

  knownWorktrees.clear();
  for (const wt of worktrees) knownWorktrees.add(wt.path);
  return worktrees;
}

/** git puts the useful part of a failure on stderr; the message wraps the argv. */
function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message.trim() : String(error);
}

/**
 * Delete a non-main worktree along with its branch. Uncommitted work goes with
 * it — this is the throw-it-away path, and the UI confirms before calling.
 */
async function removeWorktree(cwd: string): Promise<WorktreeRemoveResult> {
  const worktrees = await listWorktrees();
  const target = worktrees.find((wt) => wt.path === cwd);
  if (!target) return { ok: false, error: 'Worktree not found' };
  if (target.isMain) return { ok: false, error: 'The main worktree cannot be removed' };

  // The session holds a CLI subprocess with this directory as its cwd, and a run
  // may hold a dev server on it too — close both before the directory disappears
  // from under them. Bounded, because neither must be able to wedge the removal:
  // worst case they're orphaned and reaped at quit, which beats a button that
  // never comes back.
  await Promise.race([
    Promise.allSettled([closeAgent(cwd), stopRun(cwd)]),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

  try {
    await git(PROJECT_ROOT, ['worktree', 'remove', '--force', cwd]);
  } catch (error) {
    return { ok: false, error: gitError(error) };
  }
  if (target.branch !== '(detached)') {
    await git(PROJECT_ROOT, ['branch', '-D', target.branch]).catch(() => {
      // Worktree is gone either way; a stuck branch is a leftover, not a failure.
    });
  }

  getStore().clearTranscript(cwd);
  // The remembered PR pointed at this branch; the branch is gone, so forget it.
  getStore().setPr(cwd, null);
  void dropImages(cwd);
  // The port goes back in the pool — otherwise a long-lived cockpit would walk
  // its assignments upward forever as worktrees come and go.
  getStore().releasePort(cwd);
  return { ok: true };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#16181f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // A transcript link is a destination out on the web, not a second cockpit:
  // hand it to the user's real browser instead of spawning a bare Electron
  // window. setWindowOpenHandler catches the target="_blank" anchors the
  // markdown renderer emits (http(s) and mailto — the only hrefs it allows);
  // will-navigate catches anything that would replace the app itself with an
  // off-origin page. Same-origin navigation (a dev-server reload) is left alone.
  const openExternally = (url: string) => {
    if (/^(?:https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const here = new URL(win.webContents.getURL());
    if (new URL(url).origin !== here.origin) {
      event.preventDefault();
      openExternally(url);
    }
  });

  // A run belongs to the app, not to a call, so its status goes straight to the
  // window. Guarded because a run can change state while the window tears down.
  onRunEvent((event) => {
    if (!win.isDestroyed()) win.webContents.send('run:event', event);
  });

  if (!app.isPackaged) {
    // When the cockpit is itself started by a cockpit, COCKPIT_PORT says which
    // vite belongs to this worktree — the window must not load a sibling's.
    win.loadURL(process.env.COCKPIT_DEV_URL || `http://127.0.0.1:${resolvePort(process.env)}`);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  // A sensible default covers the normal launch, so this rarely fires — but when
  // the root is wrong it names the problem up front instead of letting every git
  // call fail the same cryptic way.
  void assertProjectRoot();

  // The app's own state lives beside the app, never in the repo being worked on.
  openStore(app.getPath('userData'));
  openImageStore(app.getPath('userData'));
  buildMenu();

  // `cockpit-image://image/<worktree>/<name>` — a fixed host, and a path that is
  // the file's own name inside the store. Nothing outside it can be reached.
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const found = await readImage(decodeURIComponent(pathname).replace(/^\/+/, ''));
    if (!found) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(found.bytes), {
      headers: { 'content-type': found.mediaType, 'cache-control': 'no-store' },
    });
  });

  ipcMain.handle('worktrees:list', () => listWorktrees());
  ipcMain.handle('worktrees:create', (_event, branch: string) => createWorktree(branch));
  ipcMain.handle('worktrees:diff', (_event, cwd: string) => worktreeDiff(cwd));
  ipcMain.handle('worktrees:remove', (_event, cwd: string) => removeWorktree(cwd));
  ipcMain.handle('pr:status', async (_event, cwd: string) => {
    // Live gh is the source of truth; the remembered PR is only a fallback for
    // when it can't answer (offline, gh missing), so a known PR still labels the
    // button. When gh *does* answer — including "no open PR" for a merged or
    // closed one — trust it and keep the remembered PR in sync, so a stale #N
    // stops labeling the button now and next session.
    const live = await prStatus(cwd);
    if (live.reachable) {
      getStore().setPr(cwd, live.pr ? { number: live.pr.number, url: live.pr.url } : null);
      return live.pr;
    }
    return getStore().pr(cwd);
  });
  ipcMain.handle('pr:open', async (_event, cwd: string) => {
    const result = await openPr(cwd);
    if (result.ok && result.pr) {
      getStore().setPr(cwd, { number: result.pr.number, url: result.pr.url });
    }
    return result;
  });
  ipcMain.handle(
    'agent:run',
    async (
      event,
      req: { prompt: string; cwd: string; runId: string; images?: OutboundImage[] },
    ) => {
      const store = getStore();
      // Pasted screenshots go to disk before the turn starts, so the stored
      // transcript can name them. The bytes Claude reads are still the ones on
      // the request — these are the copy the conversation comes back with.
      const images = await saveImages(req.cwd, req.images ?? []);
      // The renderer echoes the prompt for immediate feedback, but the stored
      // transcript is written here — so record it too, or a restored
      // conversation would come back as Claude talking to nobody.
      store.appendEvent(req.cwd, {
        type: 'user',
        text: req.prompt,
        ...(images.length ? { images } : {}),
      });
      // The three switchers are read here rather than sent with the prompt: the
      // store is where they live, and this is the moment they have to be true.
      // An unpinned model falls back to the cockpit's settings, then to the CLI.
      const config = {
        thinking: store.thinking(req.cwd),
        model: store.model(req.cwd) || store.settings().model,
        effort: store.effort(req.cwd),
      };
      return runAgent({ ...req, ...config }, (agentEvent: AgentEvent) => {
        store.appendEvent(req.cwd, agentEvent);
        event.sender.send(`agent:event:${req.runId}`, agentEvent);
      });
    },
  );
  ipcMain.handle('agent:interrupt', (_event, cwd: string) => interruptAgent(cwd));
  ipcMain.handle('agent:reset', (_event, cwd: string) => resetAgent(cwd));
  ipcMain.handle('agent:models', () => modelCatalog());
  ipcMain.handle(
    'agent:answer',
    (_event, req: { cwd: string; id: string; selection: string }) =>
      answerAgent(req.cwd, req.id, req.selection),
  );

  // Every file call proves its root is a known worktree before it touches disk.
  ipcMain.handle('files:list', async (_event, cwd: string, dir: string) =>
    listDir(await worktreeRoot(cwd), dir),
  );
  ipcMain.handle('files:stamps', async (_event, cwd: string, dirs: string[]) =>
    dirStamps(await worktreeRoot(cwd), dirs),
  );
  ipcMain.handle('files:read', async (_event, cwd: string, file: string) =>
    readFileContents(await worktreeRoot(cwd), file),
  );
  ipcMain.handle(
    'files:write',
    async (_event, req: { cwd: string; path: string; text: string; mtime: number }) =>
      writeFileContents(await worktreeRoot(req.cwd), req.path, req.text, req.mtime),
  );

  ipcMain.handle('run:detect', (_event, cwd: string) => detectRunCommand(cwd));
  ipcMain.handle('run:start', (_event, cwd: string, command?: string) => startRun(cwd, command));
  ipcMain.handle('run:stop', (_event, cwd: string) => stopRun(cwd));
  ipcMain.handle('run:status', (_event, cwd: string) => runStatus(cwd));

  ipcMain.handle('store:transcript', (_event, cwd: string) => getStore().transcript(cwd));
  // Clearing a transcript clears what it was holding: the screenshots in it are
  // only reachable through the events being deleted.
  ipcMain.handle('store:clearTranscript', (_event, cwd: string) => {
    getStore().clearTranscript(cwd);
    return dropImages(cwd);
  });
  ipcMain.handle('store:selectedWorktree', () => getStore().selectedWorktree());
  ipcMain.handle('store:setSelectedWorktree', (_event, cwd: string | null) =>
    getStore().setSelectedWorktree(cwd),
  );
  ipcMain.handle('store:openFiles', (_event, cwd: string) => getStore().openFiles(cwd));
  ipcMain.handle(
    'store:setOpenFiles',
    (_event, cwd: string, open: string[], active: string | null) =>
      getStore().setOpenFiles(cwd, open, active),
  );
  ipcMain.handle('store:draft', (_event, cwd: string) => getStore().draft(cwd));
  ipcMain.handle('store:setDraft', (_event, cwd: string, text: string) =>
    getStore().setDraft(cwd, text),
  );
  ipcMain.handle('store:thinking', (_event, cwd: string) => getStore().thinking(cwd));
  ipcMain.handle('store:setThinking', (_event, cwd: string, on: boolean) =>
    getStore().setThinking(cwd, on),
  );
  ipcMain.handle('store:model', (_event, cwd: string) => getStore().model(cwd));
  ipcMain.handle('store:setModel', (_event, cwd: string, model: string) =>
    getStore().setModel(cwd, model),
  );
  ipcMain.handle('store:effort', (_event, cwd: string) => getStore().effort(cwd));
  ipcMain.handle('store:setEffort', (_event, cwd: string, effort: EffortChoice) =>
    getStore().setEffort(cwd, effort),
  );
  ipcMain.handle('store:railView', () => getStore().railView());
  ipcMain.handle('store:setRailView', (_event, view: string) => getStore().setRailView(view));
  ipcMain.handle('store:settings', () => getStore().settings());
  ipcMain.handle('store:saveSettings', (_event, patch: Partial<CockpitSettings>) =>
    getStore().saveSettings(patch),
  );

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Live sessions and dev servers both own subprocesses — tear them down instead
// of orphaning them holding a port.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  Promise.allSettled([closeAllAgents(), closeRun()])
    .finally(() => getStore().close())
    .finally(() => app.quit());
});
