import type {
  HookJSONOutput,
  HookInput,
  ModelInfo,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AgentEvent, OutboundImage, TodoItem, TodoStatus } from '../src/agent/protocol';
import { EFFORT_LEVELS, type EffortChoice, type ModelChoice, type PermissionMode } from '../src/settings';

/** The MCP tool the model uses to ask the operator a question (see start()). */
const ASK_TOOL = 'mcp__cockpit__ask';

/**
 * The built-in tool the model calls to leave plan mode. The cockpit hangs the
 * plan-approval gate off it (see canUseTool): its `plan` input is the markdown
 * the operator approves or rejects, and approving is what actually switches the
 * session out of plan mode into real work.
 */
const EXIT_PLAN_TOOL = 'ExitPlanMode';

/**
 * Thinking budget used when the operator drops a session into thinking mode.
 *
 * Only meaningful mid-session: `setMaxThinkingTokens` is the sole way to change
 * thinking on an already-open query, and on current models any non-zero value
 * just means "adaptive" — the number is a real budget only on older ones. A
 * fresh session gets `thinking: { type: 'adaptive' }` instead, and never sees it.
 */
const THINKING_BUDGET = 16_000;

// The Agent SDK is ESM-only, but this Electron main is bundled to CommonJS.
// A static import compiles to require() and throws ERR_REQUIRE_ESM, so load it
// through a native dynamic import() that esbuild won't rewrite to require().
type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');
const importEsm = new Function('m', 'return import(m)') as (m: string) => Promise<AgentSdk>;
let sdkPromise: Promise<AgentSdk> | null = null;
export function loadSdk(): Promise<AgentSdk> {
  sdkPromise ??= importEsm('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * How a turn is driven — the three composer controls, read from the store when
 * the turn starts. They travel together because they change together: each one
 * has both a spawn-time form and a mid-session control request, and which of the
 * two applies depends only on whether this worktree's query is already open.
 */
export type TurnConfig = {
  thinking: boolean;
  /** Model id, or '' for the CLI's default. */
  model: string;
  effort: EffortChoice;
  /**
   * The permission mode the turn runs under — the composer's ◈ Plan toggle
   * resolves to 'plan', anything else to the cockpit's own default. Read at turn
   * start like the other three, and pushed onto an open session mid-flight.
   */
  permissionMode: PermissionMode;
};

/**
 * What the installed Claude Code says it can reach, cached for the window's life.
 *
 * The list is a property of the CLI rather than of any one worktree, so the first
 * session to open fills it in for every switcher in the app. There is no way to
 * ask without a live query — hence a cache seeded off whichever session happens
 * to start first, and `FALLBACK_MODELS` in the renderer until one does.
 */
let catalog: ModelChoice[] | null = null;
let catalogPending: Promise<void> | null = null;

/**
 * Effort is only offered where the CLI says it is supported. A model that
 * reports nothing gets an empty list rather than the full set: sending `effort`
 * to a model that has none is an error, and a missing switcher is cheaper to
 * live with than a turn that won't start.
 */
function toChoice(model: ModelInfo): ModelChoice {
  const levels = model.supportedEffortLevels ?? (model.supportsEffort ? EFFORT_LEVELS : []);
  return {
    value: model.value,
    label: model.displayName || model.value,
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    ...(model.description ? { description: model.description } : {}),
    effortLevels: model.supportsEffort === false ? [] : levels,
  };
}

function fillCatalog(query: Query) {
  if (catalog || catalogPending) return;
  catalogPending = query
    .supportedModels()
    .then((models) => {
      if (models.length) catalog = models.map(toChoice);
    })
    .catch((error) => {
      // An older CLI without the control request, or one still coming up. The
      // switcher falls back to its built-in list; nothing about the turn changes.
      console.error('[cockpit] model list unavailable:', (error as Error).message);
    })
    .finally(() => {
      catalogPending = null;
    });
}

/** The model switcher's rows, or [] if no session has opened to ask yet. */
export async function modelCatalog(): Promise<ModelChoice[]> {
  if (catalogPending) await catalogPending;
  return catalog ?? [];
}

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

/** Cap a string for transport without flattening its newlines (unlike clip). */
function cap(text: string, max = 4000): string {
  const t = text.replace(/\s+$/, '');
  return t.length > max ? `${t.slice(0, max)}\n… (truncated)` : t;
}

/**
 * The full, newline-preserving tool input for the expandable row body — the raw
 * Bash command, or a readable dump of a structured tool's arguments. Read/edit
 * tools return '' because their work is shown elsewhere (the diff pane).
 */
function toolDetail(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return cap(String(input.command ?? ''));
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return '';
    default:
      return cap(JSON.stringify(input, null, 2));
  }
}

/** The tool's output for the expandable row body — full text, newlines intact. */
function resultDetail(content: unknown): string {
  if (typeof content === 'string') return cap(content);
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type: 'text'; text: string } => {
        const block = b as { type?: string };
        return block.type === 'text';
      })
      .map((b) => b.text)
      .join('\n');
    return cap(text);
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
  /**
   * Whether this session is in thinking mode — see the composer's ✳ Thinking
   * toggle. Off is not "no thinking": the model reasons either way, but Claude
   * Code's default display omits the blocks, so the cockpit receives empty
   * `thinking` deltas and shows a spinner. On asks for summarized thinking, and
   * the transcript grows a ✳ thinking bubble as the reasoning streams in.
   */
  private thinking = false;
  /**
   * The model and effort this session is running on — the composer's two
   * switchers. Both are '' until the operator pins one, which means "send
   * nothing" and leaves the CLI on its own defaults.
   */
  private model = '';
  private effort: EffortChoice = '';
  /**
   * The permission mode the session is running under — the composer's ◈ Plan
   * toggle. 'default' until the operator turns planning on; kept in sync so a
   * plan approved mid-turn (which switches the SDK to 'default') isn't undone by
   * the next turn re-sending 'plan'.
   */
  private permissionMode: PermissionMode = 'default';
  /** Open ask-tool calls, by question id, waiting for the operator's answer. */
  private pendingQuestions = new Map<string, (answer: string) => void>();
  /**
   * Open ExitPlanMode calls, by plan id, waiting for the operator to approve or
   * reject. Separate from questions because the answer resolves a *permission*
   * decision, not a tool result — see canUseTool.
   */
  private pendingPlans = new Map<string, (decision: string) => void>();

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
    if (toolName === EXIT_PLAN_TOOL) return this.reviewPlan(input);
    return { behavior: 'allow', updatedInput: input };
  };

  /**
   * The plan-approval gate. In plan mode the model does its read-only research
   * and then calls ExitPlanMode to propose a plan; that call lands here as a
   * permission decision. We surface the plan to the operator and block until they
   * answer — approving lets the turn continue *and* drops the session to 'default'
   * (via a session-scoped setMode) so the work actually runs, while rejecting
   * denies the call and leaves the session in plan mode to revise.
   */
  private async reviewPlan(input: Record<string, unknown>): Promise<PermissionResult> {
    const id = randomUUID();
    const text = String(input.plan ?? '').trim();
    this.emit({ type: 'plan', id, text });
    const decision = await new Promise<string>((resolve) => {
      this.pendingPlans.set(id, resolve);
    });
    if (decision === 'approve') {
      // Mirror the SDK-side switch locally so the next turn doesn't re-enter plan
      // mode; the renderer clears the composer toggle to match.
      this.permissionMode = 'default';
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
      };
    }
    return {
      behavior: 'deny',
      message:
        'The operator rejected this plan. Stay in plan mode and wait for their ' +
        'guidance on what to change before proposing a revised plan.',
    };
  }

  /**
   * Drives the diff view. This has to be a hook rather than part of canUseTool:
   * the permission callback is skipped entirely for anything already approved by
   * an allow rule or permission mode, so hanging the display off it meant the
   * diff silently never opened for users who allowlist Edit/Write. PreToolUse
   * fires for every call regardless of how permission resolves.
   *
   * It must also stay a *blocking* seam. renderEdit reads the file to get the
   * "before" side of the diff, so it has to win the race against the write —
   * watching the message stream instead would read whatever happened to be on
   * disk by then, and quietly show an empty diff.
   */
  private preToolUse = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (!EDIT_TOOLS.has(input.tool_name)) return {};
    try {
      await renderEdit(
        this.cwd,
        input.tool_name,
        (input.tool_input ?? {}) as Record<string, unknown>,
        (e) => this.emit(e),
      );
    } catch (error) {
      // Purely a display concern — never let it stand between Claude and an edit.
      console.error('[cockpit] diff render failed:', (error as Error).message);
    }
    return {};
  };

  /**
   * Resolve any open ask-tool question or plan-approval gate, so its turn
   * unblocks instead of hanging. Plans and questions share one id space and one
   * answer channel; the id says which map it belongs to.
   */
  answer(id: string, selection: string) {
    const plan = this.pendingPlans.get(id);
    if (plan) {
      this.pendingPlans.delete(id);
      plan(selection);
      return;
    }
    const resolve = this.pendingQuestions.get(id);
    if (!resolve) return;
    this.pendingQuestions.delete(id);
    resolve(selection);
  }

  /**
   * Unblock every open question and plan gate, so an interrupt/close never hangs
   * a turn. A dangling plan is resolved as a rejection — the safe default, since
   * approving would let work run that the operator never confirmed.
   */
  private dismissQuestions(text: string) {
    for (const resolve of this.pendingQuestions.values()) resolve(text);
    this.pendingQuestions.clear();
    for (const resolve of this.pendingPlans.values()) resolve('reject');
    this.pendingPlans.clear();
  }

  private async start() {
    console.log('[cockpit] starting new session for', this.cwd);
    const { query, tool, createSdkMcpServer } = await loadSdk();

    // The built-in AskUserQuestion can't be answered from an SDK host — it just
    // returns "the user did not answer". So we own the question tool: its handler
    // emits a `question` event to the renderer and blocks on the operator's real
    // answer, which comes back via answer() and becomes the tool result.
    const askTool = tool(
      'ask',
      "Ask the operator a multiple-choice question and wait for their answer. Use this whenever you need them to choose between options or decide before continuing. Returns the operator's selection.",
      {
        questions: z
          .array(
            z.object({
              question: z.string(),
              header: z.string(),
              multiSelect: z.boolean().optional(),
              options: z.array(z.object({ label: z.string(), description: z.string() })).min(2),
            }),
          )
          .min(1),
      },
      async (args) => {
        const id = randomUUID();
        const questions = args.questions.map((q) => ({
          question: q.question,
          header: q.header,
          multiSelect: q.multiSelect ?? false,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
        }));
        this.emit({ type: 'question', id, questions });
        const answer = await new Promise<string>((resolve) => {
          this.pendingQuestions.set(id, resolve);
        });
        return { content: [{ type: 'text' as const, text: answer }] };
      },
    );

    this.query = query({
      prompt: this.input(),
      options: {
        cwd: this.cwd,
        permissionMode: this.permissionMode,
        includePartialMessages: true,
        // All three are left unset when unpinned, so a plain session keeps the
        // CLI's own defaults rather than having the cockpit's opinion imposed.
        ...(this.thinking ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            'To ask the operator a question or have them choose between options, call the `ask` ' +
            'tool (mcp__cockpit__ask) and wait for its result — never the AskUserQuestion tool. ' +
            'It returns the operator’s selection.',
        },
        canUseTool: this.canUseTool,
        hooks: { PreToolUse: [{ hooks: [this.preToolUse], timeout: 10 }] },
        mcpServers: { cockpit: createSdkMcpServer({ name: 'cockpit', tools: [askTool] }) },
        disallowedTools: ['AskUserQuestion'],
        maxTurns: 100,
      },
    });
    // First session up fills the model switcher for the whole app.
    fillCatalog(this.query);
    this.pump = this.drain(this.query)
      .catch((error) => {
        this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        this.finishTurn();
      })
      .finally(() => {
        this.query = null;
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
        if (msg.error) {
          const content = msg.message?.content;
          const detail = Array.isArray(content)
            ? content
                .map((b) => (b.type === 'text' ? b.text : ''))
                .filter(Boolean)
                .join(' ')
            : '';
          this.emit({ type: 'error', message: detail || `Claude: ${msg.error}` });
        }
        const content = msg.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (block.name === 'TodoWrite') {
            this.emit({ type: 'todos', items: parseTodos(input) });
            continue;
          }
          // The ask tool is drawn as an interactive question, not a tool row.
          if (block.name === ASK_TOOL) continue;
          this.emit({
            type: 'tool_start',
            id: block.id,
            name: block.name,
            summary: summarizeTool(block.name, input, this.cwd),
            detail: toolDetail(block.name, input),
            // Non-null when this tool ran inside a subagent; the SDK forwards a
            // subagent's tool calls by default, which is the heartbeat the
            // cockpit counts under the subagent's own row.
            parent: msg.parent_tool_use_id ?? undefined,
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
        console.log('[cockpit] result:', JSON.stringify({ subtype: msg.subtype, cwd: this.cwd }));
        if (msg.subtype !== 'success') {
          this.emit({ type: 'error', message: `Run ended: ${msg.subtype}` });
        }
        this.emit({ type: 'done', interrupted: this.interrupted });
        this.interrupted = false;
        this.finishTurn();
      }
    }
    // The transport closed on us — unblock any caller waiting on a turn.
    this.emit({ type: 'done' });
    this.finishTurn();
  }

  /**
   * Push thinking mode onto a query that is already open. `setMaxThinkingTokens`
   * is deprecated in favour of the `thinking` option, but that option is read
   * once at spawn, and these sessions are long-lived by design — this control
   * request is the only seam that reaches one mid-flight. Passing `null` clears
   * both the budget and the display override, which is exactly "back to normal".
   */
  private async applyThinking() {
    if (!this.query) return;
    try {
      await this.query.setMaxThinkingTokens(
        this.thinking ? THINKING_BUDGET : null,
        this.thinking ? 'summarized' : null,
      );
    } catch (error) {
      // How the turn is displayed — never worth failing the prompt behind it.
      console.error('[cockpit] thinking toggle failed:', (error as Error).message);
    }
  }

  /**
   * Push the composer's model and effort onto a query that is already open.
   *
   * Same shape as applyThinking, and open for the same reason: both are spawn
   * options, and these sessions outlive any one turn by design. Effort goes
   * through the flag-settings layer rather than a setter of its own — that layer
   * sits above the user's settings files and below managed policy, which is
   * exactly where a switcher in this app belongs. Passing `null` clears it back
   * to whatever those lower layers say.
   */
  private async applyModel() {
    if (!this.query) return;
    try {
      await this.query.setModel(this.model || undefined);
    } catch (error) {
      // The turn is about to run either way — on the old model, which is the
      // safe half of this failure. Say so rather than failing the prompt.
      this.emit({ type: 'error', message: `Could not switch model: ${(error as Error).message}` });
    }
  }

  private async applyEffort() {
    if (!this.query) return;
    try {
      await this.query.applyFlagSettings({ effortLevel: this.effort || null });
    } catch (error) {
      this.emit({ type: 'error', message: `Could not set effort: ${(error as Error).message}` });
    }
  }

  /**
   * Push the composer's ◈ Plan toggle onto a query that is already open. Same
   * spawn-vs-setter split as the others: a fresh query takes permissionMode as a
   * spawn option, an open one is told through setPermissionMode. Approving a plan
   * mid-turn also flips this to 'default', so the toggle and the SDK never drift.
   */
  private async applyPermissionMode() {
    if (!this.query) return;
    try {
      await this.query.setPermissionMode(this.permissionMode);
    } catch (error) {
      this.emit({ type: 'error', message: `Could not change permission mode: ${(error as Error).message}` });
    }
  }

  /**
   * Send one prompt and resolve when that turn finishes. The three switchers ride
   * along on every prompt rather than on channels of their own: the operator can
   * flip any of them with no session open, or mid-turn, and either way the value
   * that matters is the one in force when the next turn starts.
   *
   * `images` are the screenshots pasted into the composer, already base64. A turn
   * with none sends a plain string, exactly as before; a turn with some sends
   * content blocks, the images ahead of the text they were pasted to be asked
   * about — and the text may be empty, since a screenshot on its own is a prompt.
   */
  async send(
    prompt: string,
    images: OutboundImage[],
    config: TurnConfig,
    sink: (event: AgentEvent) => void,
  ): Promise<void> {
    this.sink = sink;
    const changed = {
      thinking: config.thinking !== this.thinking,
      model: config.model !== this.model,
      effort: config.effort !== this.effort,
      permissionMode: config.permissionMode !== this.permissionMode,
    };
    this.thinking = config.thinking;
    this.model = config.model;
    this.effort = config.effort;
    this.permissionMode = config.permissionMode;
    // A fresh query takes all four as spawn options; an open one has to be told.
    if (!this.query) {
      await this.start();
    } else {
      if (changed.thinking) await this.applyThinking();
      if (changed.model) await this.applyModel();
      if (changed.effort) await this.applyEffort();
      if (changed.permissionMode) await this.applyPermissionMode();
    }

    const content = images.length
      ? [
          ...images.map((image) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
          })),
          ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
        ]
      : prompt;

    this.inbox.push({
      type: 'user',
      message: { role: 'user', content },
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
    this.dismissQuestions('The operator interrupted before answering.');
    try {
      await this.query.interrupt();
    } catch {
      // Already settled, or the CLI is mid-teardown — the turn will end anyway.
    }
  }

  async close() {
    this.closed = true;
    this.dismissQuestions('Session closed.');
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
  req: { prompt: string; cwd: string; images?: OutboundImage[] } & TurnConfig,
  send: (event: AgentEvent) => void,
): Promise<void> {
  try {
    await sessionFor(req.cwd).send(req.prompt, req.images ?? [], req, send);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    send({ type: 'done' });
  }
}

export async function interruptAgent(cwd: string): Promise<void> {
  await sessions.get(cwd)?.interrupt();
}

/** Feed the operator's answer back to a waiting ask-tool call. */
export function answerAgent(cwd: string, id: string, selection: string): void {
  sessions.get(cwd)?.answer(id, selection);
}

/** Tear down a worktree's session — used when the worktree itself goes away. */
export async function closeAgent(cwd: string): Promise<void> {
  const session = sessions.get(cwd);
  if (!session) return;
  sessions.delete(cwd);
  await session.close();
}

/**
 * Full reset: tear down the session and wipe the SDK's conversation transcripts
 * for this cwd, so the next session starts with a clean context window.
 */
export async function resetAgent(cwd: string): Promise<void> {
  await closeAgent(cwd);
  const encoded = cwd.replace(/\//g, '-');
  const dir = path.join(homedir(), '.claude', 'projects', encoded);
  try {
    const files = await readdir(dir);
    await Promise.all(
      files
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => unlink(path.join(dir, f))),
    );
  } catch {
    // Directory may not exist yet — nothing to clean.
  }
}

export async function closeAllAgents(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.close()));
}
