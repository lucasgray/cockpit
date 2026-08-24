import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Worktree } from '../src/bridge';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT =
  process.env.COCKPIT_PROJECT_ROOT || '/Users/lucas-comp/projects/comp-monorepo';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
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
    win.loadURL(process.env.COCKPIT_DEV_URL || 'http://localhost:5273');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('worktrees:list', () => listWorktrees());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
