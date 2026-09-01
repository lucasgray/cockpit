import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PrInfo, PrResult } from '../src/bridge';
import { loadSdk } from './agentRunner';

const execFileAsync = promisify(execFile);

/** Diff sent to the commit-message model — plenty for context, cheap to send. */
const DIFF_BUDGET = 20_000;

/**
 * Ceiling for the commit-message SDK call. Unlike a git/gh child this isn't a
 * subprocess we can hand `timeout` to — it's an async iterator that simply never
 * yields a `result` if the model or transport stalls, and a `for await` on it
 * would hang with nothing to reject the `.catch()` fallback. So we bound it here
 * and abort, letting the flow fall back to a generated message instead of the UI
 * spinning on "Opening PR…" forever.
 */
const COMMIT_MSG_TIMEOUT_MS = 60_000;

/**
 * Ceiling for a single git/gh child. A push or a `gh` API call can be slow, but
 * none of these legitimately take minutes — a stuck one means a prompt we can't
 * answer or a dead connection, and the flow must fail loudly rather than leave
 * the UI spinning on "Opening PR…" forever.
 */
const CMD_TIMEOUT_MS = 90_000;

/** Permissions that let an account push a branch — i.e. open a same-repo PR. */
const CAN_PUSH = /^(WRITE|MAINTAIN|ADMIN)$/;

/**
 * Environment for a `gh` child. `GH_PROMPT_DISABLED` is the load-bearing part:
 * the app spawns `gh` with no TTY, so if gh ever drops into an interactive survey
 * — most notably its "create a fork?" prompt when the active account lacks push —
 * it would block on stdin that never answers and hang the whole PR flow. Disabling
 * prompts turns that into an immediate error the UI can show. An optional token
 * overrides the identity for this one process (see {@link ghPushToken}).
 */
function ghEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
  if (token) env.GH_TOKEN = token;
  return env;
}

/** The branch a worktree currently has checked out, or '' on a detached HEAD. */
async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    timeout: CMD_TIMEOUT_MS,
  });
  const branch = stdout.trim();
  return branch === 'HEAD' ? '' : branch;
}

/** stderr carries the useful failure; fall back to the argv-wrapping message. */
function toolError(error: unknown): string {
  // A timed-out child was killed by us, not by the tool — say so, since its own
  // output (if any) won't explain the silence. See CMD_TIMEOUT_MS.
  const killed = (error as { killed?: boolean }).killed;
  const signal = (error as { signal?: string }).signal;
  const message = error instanceof Error ? error.message : '';
  if (killed && signal && !/maxBuffer/i.test(message)) {
    return 'Command timed out — it was likely waiting on a prompt that can’t be answered here.';
  }
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message.trim() : String(error);
}

/** The gh accounts logged in for this host, as gh prints them in `auth status`. */
async function ghAccounts(cwd: string): Promise<string[]> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], {
      cwd,
      env: ghEnv(),
      timeout: CMD_TIMEOUT_MS,
    });
    const seen = new Set<string>();
    for (const m of `${stdout}\n${stderr}`.matchAll(/account (\S+)/g)) seen.add(m[1]);
    return [...seen];
  } catch {
    return [];
  }
}

/**
 * A gh token whose account can push to the repo at `cwd`, or undefined to run gh
 * as-is. gh authenticates as whatever account is *active* in its own config, which
 * needn't be the one that can push here: a work login can be active while the repo
 * is personal, and then a same-repo `gh pr create` has no push access and stalls on
 * the fork prompt. `git push` sidesteps this — it rides the SSH key, a separate
 * identity — so the two can disagree about who you are. We reconcile them for gh:
 * if the active account already has push, run as-is (the common case, no override);
 * otherwise find a logged-in account that does and hand gh *its* token for this one
 * process via GH_TOKEN, never touching gh's global active account. Returns undefined
 * when none qualify, so gh runs and reports its own error rather than us guessing.
 */
async function ghPushToken(cwd: string): Promise<string | undefined> {
  const viewerPermission = async (token?: string): Promise<string> => {
    const { stdout } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'viewerPermission', '--jq', '.viewerPermission'],
      { cwd, env: ghEnv(token), timeout: CMD_TIMEOUT_MS },
    );
    return stdout.trim();
  };

  try {
    if (CAN_PUSH.test(await viewerPermission())) return undefined;
  } catch {
    // The active account can't even read the repo (or gh choked) — fall through
    // and see whether some other logged-in account can push.
  }

  for (const account of await ghAccounts(cwd)) {
    let token = '';
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token', '--user', account], {
        env: ghEnv(),
        timeout: CMD_TIMEOUT_MS,
      });
      token = stdout.trim();
    } catch {
      continue;
    }
    if (!token) continue;
    try {
      if (CAN_PUSH.test(await viewerPermission(token))) return token;
    } catch {
      // This account can't see the repo either — try the next.
    }
  }
  return undefined;
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
 * A one-line-subject (+ optional body) commit message written from the staged
 * diff. Runs the SDK with no tools and one turn — a plain text completion, not
 * an agent session — so it costs a single cheap call rather than spinning up a
 * full Claude Code turn.
 */
async function generateCommitMessage(diff: string): Promise<string> {
  const trimmed = diff.length > DIFF_BUDGET ? `${diff.slice(0, DIFF_BUDGET)}\n… (truncated)` : diff;
  if (!trimmed.trim()) throw new Error('empty diff');

  const { query } = await loadSdk();
  const prompt =
    'Write a git commit message for the diff below. One short imperative subject line ' +
    '(under 72 characters), and only if it genuinely helps, a blank line followed by 1-3 ' +
    'sentences on why the change was made. Plain text only: no markdown, no backticks, no ' +
    'surrounding quotes, no "Co-Authored-By" line. Reply with nothing but the commit message.\n\n' +
    trimmed;

  // A stalled model never yields `result`, so bound the stream with an abort
  // controller: on timeout we abort the query (which ends the iterator) and throw,
  // handing off to the fallback message rather than hanging the PR flow.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), COMMIT_MSG_TIMEOUT_MS);
  let text = '';
  try {
    for await (const msg of query({
      prompt,
      options: { tools: [], maxTurns: 1, model: 'haiku', abortController: abort },
    })) {
      if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) if (block.type === 'text') text += block.text;
        }
      }
      if (msg.type === 'result') break;
    }
  } finally {
    clearTimeout(timer);
  }
  if (abort.signal.aborted) throw new Error('commit message timed out');

  const cleaned = text.trim();
  if (!cleaned) throw new Error('empty commit message');
  return cleaned;
}

/**
 * Commit whatever the worktree is holding before a PR flow pushes it — the app
 * never commits on its own initiative, but a PR with no commits is just an
 * error `gh` can't recover from, so "open a PR" has to mean "commit and open a
 * PR" once the operator has actually asked for one. Returns whether anything
 * was committed, purely for logging; the caller doesn't branch on it.
 */
async function commitIfDirty(cwd: string): Promise<boolean> {
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd,
    timeout: CMD_TIMEOUT_MS,
  });
  if (!status.trim()) return false;

  await execFileAsync('git', ['add', '-A'], { cwd, timeout: CMD_TIMEOUT_MS });
  const { stdout: diff } = await execFileAsync('git', ['diff', '--cached'], {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    timeout: CMD_TIMEOUT_MS,
  });
  const message = await generateCommitMessage(diff).catch(() => fallbackCommitMessage(cwd));
  await execFileAsync('git', ['commit', '-m', message], { cwd, timeout: CMD_TIMEOUT_MS });
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
export async function prStatus(cwd: string, token?: string): Promise<PrLookup> {
  const branch = await currentBranch(cwd).catch(() => '');
  // A git failure or detached HEAD isn't gh saying "no PR" — leave any remembered
  // PR standing rather than clobber it on a transient hiccup.
  if (!branch) return { reachable: false };
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', branch, '--json', 'number,url,state'],
      { cwd, env: ghEnv(token), timeout: CMD_TIMEOUT_MS },
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
    await commitIfDirty(cwd);
  } catch (error) {
    return { ok: false, error: toolError(error) };
  }

  try {
    await execFileAsync('git', ['push', '--set-upstream', 'origin', branch], {
      cwd,
      timeout: CMD_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, error: pushError(error) };
  }

  // gh authenticates as its active account, which may not be the one that can push
  // here; resolve the account that can, so `gh pr create` opens a same-repo PR
  // instead of stalling on a fork prompt it can't answer. Undefined => run gh as-is.
  const token = await ghPushToken(cwd);

  // The push already updated any open PR; report it rather than trying to create
  // a second one (which gh would refuse anyway).
  const existing = await prStatus(cwd, token);
  if (existing.reachable && existing.pr) return { ok: true, pr: existing.pr, created: false };

  try {
    await execFileAsync('gh', ['pr', 'create', '--fill', '--head', branch], {
      cwd,
      env: ghEnv(token),
      timeout: CMD_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, error: toolError(error) };
  }

  const created = await prStatus(cwd, token);
  if (!created.reachable || !created.pr) {
    return { ok: false, error: 'PR created, but reading its number back failed.' };
  }
  return { ok: true, pr: created.pr, created: true };
}
