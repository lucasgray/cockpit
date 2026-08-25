import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Worktree, WorktreeCreateResult } from '../src/bridge';
import { closeAllAgents, interruptAgent, resetAgent, runAgent } from './agentRunner';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT =
  process.env.COCKPIT_PROJECT_ROOT || '/Users/lucas-comp/projects/agent-cockpit';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

const BOOTSTRAP = process.env.COCKPIT_BOOTSTRAP || 'npm install';

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

  // Bootstrap in the background: the worktree is editable immediately; only
  // running tests/builds there waits for the install to finish.
  const [cmd, ...cmdArgs] = BOOTSTRAP.split(' ');
  try {
    const child = spawn(cmd, cmdArgs, { cwd: dir, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No bootstrap command available — the worktree still exists.
  }

  return { ok: true, path: dir, branch: name };
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

    worktrees.push({
      path: wtPath,
      name: path.basename(wtPath),
      branch,
      head: head.slice(0, 7),
      isMain: index === 0,
      dirty,
    });
  }
  return worktrees;
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

  if (!app.isPackaged) {
    win.loadURL(process.env.COCKPIT_DEV_URL || 'http://127.0.0.1:5273');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('worktrees:list', () => listWorktrees());
  ipcMain.handle('worktrees:create', (_event, branch: string) => createWorktree(branch));
  ipcMain.handle(
    'agent:run',
    (event, req: { prompt: string; cwd: string; runId: string }) =>
      runAgent(req, (agentEvent) => event.sender.send(`agent:event:${req.runId}`, agentEvent)),
  );
  ipcMain.handle('agent:interrupt', (_event, cwd: string) => interruptAgent(cwd));
  ipcMain.handle('agent:reset', (_event, cwd: string) => resetAgent(cwd));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Live sessions own CLI subprocesses — tear them down instead of orphaning them.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  closeAllAgents().finally(() => app.quit());
});
