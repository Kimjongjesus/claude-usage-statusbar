#!/usr/bin/env node
'use strict';
// Budget guard (UserPromptSubmit hook): warns when this month's Claude Code spend crosses your thresholds.
//
//   event: UserPromptSubmit  (no matcher)
//   shows YOU a warning (systemMessage) and gives Claude one short economy reminder (additionalContext),
//   once per session per level (warn, then critical). Optionally blocks prompts once spend reaches --block-over %.
//
// Spend = the same month-to-date estimate the status bar shows: it reads Claude Code's local transcripts under
// ~/.claude/projects (read-only), prices tokens with a built-in table, and counts only the current calendar
// month in local time. The last result is cached for 60 s in ~/.claude/token-saver-state.json, which is the ONLY
// file this script ever writes (it remembers which sessions were already warned). No network.
//
// Options (hook "args"): --budget 1000        monthly budget in USD (or env CLAUDE_USAGE_BUDGET_USD)
//                        --warn 75 --crit 90  percent thresholds
//                        --block-over 0       block new prompts at/above this percent (0 = never, the default)
//                        --no-context         do not send Claude the economy reminder
//                        --data-dir <dir>     extra Claude `projects` folder to scan (repeatable)
//                        --state <file>       state file location (default ~/.claude/token-saver-state.json)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readInput, parseArgs, num, emit } = require('./_common');

// Works both from the extension repo (hooks/ next to lib/) and after install (lib/ copied beside the scripts).
function loadUsage() {
  for (const base of [path.join(__dirname, 'lib'), path.join(__dirname, '..', 'lib')]) {
    try { return require(path.join(base, 'usage.js')); } catch (e) { if (e && e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error('usage.js not found next to the hook scripts');
}

const money = (n) => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const monthKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');

function readState(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
function writeState(file, st) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st));
  } catch { /* never fail the prompt over bookkeeping */ }
}

// Pure: decides what to print. `spend` is month-to-date USD; `state` is the persisted object.
function decide(event, cfg, spend, state, now) {
  if (!event || event.hook_event_name !== 'UserPromptSubmit') return { output: null, state };
  const budget = cfg.budget > 0 ? cfg.budget : 1000;
  const pct = (spend / budget) * 100;
  const level = pct >= cfg.crit ? 'crit' : pct >= cfg.warn ? 'warn' : null;
  const st = state && state.month === monthKey(now) ? state : { month: monthKey(now), warned: {} };
  if (!st.warned) st.warned = {};

  if (cfg.blockOver > 0 && pct >= cfg.blockOver) {
    return { state: st, output: { decision: 'block', reason: `Token-Saver budget guard: ${money(spend)} of ${money(budget)} (${Math.floor(pct)}%) is spent this month, at or over your ${cfg.blockOver}% limit. Raise the budget, change --block-over, or wait for the 1st.` } };
  }
  if (!level) return { output: null, state: st };
  const sid = String(event.session_id || 'unknown');
  const seen = st.warned[sid] || {};
  if (seen[level] || (level === 'warn' && seen.crit)) return { output: null, state: st };
  seen[level] = true;
  st.warned[sid] = seen;
  const ids = Object.keys(st.warned);
  if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete st.warned[id];

  const word = level === 'crit' ? 'Critical' : 'Warning';
  const out = {
    systemMessage: `Token-Saver ${word}: Claude Code spend is ${money(spend)} of ${money(budget)} this month (${Math.floor(pct)}%). It resets on the 1st. Tip: /compact long sessions and avoid re-reading files.`,
  };
  if (!cfg.noContext) {
    out.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `Budget guard: monthly Claude spend is at ${Math.floor(pct)}% (${money(spend)} of ${money(budget)}). Be economical: Grep before Read, read with offset/limit, do not re-read files already in context, keep replies short.`,
    };
  }
  return { output: out, state: st };
}

function monthSpend(cfg, state, now) {
  const c = state && state.month === monthKey(now) ? state.cache : null;
  if (c && now - c.at >= 0 && now - c.at < 60 * 1000) return { total: c.total, cached: true };
  const { summarize } = loadUsage();
  const s = summarize({ now, monthOnly: true, dataDirs: cfg.dataDirs });
  return { total: s.totalUsd, cached: false };
}

function configFrom(args, env) {
  return {
    budget: num(args.budget, num(env.CLAUDE_USAGE_BUDGET_USD, 1000)),
    warn: num(args.warn, 75), crit: Math.max(num(args.warn, 75), num(args.crit, 90)),
    blockOver: num(args['block-over'], 0), noContext: args['no-context'] === 'true',
    dataDirs: args['data-dir'] || [],
    state: args.state || path.join(os.homedir(), '.claude', 'token-saver-state.json'),
  };
}

async function main() {
  try {
    const event = await readInput();
    if (!event || event.hook_event_name !== 'UserPromptSubmit') return;
    const cfg = configFrom(parseArgs(process.argv.slice(2), ['data-dir']), process.env);
    const now = new Date();
    let state = readState(cfg.state);
    const { total, cached } = monthSpend(cfg, state, now);
    const res = decide(event, cfg, total, state, now);
    state = res.state;
    if (!cached) state.cache = { at: +now, total };
    writeState(cfg.state, state);
    if (res.output) emit(res.output);
  } catch { /* fail open */ }
  process.exitCode = 0;
}

if (require.main === module) main();
module.exports = { decide, configFrom, monthSpend };
