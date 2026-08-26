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
| `src/settings.ts` | The cockpit's own agent config (shared by both processes), so behaviour doesn't depend on the operator's dotfiles. |
| `src/worktrees.ts` | Worktree rail state + the selection that survives reloads. |
| `src/bridge.ts` | The renderer↔main contract: `Worktree`, `AgentRunRequest`, `CockpitBridge`. |
| `src/theme.ts` | The `cockpit-dark` Monaco theme — token colors + editor chrome. |
| `electron/main.ts` | Window + IPC host: `git worktree list`, agent runs, store access. |
| `electron/preload.ts` | The only thing the renderer can reach — implements `CockpitBridge` over `ipcRenderer`. |
| `electron/agentRunner.ts` | Drives the Claude Agent SDK `query()` loop, including the PreToolUse diff hook. |
| `electron/store.ts` | SQLite (`node:sqlite`) in the app's userData dir — transcripts, sessions, settings. Never written into the repo under work. |

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
