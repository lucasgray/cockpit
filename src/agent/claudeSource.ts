import type { AgentEvent, SampleFile } from './protocol';

export async function requestAgent(prompt: string, file: SampleFile): Promise<Response> {
  return fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, file }),
  });
}

export async function* parseAgentStream(res: Response): AsyncGenerator<AgentEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.startsWith('data: ') ? frame.slice(6) : frame;
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as AgentEvent;
      } catch {
        // ignore malformed frame
      }
    }
  }
}
