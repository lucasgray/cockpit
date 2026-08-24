import type { PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, TodoItem, TodoStatus } from '../src/agent/protocol';

// The Agent SDK is ESM-only, but this Electron main is bundled to CommonJS.
// A static import compiles to require() and throws ERR_REQUIRE_ESM, so load it
// through a native dynamic import() that esbuild won't rewrite to require().
type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');
const importEsm = new Function('m', 'return import(m)') as (m: string) => Promise<AgentSdk>;
let sdkPromise: Promise<AgentSdk> | null = null;
function loadSdk(): Promise<AgentSdk> {
  sdkPromise ??= importEsm('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function languageFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.json':
      return 'json';
    case '.css':
      return 'css';
    case '.scss':
      return 'scss';
    case '.html':
      return 'html';
    case '.md':
      return 'markdown';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.sql':
      return 'sql';
    case '.yml':
    case '.yaml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A one-line, human-readable gist of a tool call for the conversation feed. */
function summarizeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => {
    const s = String(p ?? '');
    if (!s) return '';
    return path.isAbsolute(s) ? path.relative(cwd, s) || path.basename(s) : s;
  };

  switch (name) {
    case 'Bash':
      return clip(String(input.command ?? ''));
    case 'Read':
      return rel(input.file_path);
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return rel(input.file_path);
    case 'Grep':
      return `${clip(String(input.pattern ?? ''), 60)}${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Glob':
      return String(input.pattern ?? '');
    case 'Task':
    case 'Agent':
      return clip(String(input.description ?? input.prompt ?? ''));
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return clip(String(input.query ?? ''));
    default: {
      const first = Object.values(input)[0];
      return typeof first === 'string' ? clip(first, 80) : '';
    }
  }
}

function parseTodos(input: Record<string, unknown>): TodoItem[] {
  const raw = Array.isArray(input.todos) ? input.todos : [];
  return raw.map((entry) => {
    const t = entry as { content?: string; activeForm?: string; status?: string };
    const status = t.status;
    return {
      text: String(t.content ?? t.activeForm ?? ''),
      status: (status === 'in_progress' || status === 'completed' ? status : 'pending') as TodoStatus,
    };
  });
}

/** Pull a short result line out of a tool_result content block. */
function resultDetail(content: unknown): string {
  if (typeof content === 'string') return clip(content, 100);
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type: 'text'; text: string } => {
        const block = b as { type?: string };
        return block.type === 'text';
      })
      .map((b) => b.text)
      .join(' ');
    return clip(text, 100);
  }
  return '';
}

async function renderEdit(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  send: (event: AgentEvent) => void,
) {
  const filePath = String(input.file_path ?? '');
  if (!filePath) return;

  const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  let original = '';
  try {
    original = await readFile(abs, 'utf8');
  } catch {
    original = '';
  }

  const rel = path.relative(cwd, abs) || path.basename(abs);
  send({ type: 'edit_start', file: rel, language: languageFor(abs), original });

  if (toolName === 'Write') {
    send({ type: 'edit_op', op: { kind: 'setContent', text: String(input.content ?? ''), note: 'Writing file' } });
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    for (const raw of edits) {
      const e = raw as { old_string?: string; new_string?: string };
      send({
        type: 'edit_op',
        op: { kind: 'replaceString', find: String(e.old_string ?? ''), replace: String(e.new_string ?? '') },
      });
    }
  } else {
    send({
      type: 'edit_op',
      op: { kind: 'replaceString', find: String(input.old_string ?? ''), replace: String(input.new_string ?? '') },
    });
  }

  send({ type: 'edit_end' });
}

/**
 * A live Claude session pinned to one worktree. The SDK query is opened once in
 * streaming-input mode and stays open, so every prompt after the first
 * continues the same conversation instead of cold-starting a new one.
 */
class Session {
  readonly cwd: string;
  private query: Query | null = null;
  private sink: ((event: AgentEvent) => void) | null = null;
  private turnDone: (() => void) | null = null;
  private inbox: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private pump: Promise<void> | null = null;
  private interrupted = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private emit(event: AgentEvent) {
    this.sink?.(event);
  }

  /** The AsyncIterable handed to query() — the session's input channel. */
  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.inbox.length) yield this.inbox.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    // Snapshot the file before the write lands so the diff has an "original".
    if (EDIT_TOOLS.has(toolName)) {
      await renderEdit(this.cwd, toolName, input, (e) => this.emit(e));
    }
    return { behavior: 'allow', updatedInput: input };
  };

  private async start() {
    const { query } = await loadSdk();
    this.query = query({
      prompt: this.input(),
      options: {
        cwd: this.cwd,
        permissionMode: 'default',
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool: this.canUseTool,
        maxTurns: 100,
      },
    });
    this.pump = this.drain(this.query).catch((error) => {
      this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.finishTurn();
    });
  }

  private finishTurn() {
    const done = this.turnDone;
    this.turnDone = null;
    done?.();
  }

  /** Translate the SDK message stream into cockpit events, forever. */
  private async drain(stream: Query) {
    for await (const msg of stream) {
      if (msg.type === 'stream_event') {
        const event = msg.event;
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') this.emit({ type: 'say', text: delta.text });
          else if (delta.type === 'thinking_delta') this.emit({ type: 'thinking', text: delta.thinking });
        }
        continue;
      }

      if (msg.type === 'assistant') {
        if (msg.error) this.emit({ type: 'error', message: `Claude: ${msg.error}` });
        const content = msg.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (block.name === 'TodoWrite') {
            this.emit({ type: 'todos', items: parseTodos(input) });
            continue;
          }
          this.emit({
            type: 'tool_start',
            id: block.id,
            name: block.name,
            summary: summarizeTool(block.name, input, this.cwd),
          });
        }
        continue;
      }

      if (msg.type === 'user') {
        const content = msg.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.emit({
            type: 'tool_end',
            id: block.tool_use_id,
            ok: !block.is_error,
            detail: resultDetail(block.content),
          });
        }
        continue;
      }

      if (msg.type === 'result') {
        if (msg.subtype !== 'success') {
          this.emit({ type: 'error', message: `Run ended: ${msg.subtype}` });
        }
        this.emit({
          type: 'done',
          cost: 'total_cost_usd' in msg ? msg.total_cost_usd : undefined,
          turns: 'num_turns' in msg ? msg.num_turns : undefined,
          interrupted: this.interrupted,
        });
        this.interrupted = false;
        this.finishTurn();
      }
    }
    // The transport closed on us — unblock any caller waiting on a turn.
    this.emit({ type: 'done' });
    this.finishTurn();
  }

  /** Send one prompt and resolve when that turn finishes. */
  async send(prompt: string, sink: (event: AgentEvent) => void): Promise<void> {
    this.sink = sink;
    if (!this.query) await this.start();

    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage);
    this.wake?.();
    this.wake = null;

    await new Promise<void>((resolve) => {
      this.turnDone = resolve;
    });
    this.sink = null;
  }

  async interrupt() {
    if (!this.query) return;
    this.interrupted = true;
    try {
      await this.query.interrupt();
    } catch {
      // Already settled, or the CLI is mid-teardown — the turn will end anyway.
    }
  }

  async close() {
    this.closed = true;
    this.wake?.();
    this.wake = null;
    try {
      await this.query?.close();
    } catch {
      // Best effort.
    }
    this.query = null;
    this.pump = null;
    this.finishTurn();
  }
}

const sessions = new Map<string, Session>();

function sessionFor(cwd: string): Session {
  let session = sessions.get(cwd);
  if (!session) {
    session = new Session(cwd);
    sessions.set(cwd, session);
  }
  return session;
}

export async function runAgent(
  req: { prompt: string; cwd: string },
  send: (event: AgentEvent) => void,
): Promise<void> {
  try {
    await sessionFor(req.cwd).send(req.prompt, send);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    send({ type: 'done' });
  }
}

export async function interruptAgent(cwd: string): Promise<void> {
  await sessions.get(cwd)?.interrupt();
}

/** Drop the conversation for a worktree; the next prompt starts cold. */
export async function resetAgent(cwd: string): Promise<void> {
  const session = sessions.get(cwd);
  if (!session) return;
  sessions.delete(cwd);
  await session.close();
}

export async function closeAllAgents(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.close()));
}
