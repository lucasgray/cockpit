#!/usr/bin/env bash
#
# probe.sh — launch a DISPOSABLE, per-worktree cockpit instance and drive it over the
# Chrome DevTools Protocol, so you can *see* a cockpit change working without touching
# Lucas's main window. Part of the cockpit-probe skill.
#
# Why a separate instance at all (never-touch-the-main-cockpit-instance): the main
# cockpit runs on the default vite port, with NO debug port and a SHARED SQLite store.
# It must never be reloaded, killed, or written to. A probe is isolated on its own vite
# port (well clear of the 5273-5472 worktree range), its own --remote-debugging-port,
# and its OWN --user-data-dir, so it can never contend with the main store — and stop
# only ever reaps the probe's own recorded pids, never `pkill -f electron`.
#
# Detached on purpose (mirrors restart-dev-stack): Claude Code run_in_background tasks
# are tied to the session and get SIGTERM'd when it cycles. The probe is put in its own
# session so it outlives the launching tool call; its logs are the source of truth.
#
# Written for macOS's stock bash 3.2 (no mapfile / assoc arrays).
#
#   probe.sh launch                 idempotent: reuse a healthy probe, else (re)create
#   probe.sh status                 print probe.json + a live health check
#   probe.sh shot [out.png] [--no-reload]   reload (default) then screenshot; prints path
#   probe.sh eval "<js>"            Runtime.evaluate, returnByValue + awaitPromise
#   probe.sh eval-file <path.js>    run a JS file (driver.js prepended); no shell escaping
#   probe.sh reload                 reload the page (pick up renderer edits, no capture)
#   probe.sh stop                   tear down THIS probe's process trees + tmp dir
#
set -uo pipefail

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
CDP="$SELF_DIR/cdp.mjs"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
# Per-worktree identity: sanitized basename of the worktree root. printf (not a bare
# pipe) so basename's trailing newline never becomes a stray dash in the name.
NAME=$(printf '%s' "$(basename "$ROOT")" | tr -c 'A-Za-z0-9._-' '-')
DIR="/tmp/cockpit-probe-$NAME"
PROBE_JSON="$DIR/probe.json"
export PROBE_DIR="$DIR"

# Port ranges chosen to stay CLEAR of the sticky worktree vite range (5273-5472, from
# electron/ports.ts) so a probe can never collide with the main instance or siblings.
VITE_BASE=5900
CDP_BASE=9222

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# First free port at/above $1, via an EXCLUSIVE net bind-probe (the reusable primitive
# from electron/ports.ts::isPortFree, reimplemented inline with no store dependency).
# Uses stdout.write, NOT console.log — the latter ANSI-colorizes numbers under FORCE_COLOR,
# which would poison COCKPIT_PORT (resolvePort would parse NaN and fall back to 5273).
find_free_port() {
  node -e '
    const net = require("net");
    const base = +process.argv[1];
    const free = (p) => new Promise((r) => {
      const s = net.createServer();
      s.once("error", () => r(false));
      s.once("listening", () => s.close(() => r(true)));
      s.listen({ port: p, host: "127.0.0.1", exclusive: true });
    });
    (async () => {
      for (let p = base; p < base + 300; p++) if (await free(p)) { process.stdout.write(String(p)); process.exit(0); }
      process.exit(1);
    })();
  ' "$1"
}

# Block until 127.0.0.1:$1 accepts a TCP connection, or $2 seconds elapse. Replaces the
# wait-on dependency (v8 throws on the tcp:host:port form under this Node).
wait_tcp() {
  node -e '
    const net = require("net");
    const port = +process.argv[1];
    const deadline = Date.now() + (+process.argv[2]) * 1000;
    const attempt = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); process.exit(0); });
      s.once("error", () => { s.destroy(); if (Date.now() > deadline) process.exit(1); setTimeout(attempt, 250); });
    };
    attempt();
  ' "$1" "$2"
}

# Read one field out of probe.json.
probe_field() {
  node -e 'const j=require(process.argv[1]);process.stdout.write(String(j[process.argv[2]]??""));' \
    "$PROBE_JSON" "$1" 2>/dev/null
}

# Launch a command fully detached in its own session, logging to $1. setsid is cleanest
# but macOS ships none, so fall back to a one-line perl that setsid()s then execs (so the
# recorded pid IS the target process), and plain nohup as a last resort. Sets DETACHED_PID.
detach() {
  local log=$1
  shift
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$@" >"$log" 2>&1 </dev/null &
  elif command -v perl >/dev/null 2>&1; then
    LOG="$log" perl -e '
      use POSIX qw(setsid);
      open(STDIN,  "<", "/dev/null");
      open(STDOUT, ">", $ENV{LOG}) or die "open $ENV{LOG}: $!";
      open(STDERR, ">&", STDOUT);
      setsid();
      exec @ARGV or die "exec: $!";
    ' -- "$@" &
  else
    nohup "$@" >"$log" 2>&1 </dev/null &
  fi
  DETACHED_PID=$!
  disown 2>/dev/null || true
}

write_probe_json() {
  VITEPORT=$1 CDPPORT=$2 VITEPID=$3 ELECTRONPID=$4 UDD=$DIR PROOT=$ROOT node -e '
    const fs = require("fs");
    fs.writeFileSync(process.env.PROBE_DIR + "/probe.json", JSON.stringify({
      vitePort: +process.env.VITEPORT,
      cdpPort: +process.env.CDPPORT,
      vitePid: +process.env.VITEPID,
      electronPid: +process.env.ELECTRONPID,
      userDataDir: process.env.UDD,
      projectRoot: process.env.PROOT,
    }, null, 2) + "\n");
  '
}

# Healthy = probe.json exists AND the CDP page target matches our vite port.
is_healthy() {
  [ -f "$PROBE_JSON" ] || return 1
  local want got
  want=$(probe_field vitePort)
  got=$(node "$CDP" pageport 2>/dev/null) || return 1
  [ -n "$want" ] && [ "$got" = "$want" ]
}

ensure_probe_or_die() {
  [ -f "$PROBE_JSON" ] || { echo "No probe for $NAME. Run: probe.sh launch" >&2; exit 1; }
}

# Echo a pid and every process descended from it (so an electron main can't leave its
# helpers, or a vite parent respawn a child, behind).
collect_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do collect_tree "$child"; done
  printf '%s\n' "$pid"
}

# SIGTERM a set of pids, then SIGKILL any that ignore it.
term_kill() {
  local targets="$1" survivors="" pid
  [ -n "$(echo "$targets" | tr -d ' \n')" ] || return 0
  kill -TERM $targets 2>/dev/null || true
  sleep 2
  for pid in $targets; do kill -0 "$pid" 2>/dev/null && survivors="$survivors $pid"; done
  if [ -n "$(echo "$survivors" | tr -d ' ')" ]; then
    echo "  force-killing survivors:$survivors"
    kill -KILL $survivors 2>/dev/null || true
  fi
}

# Kill the tree of a recorded pid — but ONLY if its command line still matches $2, so a
# recycled pid can never make us take out an unrelated process (least of all the main
# cockpit). For electron, $2 is our --user-data-dir ($DIR); for vite, "vite".
kill_recorded() {
  local pid=$1 needle=$2 tree
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || return 0
  if ! ps -o command= -p "$pid" 2>/dev/null | grep -qF "$needle"; then
    echo "  skip pid $pid — command no longer matches '$needle' (recycled?); not killing"
    return 0
  fi
  tree=$(collect_tree "$pid" | grep -E '^[0-9]+$' | grep -vx "$$" | sort -un)
  echo "  killing pid $pid tree: $(echo $tree | tr '\n' ' ')"
  term_kill "$tree"
}

# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------

cmd_launch() {
  mkdir -p "$DIR"
  if [ -f "$PROBE_JSON" ]; then
    if is_healthy; then
      echo "Probe '$NAME' already healthy — reusing it."
      cmd_status
      return 0
    fi
    echo "Stale probe for '$NAME' — tearing it down before relaunch."
    cmd_stop
    mkdir -p "$DIR"
  fi

  local vport cport
  vport=$(find_free_port "$VITE_BASE") || { echo "no free vite port >= $VITE_BASE" >&2; exit 1; }
  cport=$(find_free_port "$CDP_BASE")  || { echo "no free cdp port >= $CDP_BASE" >&2; exit 1; }
  echo "Probe '$NAME'  ->  vite :$vport   cdp :$cport   udd $DIR"

  cd "$ROOT"

  # 0. deps. The cockpit installs node_modules on worktrees IT creates (electron/main.ts
  #    worktreeCreateHook), but a harness-made worktree (.claude/worktrees/...) skips that,
  #    so a first probe here would find no vite. Install once, up front, if it's missing.
  if [ ! -x "./node_modules/.bin/vite" ]; then
    echo "  node_modules missing — running npm install (first launch in this worktree)..."
    if ! npm install >"$DIR/npm-install.log" 2>&1; then
      echo "npm install failed — see $DIR/npm-install.log" >&2
      exit 1
    fi
  fi

  # 1. vite (its config reads COCKPIT_PORT via resolvePort; host 127.0.0.1, strictPort).
  detach "$DIR/vite.log" env COCKPIT_PORT="$vport" ./node_modules/.bin/vite
  local vpid=$DETACHED_PID
  echo "  vite pid $vpid -> $DIR/vite.log"
  if ! wait_tcp "$vport" 60; then
    echo "vite never bound :$vport — see $DIR/vite.log" >&2
    exit 1
  fi

  # 2. bundle the electron main (produces dist-electron/main.cjs).
  echo "  building electron main..."
  if ! npm run build:electron >"$DIR/build.log" 2>&1; then
    echo "build:electron failed — see $DIR/build.log" >&2
    exit 1
  fi

  # 3. electron, pointed at our vite (COCKPIT_PORT) with its OWN user-data-dir + debug
  #    port. COCKPIT_PROJECT_ROOT keeps its git calls in this worktree.
  detach "$DIR/electron.log" \
    env COCKPIT_PORT="$vport" COCKPIT_PROJECT_ROOT="$ROOT" \
    ./node_modules/.bin/electron dist-electron/main.cjs \
    --remote-debugging-port="$cport" --user-data-dir="$DIR"
  local epid=$DETACHED_PID
  echo "  electron pid $epid -> $DIR/electron.log"

  write_probe_json "$vport" "$cport" "$vpid" "$epid"

  # 4. wait for the page target on OUR vite port to appear.
  local i=0
  until node "$CDP" pageport >/dev/null 2>&1; do
    i=$((i + 1))
    if [ $i -gt 60 ]; then
      echo "page target on :$vport never appeared — see $DIR/electron.log" >&2
      exit 1
    fi
    sleep 0.5
  done

  echo "Probe '$NAME' up."
  cmd_status
}

cmd_status() {
  if [ ! -f "$PROBE_JSON" ]; then
    echo "No probe for '$NAME' (nothing at $DIR)."
    return 1
  fi
  cat "$PROBE_JSON"
  echo
  if is_healthy; then
    echo "health: OK — CDP reachable on :$(probe_field cdpPort), page port $(probe_field vitePort) matches vite."
  else
    echo "health: UNHEALTHY — CDP unreachable or page/port mismatch. Run 'launch' to recreate."
    return 1
  fi
}

cmd_shot() {
  ensure_probe_or_die
  local out="" noreload=""
  for a in "$@"; do
    case "$a" in
      --no-reload) noreload="--no-reload" ;;
      *) out="$a" ;;
    esac
  done
  if [ -z "$out" ]; then
    local n=1
    while [ -e "$DIR/shot-$n.png" ]; do n=$((n + 1)); done
    out="$DIR/shot-$n.png"
  fi
  node "$CDP" screenshot "$out" $noreload
}

cmd_eval() {
  ensure_probe_or_die
  [ $# -gt 0 ] || { echo 'usage: probe.sh eval "<js expression>"' >&2; exit 1; }
  node "$CDP" eval "$@"
}

# Run a JS file in the page with the driver (turn/stream/snapshot/poll) prepended.
# Write plain JS to a file and pass its path — no shell-escaping of backticks/$.
cmd_evalfile() {
  ensure_probe_or_die
  [ $# -gt 0 ] || { echo 'usage: probe.sh eval-file <path.js>' >&2; exit 1; }
  [ -f "$1" ] || { echo "eval-file: no such file: $1" >&2; exit 1; }
  node "$CDP" eval-file "$@"
}

cmd_reload() {
  ensure_probe_or_die
  node "$CDP" reload
}

cmd_stop() {
  if [ ! -f "$PROBE_JSON" ]; then
    echo "No probe.json for '$NAME' — nothing recorded to stop."
  else
    local epid vpid vport
    epid=$(probe_field electronPid)
    vpid=$(probe_field vitePid)
    vport=$(probe_field vitePort)
    echo "Stopping probe '$NAME' (electron $epid, vite $vpid)..."
    kill_recorded "$epid" "$DIR"    # electron: matched by its --user-data-dir
    kill_recorded "$vpid" "vite"    # vite: matched by command
    # Belt-and-suspenders: anything still listening on our EXCLUSIVE probe vite port.
    if [ -n "$vport" ]; then
      local extra
      extra=$(lsof -ti "tcp:$vport" -sTCP:LISTEN 2>/dev/null)
      if [ -n "$extra" ]; then
        echo "  killing lingering listener on :$vport ($extra)"
        term_kill "$extra"
      fi
    fi
  fi
  rm -rf "$DIR"
  echo "Probe '$NAME' stopped; $DIR removed."
}

# ---------------------------------------------------------------------------

case "${1:-}" in
  launch)    shift; cmd_launch "$@" ;;
  status)    shift; cmd_status "$@" ;;
  shot)      shift; cmd_shot "$@" ;;
  eval)      shift; cmd_eval "$@" ;;
  eval-file) shift; cmd_evalfile "$@" ;;
  reload)    shift; cmd_reload "$@" ;;
  stop)      shift; cmd_stop "$@" ;;
  *)
    echo "usage: probe.sh <launch|status|shot|eval|eval-file|reload|stop>" >&2
    exit 2
    ;;
esac
