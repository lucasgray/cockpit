import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentEvent, EditOp, SampleFile } from './protocol';

const SYSTEM = `You are a coding agent working inside an editor. You edit exactly ONE file.
First think briefly. Then write one or two sentences to the user explaining the change.
Then call edit_file with a list of anchored ops.
Rules:
- Anchor each op to a short, unique substring that already appears in the file.
- Include correct indentation in every op's text.
- Keep the change minimal and focused on the request.
- Give each op a one-sentence note explaining why (it is pinned next to the edit).
Do not print the whole file back.`;

const EDIT_TOOL: Anthropic.Tool = {
  name: 'edit_file',
  description: 'Apply a sequence of edits to the open file.',
  input_schema: {
    type: 'object',
    properties: {
      ops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['insertAfter', 'replaceLine', 'append'] },
            anchor: { type: 'string', description: 'Unique substring of the target line. Omit for append.' },
            text: { type: 'string', description: 'Code to insert or replace, with correct indentation.' },
            note: { type: 'string', description: 'One-sentence rationale, pinned next to this edit.' },
          },
          required: ['kind', 'text'],
        },
      },
    },
    required: ['ops'],
  },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function anthropicAgentPlugin(): Plugin {
  return {
    name: 'anthropic-agent',
    configureServer(server) {
      server.middlewares.use('/api/agent', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }
        if (!process.env.ANTHROPIC_API_KEY) {
          res.statusCode = 501;
          res.end('ANTHROPIC_API_KEY not set — client falls back to the mock stream.');
          return;
        }

        const { prompt, file } = JSON.parse(await readBody(req)) as {
          prompt: string;
          file: SampleFile;
        };

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const send = (event: AgentEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

        try {
          const client = new Anthropic();
          const userContent = `File: ${file.path}\n\n\`\`\`${file.language}\n${file.content}\`\`\`\n\nRequest: ${prompt}`;

          send({ type: 'edit_start', file: file.path, language: file.language, original: file.content });

          const params = {
            model: 'claude-opus-5',
            max_tokens: 8000,
            system: SYSTEM,
            tools: [EDIT_TOOL],
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: 'medium' },
            messages: [{ role: 'user', content: userContent }],
          } satisfies Record<string, unknown>;

          const stream = client.messages.stream(
            params as unknown as Parameters<typeof client.messages.stream>[0],
          );

          let blockType = '';
          let toolJson = '';

          for await (const event of stream) {
            if (event.type === 'content_block_start') {
              blockType = event.content_block.type;
              if (blockType === 'tool_use') toolJson = '';
            } else if (event.type === 'content_block_delta') {
              const delta = event.delta;
              if (delta.type === 'thinking_delta') send({ type: 'thinking', text: delta.thinking });
              else if (delta.type === 'text_delta') send({ type: 'say', text: delta.text });
              else if (delta.type === 'input_json_delta') toolJson += delta.partial_json;
            } else if (event.type === 'content_block_stop') {
              if (blockType === 'tool_use' && toolJson.trim()) {
                try {
                  const parsed = JSON.parse(toolJson) as { ops?: EditOp[] };
                  for (const op of parsed.ops ?? []) {
                    send({ type: 'edit_op', op });
                  }
                } catch {
                  // partial tool json — skip
                }
              }
              blockType = '';
            }
          }

          send({ type: 'edit_end' });
          send({ type: 'done' });
        } catch (error) {
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        res.end();
      });
    },
  };
}
