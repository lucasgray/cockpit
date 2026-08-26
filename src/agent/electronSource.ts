import type { AgentEvent } from './protocol';
import type { AgentRunRequest } from '../bridge';
import type { PastedImage } from '../images';

/** One turn as the composer has it: the prompt, plus whatever was pasted into it. */
export type TurnRequest = {
  prompt: string;
  cwd: string;
  images?: PastedImage[];
};

export function electronSource(req: TurnRequest): AsyncGenerator<AgentEvent> {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const push = (event: AgentEvent) => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  const images = req.images ?? [];
  // Only the bytes cross to the main process; the data URL behind the thumbnail
  // is already here and would double the payload for nothing.
  const outbound: AgentRunRequest = {
    prompt: req.prompt,
    cwd: req.cwd,
    ...(images.length
      ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) }
      : {}),
  };

  window
    .cockpit!.agent.run(outbound, push)
    .catch((err) => queue.push({ type: 'error', message: String(err) }))
    .finally(() => {
      finished = true;
      wake?.();
      wake = null;
    });

  return (async function* () {
    // Echo the prompt so the transcript reads as a conversation. The screenshots
    // are echoed inline — the renderer is holding them, and the file the main
    // process is writing them to may not exist yet.
    yield {
      type: 'user',
      text: req.prompt,
      ...(images.length
        ? {
            images: images.map(({ mediaType, dataUrl }) => ({
              kind: 'inline' as const,
              mediaType,
              dataUrl,
            })),
          }
        : {}),
    } as AgentEvent;
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
}
