export type Snippet = { lang: string; code: string };

export type EditOp =
  | { kind: 'insertAfter'; anchor: string; text: string; note?: string }
  | { kind: 'replaceLine'; anchor: string; text: string; note?: string }
  | { kind: 'append'; text: string; note?: string }
  | { kind: 'replaceString'; find: string; replace: string; note?: string }
  | { kind: 'setContent'; text: string; note?: string };

export type PlanItem = { text: string; snippet?: Snippet };

export type SampleFile = { path: string; language: string; content: string };

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
  | { type: 'user'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'say'; text: string }
  | { type: 'plan'; title: string; items: PlanItem[] }
  | { type: 'tool_start'; id: string; name: string; summary: string; detail?: string }
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
