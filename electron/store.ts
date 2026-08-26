import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { AgentEvent } from '../src/agent/protocol';
import { DEFAULT_SETTINGS, normalizeSettings, type CockpitSettings } from '../src/settings';

/**
 * Everything the cockpit remembers, in one SQLite file under the app's own
 * userData directory. Nothing is written into the repo being worked on, and
 * nothing is read from the operator's home config — the app owns its state.
 *
 * Transcripts are stored as the `AgentEvent` stream rather than rendered HTML,
 * so history survives any change to how the UI draws a turn.
 */

/** Newest events kept per worktree. Older ones are pruned as new turns land. */
const TRANSCRIPT_LIMIT = 4_000;
/** Inserts between prune sweeps — pruning on every append would be wasteful. */
const PRUNE_INTERVAL = 250;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    cwd        TEXT PRIMARY KEY,
    session_id TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worktree_ports (
    cwd  TEXT    PRIMARY KEY,
    port INTEGER NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS events (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    cwd   TEXT    NOT NULL,
    ts    INTEGER NOT NULL,
    type  TEXT    NOT NULL,
    event TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_cwd ON events (cwd, id);
`;

/**
 * Trim an event down to what a replayed transcript actually needs.
 *
 * `edit_start` carries the file's entire prior contents so the live diff has an
 * "original" to type against — megabytes over a long session, and useless once
 * the turn is over, since the diff pane is live-only state. Keep the event (it
 * breaks the transcript bubble in the right place) and drop the payload; drop
 * the per-keystroke edit ops entirely.
 */
function forStorage(event: AgentEvent): AgentEvent | null {
  if (event.type === 'edit_op' || event.type === 'edit_end') return null;
  if (event.type === 'edit_start') return { ...event, original: '' };
  return event;
}

/** Deltas that arrive token-by-token and are worth merging into one row. */
function isDelta(event: AgentEvent): event is Extract<AgentEvent, { type: 'thinking' | 'say' }> {
  return event.type === 'thinking' || event.type === 'say';
}

export class Store {
  private db: DatabaseSync;
  private sincefPrune = 0;

  constructor(dir: string) {
    this.db = new DatabaseSync(path.join(dir, 'cockpit.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // Already closed, or mid-teardown — nothing left worth reporting.
    }
  }

  // ---- key/value ---------------------------------------------------------

  private readMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ---- settings ----------------------------------------------------------

  settings(): CockpitSettings {
    const raw = this.readMeta('settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      return normalizeSettings(JSON.parse(raw));
    } catch {
      // Corrupt row — fall back to defaults rather than refusing to start.
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(patch: Partial<CockpitSettings>): CockpitSettings {
    const next = normalizeSettings({ ...this.settings(), ...patch });
    this.writeMeta('settings', JSON.stringify(next));
    return next;
  }

  // ---- small UI state ----------------------------------------------------

  selectedWorktree(): string | null {
    return this.readMeta('selectedWorktree');
  }

  setSelectedWorktree(cwd: string | null) {
    if (cwd === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run('selectedWorktree');
    else this.writeMeta('selectedWorktree', cwd);
  }

  railView(): string | null {
    return this.readMeta('railView');
  }

  setRailView(view: string) {
    this.writeMeta('railView', view);
  }

  /**
   * The file open in each worktree's editor pane. One row rather than a table:
   * it's a handful of paths, rewritten on every click, and worth exactly as much
   * as the selected-worktree pointer beside it.
   */
  private openFiles(): Record<string, string> {
    const raw = this.readMeta('openFiles');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  openFile(cwd: string): string | null {
    return this.openFiles()[cwd] ?? null;
  }

  setOpenFile(cwd: string, file: string | null) {
    const files = this.openFiles();
    if (file === null) delete files[cwd];
    else files[cwd] = file;
    this.writeMeta('openFiles', JSON.stringify(files));
  }

  /**
   * Which worktrees are in thinking mode. Per-worktree for the same reason
   * sessions are: the composer speaks for the selected worktree, so dropping one
   * into thinking mode leaves its siblings running as they were. Stored as a set
   * of paths — absent means off, which is the default.
   */
  private thinkingCwds(): string[] {
    const raw = this.readMeta('thinking');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
    } catch {
      return [];
    }
  }

  thinking(cwd: string): boolean {
    return this.thinkingCwds().includes(cwd);
  }

  setThinking(cwd: string, on: boolean) {
    const cwds = new Set(this.thinkingCwds());
    if (on) cwds.add(cwd);
    else cwds.delete(cwd);
    this.writeMeta('thinking', JSON.stringify([...cwds]));
  }

  // ---- worktree ports ----------------------------------------------------

  /**
   * A worktree's dev-server port is sticky: assigned once and remembered, so a
   * URL you bookmarked keeps pointing at the same branch across restarts.
   */
  port(cwd: string): number | null {
    const row = this.db.prepare('SELECT port FROM worktree_ports WHERE cwd = ?').get(cwd) as
      | { port: number }
      | undefined;
    return row?.port ?? null;
  }

  setPort(cwd: string, port: number) {
    this.db
      .prepare(
        `INSERT INTO worktree_ports (cwd, port) VALUES (?, ?)
         ON CONFLICT(cwd) DO UPDATE SET port = excluded.port`,
      )
      .run(cwd, port);
  }

  /** Every port already handed out — what a new assignment has to avoid. */
  assignedPorts(): number[] {
    const rows = this.db.prepare('SELECT port FROM worktree_ports').all() as { port: number }[];
    return rows.map((row) => row.port);
  }

  /** Called when a worktree is removed, so its port returns to the pool. */
  releasePort(cwd: string) {
    this.db.prepare('DELETE FROM worktree_ports WHERE cwd = ?').run(cwd);
  }

  // ---- sessions ----------------------------------------------------------

  /** The Claude session id to resume for a worktree, if we have a live one. */
  sessionId(cwd: string): string | null {
    const row = this.db.prepare('SELECT session_id FROM sessions WHERE cwd = ?').get(cwd) as
      | { session_id: string | null }
      | undefined;
    return row?.session_id ?? null;
  }

  setSessionId(cwd: string, sessionId: string | null) {
    this.db
      .prepare(
        `INSERT INTO sessions (cwd, session_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(cwd, sessionId, Date.now());
  }

  // ---- transcripts -------------------------------------------------------

  appendEvent(cwd: string, event: AgentEvent) {
    const keep = forStorage(event);
    if (!keep) return;

    // Streaming text arrives one token at a time. Merging it into the row it
    // continues keeps a long turn to a handful of rows instead of thousands.
    if (isDelta(keep)) {
      const last = this.db
        .prepare('SELECT id, type, event FROM events WHERE cwd = ? ORDER BY id DESC LIMIT 1')
        .get(cwd) as { id: number; type: string; event: string } | undefined;

      if (last && last.type === keep.type) {
        try {
          const merged = JSON.parse(last.event) as typeof keep;
          merged.text += keep.text;
          this.db.prepare('UPDATE events SET event = ? WHERE id = ?').run(JSON.stringify(merged), last.id);
          return;
        } catch {
          // Unreadable row — fall through and start a fresh one.
        }
      }
    }

    this.db
      .prepare('INSERT INTO events (cwd, ts, type, event) VALUES (?, ?, ?, ?)')
      .run(cwd, Date.now(), keep.type, JSON.stringify(keep));

    if (++this.sincefPrune >= PRUNE_INTERVAL) {
      this.sincefPrune = 0;
      this.prune(cwd);
    }
  }

  private prune(cwd: string) {
    this.db
      .prepare(
        `DELETE FROM events WHERE cwd = ? AND id NOT IN (
           SELECT id FROM events WHERE cwd = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(cwd, cwd, TRANSCRIPT_LIMIT);
  }

  transcript(cwd: string): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT event FROM events WHERE cwd = ? ORDER BY id DESC LIMIT ?')
      .all(cwd, TRANSCRIPT_LIMIT) as { event: string }[];

    const events: AgentEvent[] = [];
    // Rows come back newest-first so the LIMIT keeps the tail; flip them back.
    for (let i = rows.length - 1; i >= 0; i--) {
      try {
        events.push(JSON.parse(rows[i].event) as AgentEvent);
      } catch {
        // Skip a corrupt row rather than losing the whole transcript.
      }
    }
    return events;
  }

  clearTranscript(cwd: string) {
    this.db.prepare('DELETE FROM events WHERE cwd = ?').run(cwd);
  }
}

let store: Store | null = null;

/** Initialised once from the main process, with Electron's userData path. */
export function openStore(dir: string): Store {
  store ??= new Store(dir);
  return store;
}

export function getStore(): Store {
  if (!store) throw new Error('Store used before openStore()');
  return store;
}
