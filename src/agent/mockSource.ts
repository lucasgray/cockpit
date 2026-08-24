import type { AgentEvent } from './protocol';
import { guardCode, sampleFile, schemaCode } from './sample';

const sleep = (ms: number) =>
  document.hidden ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

function* chunks(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

async function* stream(
  type: 'thinking' | 'say',
  text: string,
): AsyncGenerator<AgentEvent> {
  for (const c of chunks(text, 2)) {
    yield { type, text: c };
    await sleep(9);
  }
}

export async function* mockSource(): AsyncGenerator<AgentEvent> {
  yield* stream(
    'thinking',
    'The POST /incidents handler passes req.body straight into the service — no validation. A malformed employeeId or bad type would sail through and 500 at the DB. Better to validate at the boundary.',
  );

  yield {
    type: 'plan',
    title: 'Add request validation',
    items: [
      { text: 'Import zod', snippet: { lang: 'typescript', code: `import { z } from 'zod';` } },
      { text: 'Define a schema mirroring the API contract', snippet: { lang: 'typescript', code: schemaCode } },
      { text: 'Parse req.body and 400 on failure before calling the service', snippet: { lang: 'typescript', code: guardCode } },
    ],
  };
  await sleep(200);

  yield* stream(
    'say',
    'This route trusts req.body completely. I’ll add a zod schema and reject bad input with a 400 before it ever reaches the service.',
  );

  yield {
    type: 'edit_start',
    file: sampleFile.path,
    language: sampleFile.language,
    original: sampleFile.content,
  };

  yield {
    type: 'edit_op',
    op: { kind: 'insertAfter', anchor: 'import { createIncident }', text: `import { z } from 'zod';` },
  };
  yield {
    type: 'edit_op',
    op: {
      kind: 'insertAfter',
      anchor: 'export const incidents = Router();',
      text: `\n${schemaCode}`,
      note: 'Schema mirrors the API contract — uuid, enum, optional note.',
    },
  };
  yield {
    type: 'edit_op',
    op: {
      kind: 'replaceLine',
      anchor: 'const incident = await createIncident(req.body);',
      text: `  const parsed = createIncidentSchema.safeParse(req.body);\n  if (!parsed.success) {\n    return res.status(400).json({ error: parsed.error.flatten() });\n  }\n  const incident = await createIncident(parsed.data);`,
      note: 'Reject malformed input with a 400 before the service ever runs.',
    },
  };

  yield { type: 'edit_end' };

  yield* stream(
    'say',
    'Done. req.body is validated up front, malformed requests get a 400 with field-level errors, and the service only ever sees well-formed data.',
  );

  yield { type: 'done' };
}
