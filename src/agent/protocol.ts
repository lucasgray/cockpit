/** The image types the Messages API takes. A paste of anything else is refused. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** One pasted screenshot on its way to Claude. Base64, with no `data:` prefix. */
export type OutboundImage = { mediaType: ImageMediaType; data: string };

/**
 * A screenshot as the transcript draws it, in the two forms one can be in.
 *
 * `inline` is the live turn: the renderer already holds the bytes it just pasted,
 * so the bubble draws from them directly. `stored` is history: the main process
 * wrote the image to a file beside its database and the event names it, because a
 * megabyte of base64 per screenshot in the transcript would be read back in full
 * every time the worktree is opened. See electron/images.ts.
 */
export type TranscriptImage =
  | { kind: 'inline'; mediaType: ImageMediaType; dataUrl: string }
  | { kind: 'stored'; mediaType: ImageMediaType; file: string };

export type EditOp =
  | { kind: 'insertAfter'; anchor: string; text: string; note?: string }
  | { kind: 'replaceLine'; anchor: string; text: string; note?: string }
  | { kind: 'append'; text: string; note?: string }
  | { kind: 'replaceString'; find: string; replace: string; note?: string }
  | { kind: 'setContent'; text: string; note?: string };

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = { text: string; status: TodoStatus };

export type QuestionOption = { label: string; description: string };

/** One multiple-choice question the agent is asking the operator. */
export type QuestionSpec = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
};

export type AgentEvent =
  // `text` may be empty when the operator sent nothing but screenshots.
  | { type: 'user'; text: string; images?: TranscriptImage[] }
  | { type: 'thinking'; text: string }
  | { type: 'say'; text: string }
  // The agent's plan, awaiting the operator's approval. Like `question`, the turn
  // blocks in the SDK — the ExitPlanMode call can't resolve until the decision
  // goes back through window.cockpit.agent.answer(cwd, id, 'approve' | 'reject').
  | { type: 'plan'; id: string; text: string }
  // `parent` is the tool_use id of the subagent this call ran inside, when it
  // ran inside one — the cockpit folds those into that subagent's row rather
  // than scattering them across the transcript.
  | { type: 'tool_start'; id: string; name: string; summary: string; detail?: string; parent?: string }
  | { type: 'tool_end'; id: string; ok: boolean; detail?: string }
  | { type: 'todos'; items: TodoItem[] }
  // The agent is asking the operator to choose. The turn blocks in the SDK until
  // the answer goes back through window.cockpit.agent.answer(cwd, id, …).
  | { type: 'question'; id: string; questions: QuestionSpec[] }
  | { type: 'edit_start'; file: string; language: string; original: string }
  | { type: 'edit_op'; op: EditOp }
  | { type: 'edit_end' }
  | { type: 'error'; message: string }
  // Terminates one turn. In a live session the transport stays open and the
  // next prompt continues the same conversation.
  | { type: 'done'; interrupted?: boolean };
