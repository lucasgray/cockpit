import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '../src/agent/protocol';

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

export async function runAgent(
  req: { prompt: string; cwd: string },
  send: (event: AgentEvent) => void,
): Promise<void> {
  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (EDIT_TOOLS.has(toolName)) {
      await renderEdit(req.cwd, toolName, input, send);
    }
    return { behavior: 'allow', updatedInput: input };
  };

  try {
    const { query } = await loadSdk();
    const stream = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        permissionMode: 'default',
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool,
        maxTurns: 30,
      },
    });

    for await (const msg of stream) {
      if (msg.type === 'stream_event') {
        const event = msg.event;
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') send({ type: 'say', text: delta.text });
          else if (delta.type === 'thinking_delta') send({ type: 'thinking', text: delta.thinking });
        }
      } else if (msg.type === 'assistant' && msg.error) {
        send({ type: 'error', message: `Claude: ${msg.error}` });
      }
    }
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  send({ type: 'done' });
}
