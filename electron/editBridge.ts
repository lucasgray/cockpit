import http from 'node:http';

/** The slice of a Claude Code PreToolUse hook payload the cockpit cares about. */
export type HookEdit = {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

const PORT = Number(process.env.COCKPIT_EDIT_PORT || 5274);
const MAX_BODY = 4 * 1024 * 1024;

/**
 * Listens for edits made *outside* the app. A Claude Code session in the
 * terminal POSTs each Edit/Write here from a PreToolUse hook — before the write
 * lands, so the diff can still read the file as it was and type the change in.
 *
 * The hook sits in the critical path of someone's edit, so this answers first
 * and parses after: a slow or fussy listener must never stall the editor.
 */
export function startEditBridge(onEdit: (edit: HookEdit) => void): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      res.writeHead(204).end();
      try {
        onEdit(JSON.parse(body) as HookEdit);
      } catch {
        // Not a hook payload — nothing to show.
      }
    });
  });

  server.on('error', (error) => {
    // A stale instance still holding the port, most likely. Log and carry on:
    // losing the mirror shouldn't take the app down with it.
    console.error('[cockpit] edit bridge unavailable:', (error as Error).message);
  });

  server.listen(PORT, '127.0.0.1');
  return server;
}
