#!/usr/bin/env node
//
// install.mjs — register the vendored cockpit-probe skill with Claude Code by
// symlinking this directory into ~/.claude/skills/. Run via `npm run skill:install`.
//
// The source of truth is THIS repo copy (tools/cockpit-probe/); the symlink just lets
// Claude Code discover it, so an edit here is live with no re-copy. A single link (from
// whichever checkout you install from) serves every worktree — probe.sh resolves the
// target worktree from your cwd's `git rev-parse`, not from where the script lives.
//
// Deliberately a one-time, EXPLICIT step rather than committing a hidden .claude/ into
// the repo: the cockpit owns its config as first-class, visible files, not dotfiles.

import { mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const src = path.dirname(fileURLToPath(import.meta.url)); // .../tools/cockpit-probe
const skillsDir = path.join(os.homedir(), '.claude', 'skills');
const dest = path.join(skillsDir, 'cockpit-probe');

function statOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

mkdirSync(skillsDir, { recursive: true });

const existing = statOrNull(dest);
if (existing) {
  if (existing.isSymbolicLink()) {
    let current = null;
    try {
      current = readlinkSync(dest);
    } catch {
      /* dangling */
    }
    if (current === src) {
      console.log(`Already linked: ${dest} -> ${src}`);
      process.exit(0);
    }
    unlinkSync(dest); // repoint an existing (stale) symlink
  } else if (existing.isDirectory()) {
    // A real directory is here — most likely an older standalone copy of the skill.
    // Preserve it rather than delete, and refuse if a backup already exists.
    const bak = `${dest}.bak`;
    if (statOrNull(bak)) {
      console.error(`Refusing: ${dest} is a real directory and ${bak} already exists.`);
      console.error(`Remove one of them and re-run \`npm run skill:install\`.`);
      process.exit(1);
    }
    renameSync(dest, bak);
    console.log(`Moved existing directory ${dest} -> ${bak}`);
  } else {
    unlinkSync(dest); // a stray file
  }
}

symlinkSync(src, dest, 'dir');
console.log(`Linked ${dest} -> ${src}`);
console.log('Start a new Claude Code session (or restart it) for the skill to register.');
