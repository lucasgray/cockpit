import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileContents, FileEntry, FileWriteResult } from '../src/bridge';

/**
 * Reading and writing the files a worktree holds, for the Files rail and the
 * editor pane beside it.
 *
 * The renderer names paths relative to a worktree root and nothing else: every
 * one is resolved through `realpath` and checked for containment before it's
 * touched, so a symlink pointing at `/etc` is refused rather than followed. The
 * caller is responsible for proving the root is a worktree the cockpit knows —
 * see `worktreeRoot` in main.ts. Together those two checks are what keep this
 * from being a browse-the-whole-disk API handed to the page.
 */

/** Bigger than this and the pane shows a note instead of trying to render it. */
const MAX_BYTES = 2 * 1024 * 1024;
/** A directory past this is almost certainly not one you meant to read. */
const MAX_ENTRIES = 2_000;
/** Prefix scanned for NUL bytes to tell text from binary. */
const SNIFF_BYTES = 8_192;

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * The real location of `target`, even when it doesn't exist yet — a file being
 * saved for the first time still has to prove where it would land, and that
 * answer lives in its parent directory.
 */
async function realTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.join(await realpath(path.dirname(target)), path.basename(target));
  }
}

/** Resolve a worktree-relative path, refusing anything that leaves the tree. */
async function resolveInside(root: string, rel: string): Promise<string> {
  if (path.isAbsolute(rel)) throw new Error('Path must be relative to the worktree');
  const realRoot = await realpath(root);
  const real = await realTarget(path.resolve(realRoot, rel));
  if (!contains(realRoot, real)) throw new Error(`Path escapes the worktree: ${rel}`);
  return real;
}

/**
 * Which of these paths git ignores — one batched call per directory the tree
 * expands, so `node_modules`, `dist` and friends disappear by the repo's own
 * rules rather than a list baked in here.
 *
 * A non-zero exit is the normal answer for "nothing here is ignored", and a
 * directory that isn't a repo at all just yields nothing — either way an empty
 * set is the right fallback, so failures hide nothing instead of hiding all.
 */
function gitIgnored(root: string, relPaths: string[]): Promise<Set<string>> {
  if (!relPaths.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['check-ignore', '-z', '--stdin'],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout) => resolve(new Set(stdout.split('\0').filter(Boolean))),
    );
    child.on('error', () => resolve(new Set()));
    child.stdin?.end(relPaths.join('\0'));
  });
}

/** Directories first, then case-insensitively by name — the familiar order. */
function byKindThenName(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export async function listDir(root: string, rel: string): Promise<FileEntry[]> {
  const dir = await resolveInside(root, rel || '');
  const dirents = await readdir(dir, { withFileTypes: true });

  const entries: FileEntry[] = [];
  for (const entry of dirents.slice(0, MAX_ENTRIES)) {
    // .git is the machinery, not the project.
    if (entry.name === '.git') continue;

    const abs = path.join(dir, entry.name);
    let kind: 'dir' | 'file' = entry.isDirectory() ? 'dir' : 'file';

    // A symlink is neither until it's followed. Follow it far enough to know
    // whether it expands, and drop it outright if it leads out of the worktree —
    // the tree shouldn't offer a door that opening would refuse.
    if (entry.isSymbolicLink()) {
      try {
        if (!contains(await realpath(root), await realpath(abs))) continue;
        kind = (await stat(abs)).isDirectory() ? 'dir' : 'file';
      } catch {
        continue; // dangling link
      }
    }

    entries.push({
      name: entry.name,
      path: rel ? `${rel}/${entry.name}` : entry.name,
      kind,
    });
  }

  const ignored = await gitIgnored(root, entries.map((entry) => entry.path));
  return entries.filter((entry) => !ignored.has(entry.path)).sort(byKindThenName);
}

export async function readFileContents(root: string, rel: string): Promise<FileContents> {
  const file = await resolveInside(root, rel);
  const info = await stat(file);
  const base = { path: rel, text: '', bytes: info.size, mtime: info.mtimeMs };

  if (info.size > MAX_BYTES) return { ...base, reason: 'too-large' };
  const buf = await readFile(file);
  if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { ...base, reason: 'binary' };
  return { ...base, text: buf.toString('utf8') };
}

/**
 * Save, unless someone got there first. `mtime` is what the matching read saw;
 * anything else on disk now — an agent turn that rewrote the file, an editor
 * outside the cockpit — comes back as a conflict for the operator to resolve
 * rather than being silently overwritten.
 */
export async function writeFileContents(
  root: string,
  rel: string,
  text: string,
  mtime: number,
): Promise<FileWriteResult> {
  try {
    const file = await resolveInside(root, rel);
    const before = await stat(file).catch(() => null);
    // Nothing here creates files, so a missing one means it was deleted under us.
    if (!before || before.mtimeMs !== mtime) return { ok: false, conflict: true };

    await writeFile(file, text, 'utf8');
    return { ok: true, mtime: (await stat(file)).mtimeMs };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
