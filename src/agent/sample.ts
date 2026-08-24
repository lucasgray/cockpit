import type { SampleFile } from './protocol';

export const schemaCode = `const createIncidentSchema = z.object({
  employeeId: z.string().uuid(),
  type: z.enum(['infraction', 'commendation']),
  note: z.string().max(2000).optional(),
});`;

export const guardCode = `const parsed = createIncidentSchema.safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json({ error: parsed.error.flatten() });
}`;

export const sampleFile: SampleFile = {
  path: 'src/routes/incidents.ts',
  language: 'typescript',
  content: `import { Router } from 'express';
import { createIncident } from '../services/incidentService';

export const incidents = Router();

incidents.post('/', async (req, res) => {
  const incident = await createIncident(req.body);
  res.status(201).json(incident);
});
`,
};
