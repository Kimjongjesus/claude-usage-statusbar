#!/usr/bin/env node
'use strict';
// Plan handoff hook: saves every plan Claude presents (the ExitPlanMode tool) to <project>/.claude/handoffs/<time>.md,
// so the Claude Usage extension can offer to send it to a fresh session with a suggested model and effort.
//
//   Event: PreToolUse, matcher "ExitPlanMode". Never blocks and never answers: it prints nothing and exits 0,
//   so the plan approval in Claude Code is unchanged. Fails open like every script in this folder.
//
// Where the plan comes from (Claude Code 2.1): tool_input.plan, or the file named by tool_input.planFilePath
// (a Markdown file Claude Code keeps the plan in). Where it goes: $CLAUDE_PROJECT_DIR (the folder Claude Code was
// started in), else the event's cwd. The handoffs folder gets a .gitignore ("*") the first time, so saved plans are
// never committed by accident.
//
// Files written: .claude/handoffs/<yyyymmdd-hhmmss>.md (never overwrites: -2, -3... on a clash) and, once,
// .claude/handoffs/.gitignore. Nothing else; no network, no child processes.
const fs = require('fs');
const path = require('path');
const { readInput } = require('./_common');

const MAX_PLAN = 512 * 1024;

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function planText(inp) {
  const ti = inp && inp.tool_input && typeof inp.tool_input === 'object' ? inp.tool_input : {};
  if (typeof ti.plan === 'string' && ti.plan.trim()) return ti.plan;
  const file = typeof ti.planFilePath === 'string' ? ti.planFilePath : '';
  if (file && /\.md$/i.test(file)) {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size <= MAX_PLAN) return fs.readFileSync(file, 'utf8');
    } catch { /* fall through */ }
  }
  return '';
}

// One-line YAML-safe value (no newlines, no leading/trailing quotes to confuse the reader).
const yval = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();

function save(inp, env, now) {
  if (!inp || inp.tool_name !== 'ExitPlanMode') return null;
  const plan = planText(inp);
  if (!plan.trim()) return null;
  const root = (env.CLAUDE_PROJECT_DIR && path.isAbsolute(env.CLAUDE_PROJECT_DIR)) ? env.CLAUDE_PROJECT_DIR
    : (typeof inp.cwd === 'string' && path.isAbsolute(inp.cwd) ? inp.cwd : process.cwd());
  const dir = path.join(root, '.claude', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }); } catch { /* already there */ }
  const body = ['---', 'source: ExitPlanMode', `session_id: ${yval(inp.session_id)}`, `cwd: ${yval(inp.cwd || root)}`,
    `created: ${now.toISOString()}`, '---', '', plan.length > MAX_PLAN ? plan.slice(0, MAX_PLAN) : plan, ''].join('\n');
  const base = stamp(now);
  for (let n = 1; n < 100; n++) {
    const file = path.join(dir, (n === 1 ? base : base + '-' + n) + '.md');
    try { fs.writeFileSync(file, body, { flag: 'wx' }); return file; } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  }
  return null;
}

async function main() {
  try { save(await readInput(), process.env, new Date()); } catch { /* fail open */ }
  process.exitCode = 0;
}

if (require.main === module) main();
module.exports = { save, planText, stamp };
