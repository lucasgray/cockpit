import type { AgentEvent } from './protocol';
import type { AgentRunRequest } from '../bridge';

export function electronSource(req: AgentRunRequest): AsyncGenerator<AgentEvent> {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const push = (event: AgentEvent) => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  window
    .cockpit!.agent.run(req, push)
    .catch((err) => queue.push({ type: 'error', message: String(err) }))
    .finally(() => {
      finished = true;
      wake?.();
      wake = null;
    });

  return (async function* () {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
}
