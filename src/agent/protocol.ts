export type Snippet = { lang: string; code: string };

export type EditOp =
  | { kind: 'insertAfter'; anchor: string; text: string; note?: string }
  | { kind: 'replaceLine'; anchor: string; text: string; note?: string }
  | { kind: 'append'; text: string; note?: string }
  | { kind: 'replaceString'; find: string; replace: string; note?: string }
  | { kind: 'setContent'; text: string; note?: string };

export type PlanItem = { text: string; snippet?: Snippet };

export type SampleFile = { path: string; language: string; content: string };

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'say'; text: string }
  | { type: 'plan'; title: string; items: PlanItem[] }
  | { type: 'edit_start'; file: string; language: string; original: string }
  | { type: 'edit_op'; op: EditOp }
  | { type: 'edit_end' }
  | { type: 'error'; message: string }
  | { type: 'done' };
