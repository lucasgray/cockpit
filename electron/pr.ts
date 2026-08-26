import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrInfo, PrResult } from '../src/bridge';

const execFileAsync = promisify(execFile);

/** The branch a worktree currently has checked out, or '' on a detached HEAD. */
async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const branch = stdout.trim();
  return branch === 'HEAD' ? '' : branch;
}

/** stderr carries the useful failure; fall back to the argv-wrapping message. */
function toolError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message.trim() : String(error);
}

/**
 * git narrates a rejected push with a wall of `hint:` remediation lines, and the
 * one line that says what actually happened — `! [rejected]` / "Updates were
 * rejected because…" — is buried in the middle. Drop the boilerplate and keep
 * the rejection, so the UI shows the reason rather than git's advice column.
 */
function pushError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr !== 'string' || !stderr.trim()) return toolError(error);

  const lines = stderr
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() && !/^hint:/i.test(line));
  const rejection = lines.filter((line) => /rejected|\berror:|\bfatal:|^\s*!/i.test(line));
  return (rejection.length ? rejection : lines).join('\n').trim() || 'git push failed';
}

/**
 * The open PR for `branch`, straight from GitHub. Returns null when there's no
 * PR yet, when gh isn't reachable, or when the only PR is already merged/closed —
 * none of which is an open PR the button should offer to update.
 */
export async function prStatus(cwd: string): Promise<PrInfo | null> {
  const branch = await currentBranch(cwd).catch(() => '');
  if (!branch) return null;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', branch, '--json', 'number,url,state'],
      { cwd },
    );
    const data = JSON.parse(stdout) as { number?: number; url?: string; state?: string };
    if (typeof data.number !== 'number' || !data.url) return null;
    if (data.state && data.state !== 'OPEN') return null;
    return { number: data.number, url: data.url, state: data.state };
  } catch {
    // No PR for this branch, or gh unavailable — either way, nothing to update.
    return null;
  }
}

/**
 * Push the worktree's branch and make sure it has a PR. A push is the update
 * path when a PR already exists; when none does, `gh pr create --fill` opens one
 * from the branch's commits. Never forces: a rejected push means the remote has
 * work this branch doesn't, and a PR flow must surface that, not bulldoze it.
 */
export async function openPr(cwd: string): Promise<PrResult> {
  let branch: string;
  try {
    branch = await currentBranch(cwd);
  } catch (error) {
    return { ok: false, error: toolError(error) };
  }
  if (!branch) {
    return { ok: false, error: 'This worktree is on a detached HEAD — nothing to open a PR from.' };
  }

  try {
    await execFileAsync('git', ['push', '--set-upstream', 'origin', branch], { cwd });
  } catch (error) {
    return { ok: false, error: pushError(error) };
  }

  // The push already updated any open PR; report it rather than trying to create
  // a second one (which gh would refuse anyway).
  const existing = await prStatus(cwd);
  if (existing) return { ok: true, pr: existing, created: false };

  try {
    await execFileAsync('gh', ['pr', 'create', '--fill', '--head', branch], { cwd });
  } catch (error) {
    return { ok: false, error: toolError(error) };
  }

  const created = await prStatus(cwd);
  if (!created) return { ok: false, error: 'PR created, but reading its number back failed.' };
  return { ok: true, pr: created, created: true };
}
