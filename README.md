# Cockpit (toy)

A chat-first "drive the agent" cockpit with a real code-viewing surface. It looks
like Claude Code Desktop on the left (thinking / narration / plans with
first-class code snippets) and a live Monaco **diff** on the right that streams
edits in as the agent works, auto-scrolling to each change and pinning the
agent's rationale next to the line it changed.

## Run

```bash
npm install
npm run app
```

One command: it starts Vite, waits for it, builds the Electron main/preload,
and launches the window. The **left rail lists your live git worktrees** (read
by the Electron main process via `git worktree list`), with a Worktrees|Files
switcher; picking one sets the active worktree. Point it at a repo other than
the default with `COCKPIT_PROJECT_ROOT=/path/to/repo npm run app`.

> The cockpit is the desktop app: worktrees and agent turns both live in the
> Electron main process, so `npm run dev` on its own only serves the UI shell.

### Thinking mode

The **✳ Thinking** toggle in the composer (or **Tab**, as in Claude Code) drops
the selected worktree into thinking mode. Off — the default — the model still
reasons, but Claude Code omits the blocks, so all the cockpit can show is its
spinner. On, thinking comes back summarized and streams into the transcript as
`✳ thinking` bubbles above the answer.

It's per-worktree, like the sessions themselves: one worktree can reason out loud
while a sibling grinds. The setting sticks across restarts, and flipping it
mid-turn lands on the next prompt rather than half-changing the one in flight.

### Model and effort

Beside the toggle sit two switchers, per-worktree on the same terms: **Model**
and **Effort**. Pin the worktree holding the hard problem to Opus at max effort
and leave the mechanical one on Haiku, and the two run side by side without
either one's setting leaking into the other.

Both open on **default** — no model and no effort are sent, so an unpinned
worktree is exactly the CLI's own choice — and an unpinned model falls back to
`settings.model` before that. Effort is only offered where the model takes one:
Haiku has none, and the models that do don't all reach `max`, so the levels come
from the model rather than from a list of ours. Switching to a model that won't
take the level you were on drops the level rather than sending a turn it rejects.

The list itself comes from the installed Claude Code (`supportedModels()`), which
is the only thing that knows what this machine can actually reach. That needs a
live session, so the switcher opens on a short built-in list and swaps itself for
the real catalogue as soon as any worktree has run a turn.

#### Telling the rows apart

The CLI's display names are bare — "Opus (1M context)", "Default (recommended)"
— and say nothing about *which* Opus. The generation is in the description, so
every row carries its own as a tooltip: *Opus 5 with 1M context · Best for
everyday, complex tasks*.

#### The previous generation

`supportedModels()` advertises only the current generation, but the one before it
is still perfectly reachable — it just isn't offered. `UNLISTED_MODELS` in
`src/settings.ts` fills the gap, merged in beside the live rows:

| Row | Sent as | Effort |
| --- | --- | --- |
| Opus 4.8 | `claude-opus-4-8[1m]` | low … max |
| Opus 4.7 | `claude-opus-4-7[1m]` | low … max |
| Opus 4.6 | `claude-opus-4-6[1m]` | low … max, no `xhigh` |
| Sonnet 4.6 | `claude-sonnet-4-6[1m]` | low … max, no `xhigh` |

Every one was verified by running a real turn against it. Mythos 5 is the only
current-table model this machine can't reach (invitation-only), so it's absent.

Two things worth knowing about that table. Each `value` carries the **`[1m]`
suffix** for the same reason the catalogue's own `opus[1m]` row does: without it
Claude Code caps the session at 200K. And `xhigh` arrived with Opus 4.7, so the
4.6 rows stop at `high`/`max` — pick one of them while sitting on `xhigh` and the
effort switcher drops back to default rather than sending a level that errors.

The list is hand-maintained, which is the cost of the CLI not exposing one. It
defers to the catalogue: if a later Claude Code starts advertising Opus 4.8
itself, its row wins and ours is dropped rather than showing the model twice.

### Pasting screenshots

⌘⇧4, then ⌘V into the cockpit. The screenshot lands as a thumbnail above the
prompt box and rides along with the next turn; images dragged in from Finder land
the same way. A paste is claimed wherever the focus is, so it works straight off
the shortcut without clicking into the box first — except over another editable
surface, where the paste belongs to whatever is being edited. Send takes text, a
screenshot, or both: a screenshot on its own is a whole prompt ("look at this"),
and the images go ahead of the words in the message, which is the order the model
reads them in.

Each one is right-sized on the way in — scaled down to a 1568px long edge, which
is the largest the API keeps anyway, so nothing is lost that the model would have
seen. A retina ⌘⇧4 is routinely 3× that in each direction, i.e. 9× the pixels to
carry and pay tokens for; the same 1MB capture arrives as ~400KB. Screenshots
re-encode as PNG (that's mostly text and edges, and lossy compression is exactly
wrong for it), photos stay JPEG, and anything already small enough is passed
through untouched so an animated GIF survives.

Sent images are kept, so a conversation comes back with its screenshots in it.
They go to files under the app's userData directory rather than into the
transcript, because a transcript is replayed from its event rows and a megabyte
of base64 per screenshot would be read back in full every time a worktree was
opened. The events name the file instead and the window loads it over a
`cockpit-image://` scheme of the cockpit's own, rooted at that directory and
refusing everything outside it. One folder per worktree, so a removed worktree's
screenshots go the way its transcript and its port already do.

## Architecture

The UI is driven entirely by a **stream of `AgentEvent`s** — any source that
speaks the protocol drives the cockpit unchanged. It's also framework-agnostic
(plain DOM), so wrapping it in a Tauri/Electron fat client is a shell, not a
rewrite.

| File | What |
| --- | --- |
| `src/agent/protocol.ts` | The `AgentEvent` union + `EditOp` types — the contract between any source and the cockpit. |
| `src/agent/electronSource.ts` | Desktop path: turns the main process's IPC event pushes back into an `AsyncGenerator<AgentEvent>`. |
| `src/cockpit.ts` | The cockpit: conversation column, Monaco diff, the edit-streaming engine, and the pinned-thought decorations. |
| `src/markdown.ts` | Escape-first Markdown renderer for transcript bubbles — nothing the model writes survives as live HTML. |
| `src/images.ts` | Clipboard/drop → base64: decoding, right-sizing and re-encoding a pasted screenshot in the renderer. |
| `src/settings.ts` | The cockpit's own agent config (shared by both processes), so behaviour doesn't depend on the operator's dotfiles. |
| `src/worktrees.ts` | Worktree rail state + the selection that survives reloads. |
| `src/bridge.ts` | The renderer↔main contract: `Worktree`, `AgentRunRequest`, `CockpitBridge`. |
| `src/theme.ts` | The `cockpit-dark` Monaco theme — token colors + editor chrome. |
| `electron/main.ts` | Window + IPC host: `git worktree list`, agent runs, store access. |
| `electron/preload.ts` | The only thing the renderer can reach — implements `CockpitBridge` over `ipcRenderer`. |
| `electron/agentRunner.ts` | Drives the Claude Agent SDK `query()` loop, including the PreToolUse diff hook. |
| `electron/store.ts` | SQLite (`node:sqlite`) in the app's userData dir — transcripts, sessions, settings. Never written into the repo under work. |
| `electron/images.ts` | Pasted screenshots on disk beside that database, and the containment check behind the `cockpit-image://` scheme. |

## Ideas to poke at next

- Move into a Tauri fat client (the UI code doesn't change — see below).
- Make plan snippets approvable chunk-by-chunk before they're applied.
- A live theme editor that writes back to `theme.ts`.
- Git blame / a SQL runner — get these free by moving into a VS Code extension host instead of rebuilding them.

## Wrapping in Tauri later (~10 min, needs Rust)

The UI code doesn't change — Tauri wraps this Vite app in a native window. Note
that worktrees, agent runs and the store all live in the Electron main process,
so for a packaged Tauri app you'd reimplement that host as Tauri commands (Rust)
or a small sidecar — same event protocol either way.

```bash
npm install -D @tauri-apps/cli
npx tauri init      # frontendDist: ../dist, devUrl: http://localhost:5273
npx tauri dev
```
