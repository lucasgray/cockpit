import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PrInfo, PrResult } from '../src/bridge';
import { loadSdk } from './agentRunner';

const execFileAsync = promisify(execFile);

/** Diff sent to the commit-message model — plenty for context, cheap to send. */
const DIFF_BUDGET = 20_000;

/** No PR step should run forever. A push or `gh` call that stalls (a credential
 *  prompt, an unreachable host) has to fail loudly, not spin the button. */
const STEP_TIMEOUT = 60_000;

/** The commit/branch text calls stream from the model; cap them so a query that
 *  never lands a result message falls back instead of hanging the whole flow. */
const MODEL_TIMEOUT = 45_000;

/** Reject `p` if it hasn't settled within `ms`, so a stalled step surfaces. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The branch a worktree currently has checked out, or '' on a detached HEAD. */
async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const branch = stdout.trim();
  return branch === 'HEAD' ? '' : branch;
}

/**
 * The repo's default branch (the one `origin/HEAD` points at), or '' when it
 * can't be resolved. Used to recognise when a worktree is sitting on the branch
 * a PR should never target directly, so the flow can branch off it first.
 */
async function defaultBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd },
    );
    const ref = stdout.trim();
    const slash = ref.indexOf('/');
    return slash === -1 ? ref : ref.slice(slash + 1);
  } catch {
    return '';
  }
}

/** Does this local branch already exist? Keeps a generated name from colliding. */
async function branchExists(cwd: string, name: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Fold arbitrary text down to a safe kebab-case git branch slug. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
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

/** A plain-text fallback when the model can't be reached — better than failing
 *  the whole PR flow over a commit message. */
async function fallbackCommitMessage(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd });
    const files = stdout.trim().split('\n').filter(Boolean);
    if (!files.length) return 'Update files';
    if (files.length <= 3) return `Update ${files.map((f) => path.basename(f)).join(', ')}`;
    return `Update ${files.length} files`;
  } catch {
    return 'Update files';
  }
}

/**
 * A single cheap text completion: the SDK with no tools and one turn — not an
 * agent session — so it's one call rather than a full Claude Code turn. Shared by
 * the commit-message and branch-name generators.
 */
async function completeText(prompt: string): Promise<string> {
  const { query } = await loadSdk();
  const run = (async () => {
    let text = '';
    for await (const msg of query({ prompt, options: { tools: [], maxTurns: 1, model: 'haiku' } })) {
      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) if (block.type === 'text') text += block.text;
        }
      }
      if (msg.type === 'result') break;
    }
    return text.trim();
  })();
  return withTimeout(run, MODEL_TIMEOUT, 'text generation');
}

/** Clip a diff to the model budget, with a marker when it's been cut. */
function clipDiff(diff: string): string {
  return diff.length > DIFF_BUDGET ? `${diff.slice(0, DIFF_BUDGET)}\n… (truncated)` : diff;
}

/**
 * A one-line-subject (+ optional body) commit message written from the staged
 * diff.
 */
async function generateCommitMessage(diff: string): Promise<string> {
  const trimmed = clipDiff(diff);
  if (!trimmed.trim()) throw new Error('empty diff');

  const prompt =
    'Write a git commit message for the diff below. One short imperative subject line ' +
    '(under 72 characters), and only if it genuinely helps, a blank line followed by 1-3 ' +
    'sentences on why the change was made. Plain text only: no markdown, no backticks, no ' +
    'surrounding quotes, no "Co-Authored-By" line. Reply with nothing but the commit message.\n\n' +
    trimmed;

  const cleaned = await completeText(prompt);
  if (!cleaned) throw new Error('empty commit message');
  return cleaned;
}

/**
 * A short kebab-case branch name suggested from the pending change, falling back
 * to the last commit's subject and finally a generic slug — always something the
 * flow can create a branch from. Guaranteed not to collide with a local branch.
 */
async function newBranchName(cwd: string): Promise<string> {
  let seed = '';
  try {
    const { stdout: diff } = await execFileAsync('git', ['diff', 'HEAD'], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (diff.trim()) {
      const prompt =
        'Suggest a git branch name for the diff below. Two to four words, lowercase, ' +
        'hyphen-separated (kebab-case). No slashes, no prefixes, no quotes. ' +
        'Reply with nothing but the branch name.\n\n' + clipDiff(diff);
      seed = await completeText(prompt).catch(() => '');
    }
  } catch {
    // fall through to the commit-subject seed
  }
  if (!slugify(seed)) {
    seed = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd })
      .then((r) => r.stdout.trim())
      .catch(() => '');
  }

  const base = slugify(seed) || 'cockpit-pr';
  let name = base;
  for (let n = 2; await branchExists(cwd, name); n++) name = `${base}-${n}`;
  return name;
}

/**
 * Commit whatever the worktree is holding before a PR flow pushes it — the app
 * never commits on its own initiative, but a PR with no commits is just an
 * error `gh` can't recover from, so "open a PR" has to mean "commit and open a
 * PR" once the operator has actually asked for one. Returns whether anything
 * was committed, purely for logging; the caller doesn't branch on it.
 */
async function commitIfDirty(cwd: string): Promise<boolean> {
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
  if (!status.trim()) return false;

  await execFileAsync('git', ['add', '-A'], { cwd });
  const { stdout: diff } = await execFileAsync('git', ['diff', '--cached'], {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
  });
  const message = await generateCommitMessage(diff).catch(() => fallbackCommitMessage(cwd));
  await execFileAsync('git', ['commit', '-m', message], { cwd });
  return true;
}

/**
 * A PR lookup's outcome. `reachable` marks whether gh gave a definitive answer:
 * when it did, `pr` is the open PR or null (no PR yet, or the only one is already
 * merged/closed — both mean "nothing to update"), and a null is trustworthy
 * enough to forget a remembered PR by. When gh couldn't answer at all (offline,
 * not installed), `reachable` is false and the caller should keep whatever it
 * last remembered rather than treat silence as "no PR".
 */
export type PrLookup = { reachable: true; pr: PrInfo | null } | { reachable: false };

/** gh exits non-zero both when a branch simply has no PR and when it can't reach
 *  GitHub at all; only the former is a definitive "no open PR" we can act on. */
function isNoPrError(error: unknown): boolean {
  const stderr = (error as { stderr?: string }).stderr;
  return typeof stderr === 'string' && /no.*pull requests? found/i.test(stderr);
}

/**
 * The open PR for the worktree's branch, straight from GitHub. See {@link PrLookup}:
 * a reachable lookup distinguishes "gh says no open PR" (which should clear a
 * remembered merged/closed PR) from "gh couldn't answer" (which should not).
 */
export async function prStatus(cwd: string): Promise<PrLookup> {
  const branch = await currentBranch(cwd).catch(() => '');
  // A git failure or detached HEAD isn't gh saying "no PR" — leave any remembered
  // PR standing rather than clobber it on a transient hiccup.
  if (!branch) return { reachable: false };
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', branch, '--json', 'number,url,state'],
      { cwd },
    );
    const data = JSON.parse(stdout) as { number?: number; url?: string; state?: string };
    if (typeof data.number !== 'number' || !data.url) return { reachable: true, pr: null };
    if (data.state && data.state !== 'OPEN') return { reachable: true, pr: null };
    return { reachable: true, pr: { number: data.number, url: data.url, state: data.state } };
  } catch (error) {
    // gh answered "no PR for this branch" → definitive; anything else (offline, gh
    // missing) → unreachable, so a remembered PR isn't forgotten over a blip.
    return isNoPrError(error) ? { reachable: true, pr: null } : { reachable: false };
  }
}

/**
 * Push the worktree's branch and make sure it has a PR. A push is the update
 * path when a PR already exists; when none does, `gh pr create --fill` opens one
 * from the branch's commits. Never forces: a rejected push means the remote has
 * work this branch doesn't, and a PR flow must surface that, not bulldoze it.
 *
 * A PR can't target the default branch from itself, and the remote refuses a
 * direct push to it anyway — so when the worktree is sitting on the default
 * branch, cut a fresh feature branch first and open the PR from that.
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

  const base = await defaultBranch(cwd);
  const onDefault = base ? branch === base : branch === 'main' || branch === 'master';
  if (onDefault) {
    try {
      const name = await newBranchName(cwd);
      console.log('[cockpit] pr: on default branch, cutting feature branch', name);
      await execFileAsync('git', ['checkout', '-b', name], { cwd });
      branch = name;
    } catch (error) {
      return { ok: false, error: toolError(error) };
    }
  }

  try {
    console.log('[cockpit] pr: committing pending changes on', branch);
    await commitIfDirty(cwd);
  } catch (error) {
    return { ok: false, error: toolError(error) };
  }

  try {
    console.log('[cockpit] pr: pushing', branch);
    await execFileAsync('git', ['push', '--set-upstream', 'origin', branch], {
      cwd,
      timeout: STEP_TIMEOUT,
    });
  } catch (error) {
    return { ok: false, error: pushError(error) };
  }

  // The push already updated any open PR; report it rather than trying to create
  // a second one (which gh would refuse anyway).
  const existing = await prStatus(cwd);
  if (existing.reachable && existing.pr) return { ok: true, pr: existing.pr, created: false };

  try {
    // `--fill` (title/body from the commits) keeps this non-interactive, and an
    // explicit `--base` spares gh from having to prompt for the target branch.
    const createArgs = ['pr', 'create', '--fill', '--head', branch];
    if (base) createArgs.push('--base', base);
    console.log('[cockpit] pr: creating PR from', branch, base ? `into ${base}` : '');
    await execFileAsync('gh', createArgs, { cwd, timeout: STEP_TIMEOUT });
  } catch (error) {
    return { ok: false, error: toolError(error) };
  }

  const created = await prStatus(cwd);
  if (!created.reachable || !created.pr) {
    return { ok: false, error: 'PR created, but reading its number back failed.' };
  }
  return { ok: true, pr: created.pr, created: true };
}
