#!/usr/bin/env node
'use strict';
// Dev-only: writes a realistic fake Claude Code history (two earlier months plus the current month) under
// <out>/.claude/projects so the extension can be demoed and screenshotted without real data. Deterministic
// (seeded). Not shipped in the .vsix.
//   node scripts/make-fixture.js <out-home-dir> [--now 2026-10-04T10:30:00] [--oct-base 75] [--live-ctx 142000] [--handoff <project-dir>]
//
// What it contains (all fake, in the real Claude Code log format: sessionId, gitBranch, cwd, tool_use blocks,
// tool_result sizes, ai-title records, streamed duplicate lines, a resumed-session copy):
//   - many sessions across 4 projects and several feature branches, with context that grows turn by turn
//   - a few pauses longer than the 5-minute cache lifetime (cache rewrites) and the odd /compact
//   - one BLOATED Opus session yesterday (context climbing to ~190k, repeated reads of the same files, huge
//     tool results, a long pause) so the Waste Report has something to show
//   - one LIVE Sonnet session ending a few minutes before --now at --live-ctx tokens of context (status bar hint)
//   - a session that crosses midnight on the 1st
const fs = require('fs');
const path = require('path');
const { costOf } = require('../lib/pricing');

const args = process.argv.slice(2);
const out = args[0];
if (!out) { console.error('usage: make-fixture.js <out-home-dir> [--now ISO] [--oct-base N] [--live-ctx N]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const now = opt('--now') ? new Date(opt('--now')) : new Date();
const curBase = Number(opt('--oct-base', 75));
const liveCtx = Number(opt('--live-ctx', 142000));
const handoffDir = opt('--handoff'); // optional: also write a saved plan (as hooks/save-plan.js would) into <dir>/.claude/handoffs
let liveSid = '';

let seed = 20261004;
function rnd() { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (arr) => { let r = rnd() * arr.reduce((a, x) => a + x[1], 0); for (const [v, w] of arr) { r -= w; if (r <= 0) return v; } return arr[0][0]; };
const hex = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const uuid = () => [hex(8), hex(4), hex(4), hex(4), hex(12)].join('-');
const between = (a, b) => a + rnd() * (b - a);

const W = 'C:\\Users\\alex\\work\\';
const PROJECTS = [[W + 'support-hub', 50], [W + 'client-portal', 22], [W + 'infra-tools', 18], [W + 'docs-site', 10]];
const BRANCHES = {
  'support-hub': [['feature/support-queue', 35], ['feature/refund-dashboard', 25], ['feature/client-health-scores', 20], ['feature/hub-registry', 12], ['main', 8]],
  'client-portal': [['feature/ticket-intake', 50], ['main', 30], ['fix/login-timeout', 20]],
  'infra-tools': [['main', 60], ['chore/ci-cache', 40]],
  'docs-site': [['main', 100]],
};
const TITLES = {
  'feature/support-queue': ['Support queue: SLA timers and escalation panel', 'Queue dashboard: agent workload view'],
  'feature/refund-dashboard': ['Refund dashboard: table, filters, export', 'Refund approvals: audit trail'],
  'feature/client-health-scores': ['Client health score dashboard', 'Health score: trend sparkline'],
  'feature/hub-registry': ['Hub registry: auto-register dashboards'],
  'feature/ticket-intake': ['Ticket intake form validation', 'Intake: attachment upload'],
  'fix/login-timeout': ['Fix session timeout on login'],
  'chore/ci-cache': ['CI: cache node_modules between runs'],
  main: ['Tidy lint warnings', 'Update README for the hub', 'Dependency bump and test fixes'],
};
const FILES = {
  'support-hub': ['src\\hub\\registry.ts', 'src\\hub\\shell\\Layout.tsx', 'src\\hub\\auth.ts', 'src\\dashboards\\refunds\\RefundTable.tsx', 'src\\dashboards\\queue\\SlaTimer.tsx', 'src\\dashboards\\health\\HealthScore.tsx', 'src\\shared\\api\\client.ts', 'src\\shared\\ui\\Table.tsx', 'package.json', 'tsconfig.json'],
  'client-portal': ['src\\pages\\Intake.tsx', 'src\\pages\\Login.tsx', 'src\\api\\tickets.ts', 'src\\components\\Upload.tsx', 'package.json'],
  'infra-tools': ['scripts\\deploy.ps1', 'ci\\pipeline.yml', 'src\\cache.ts', 'package.json'],
  'docs-site': ['docs\\index.md', 'docs\\hub-guide.md', 'mkdocs.yml'],
};
const COMMANDS = ['npm test', 'npm run build', 'git status', 'git diff --stat', 'npx tsc --noEmit', 'npm run lint', 'dir src', 'git log --oneline -10'];
const MODELS = [['claude-sonnet-4-5-20250929', 62], ['claude-opus-4-5-20251101', 33], ['claude-haiku-4-5-20251001', 5]];
const OPUS = 'claude-opus-4-5-20251101', SONNET = 'claude-sonnet-4-5-20250929';
const encode = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const proj = (cwd) => cwd.split('\\').pop();

const files = new Map(); // relative path -> lines
let n = 0;

// One request. `tools`: [{ name, input, chars }]. Writes the user line, a streamed partial, the final assistant
// lines (text block + one line per tool call, sharing the message id) and one tool_result line per call.
function request(s, at, usage, tools, stop) {
  const id = ++n;
  const rel = path.join(encode(s.cwd), s.id + '.jsonl');
  if (!files.has(rel)) files.set(rel, []);
  const l = files.get(rel);
  const base = (t) => ({ timestamp: t.toISOString(), cwd: s.cwd, sessionId: s.id, gitBranch: s.branch, version: '2.1.0', isSidechain: false });
  const fin = stop || (tools.length ? 'tool_use' : 'end_turn'); // Claude Code writes stop_reason on every line of the message
  const msg = (u, content, sr) => JSON.stringify(Object.assign({ type: 'assistant', uuid: 'a' + id + '-' + content.length, requestId: 'req_' + id, message: { id: 'msg_' + id, role: 'assistant', model: s.model, content, stop_reason: sr === undefined ? fin : sr, usage: u } }, base(at)));
  l.push(JSON.stringify(Object.assign({ type: 'user', uuid: 'u' + id, message: { role: 'user', content: 'working on it' } }, base(new Date(+at - 4000)))));
  const partial = Object.assign({}, usage, { output_tokens: 8 });
  l.push(msg(partial, [{ type: 'text', text: '…' }], null));
  const blocks = tools.map((t, i) => ({ type: 'tool_use', id: `toolu_${id}_${i}`, name: t.name, input: t.input }));
  for (const b of blocks) l.push(msg(usage, [b]));
  if (!blocks.length) l.push(msg(usage, [{ type: 'text', text: 'done' }]));
  if (!s.noResults) tools.forEach((t, i) => {
    l.push(JSON.stringify(Object.assign({ type: 'user', uuid: 'r' + id + '-' + i, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}_${i}`, content: 'x'.repeat(Math.round(t.chars)) }] } }, base(new Date(+at + 1500)))));
  });
  if (!s.titled) { s.titled = true; l.push(JSON.stringify({ type: 'ai-title', sessionId: s.id, aiTitle: s.title })); }
  s.cost += costOf(usage, s.model).usd;
  return costOf(usage, s.model).usd;
}

function newSession(cwd, branch, model, title) {
  const p = proj(cwd);
  const br = branch || pick(BRANCHES[p] || [['main', 1]]);
  return { id: uuid(), cwd, branch: br, model, title: title || pick((TITLES[br] || TITLES.main).map((t) => [t, 1])), cost: 0, titled: false, project: p };
}

function toolFor(s, o) {
  const pool = FILES[s.project] || FILES['docs-site'];
  const file = s.cwd + '\\' + pick(pool.map((f, i) => [f, i < 3 ? 3 : 1])); // the first few files are read again and again
  const r = rnd();
  if (r < 0.28) return { name: 'Read', input: { file_path: file }, chars: between(1500, 6000) };
  if (r < 0.46) return { name: 'Grep', input: { pattern: 'registerDashboard', path: s.cwd + '\\src' }, chars: between(500, 3000) };
  if (r < 0.74) {
    const cmd = pick(COMMANDS.map((c) => [c, 1]));
    const big = /^npm (test|run build|run lint)/.test(cmd) && rnd() < 0.12; // only build/test logs get huge
    return { name: 'Bash', input: { command: cmd }, chars: big ? between(22000, 60000) : between(200, 6000) };
  }
  if (r < 0.90) return { name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' }, chars: 200 };
  return null;
}

// A session: context grows turn by turn (the cache holds the earlier turns), long pauses expire the cache,
// the odd /compact shrinks it again. `o.script(i, s)` may force a tool call for request i.
function session(s, start, count, o) {
  const opts = o || {};
  let ctx = opts.ctx0 || between(14000, 22000);
  let t = new Date(start);
  let spent = 0, expired = true;
  const step = opts.targetCtx ? (opts.targetCtx - ctx) / count : null;
  for (let i = 0; i < count; i++) {
    const long = opts.pauseAt === i || (!opts.noPauses && i > 3 && rnd() < 0.015);
    t = new Date(+t + (long ? between(7, 40) * 60000 : between(20, 400) * 1000));
    if (t > now && !opts.force) return spent;
    if (opts.endBy && t > opts.endBy) return spent;
    let delta = step !== null ? step * between(0.8, 1.2) : between(500, 3200);
    if (step !== null && i === count - 1) delta = Math.max(0, opts.targetCtx - ctx);
    let compact = false;
    if (step === null && !opts.noCompact && ctx > 90000 && rnd() < 0.03) { compact = true; }
    let usage;
    if (compact) {
      ctx = between(18000, 26000);
      usage = { read: 0, write5m: Math.round(ctx), write1h: 0 };
      expired = false;
    } else if (expired || long) {
      const w = Math.round(ctx + delta);
      usage = { read: 0, write5m: rnd() < 0.15 ? 0 : w, write1h: 0 };
      if (!usage.write5m) usage = { read: 0, write5m: 0, write1h: w }; // some sessions use the 1h cache
      ctx += delta; expired = false;
    } else {
      usage = { read: Math.round(ctx), write5m: Math.round(delta), write1h: 0 };
      ctx += delta;
    }
    const routine = s.model === OPUS && rnd() < 0.45;
    const tool = opts.script && opts.script(i, s) || toolFor(s);
    const outTok = routine ? Math.round(between(80, 380)) : Math.round(300 + rnd() * rnd() * 7000);
    const tools = tool && routine && !['Read', 'Grep', 'Bash'].includes(tool.name) ? [] : tool ? [tool] : [];
    spent += request(s, t, { input_tokens: 2 + Math.floor(rnd() * 30), output_tokens: outTok,
      cache_creation_input_tokens: usage.write5m + usage.write1h, cache_read_input_tokens: usage.read,
      cache_creation: { ephemeral_5m_input_tokens: usage.write5m, ephemeral_1h_input_tokens: usage.write1h } }, tools);
    if (opts.stopAtCost && spent >= opts.stopAtCost) break;
  }
  return spent;
}

function day(date, target) {
  let spent = 0;
  while (spent < target) {
    const cwd = pick(PROJECTS), model = pick(MODELS);
    const s = newSession(cwd, null, model);
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9 + Math.floor(rnd() * 8), Math.floor(rnd() * 60));
    if (start > now) return;
    spent += session(s, start, 15 + Math.floor(rnd() * 50), { stopAtCost: target - spent, endBy: new Date(+now - 75 * 60000) });
  }
}

const first = new Date(now.getFullYear(), now.getMonth() - 2, 1);
for (let d = new Date(first); d <= now; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
  const base = d.getMonth() === now.getMonth() ? curBase : d.getMonth() === (now.getMonth() + 11) % 12 ? 42 : 30;
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  day(d, base * (weekend ? 0.15 : 1) * (0.55 + rnd() * 0.9));
}

// --- Scripted sessions the screenshots rely on ---------------------------------------------------------------
const HUB = W + 'support-hub';
const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 13, 0);
{ // BLOATED Opus session: context climbs to ~190k, same files read again and again, huge results, one long pause
  const s = newSession(HUB, 'feature/refund-dashboard', OPUS, 'Refund dashboard: table, filters, export');
  const reads = ['src\\dashboards\\refunds\\RefundTable.tsx', 'src\\hub\\registry.ts', 'src\\shared\\api\\client.ts'];
  session(s, yesterday, 140, {
    ctx0: 30000, targetCtx: 192000, pauseAt: 70, noCompact: true, noPauses: true, force: true,
    script: (i) => {
      if (i === 30) return { name: 'Bash', input: { command: 'npm run build 2>&1' }, chars: 85000 };
      if (i === 62) return { name: 'Read', input: { file_path: HUB + '\\dist\\hub.min.js' }, chars: 41000 };
      if (i === 95) return { name: 'Bash', input: { command: 'npm test -- --verbose' }, chars: 47000 };
      if (i % 3 === 0 && i < 125) return { name: 'Read', input: { file_path: HUB + '\\' + reads[(i / 3) % 2 === 0 ? 0 : (i % 2 ? 1 : 2)] }, chars: 8200 };
      if (i % 5 === 1) return { name: 'Grep', input: { pattern: 'RefundRow', path: HUB + '\\src' }, chars: 1800 };
      if (i % 4 === 2) return { name: 'Edit', input: { file_path: HUB + '\\' + reads[0], old_string: 'a', new_string: 'b' }, chars: 200 };
      return null;
    },
  });
}
{ // Another recent feature session on a different branch (so by-branch has several clear rows)
  const s = newSession(HUB, 'feature/client-health-scores', SONNET, 'Client health score dashboard');
  session(s, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 10, 15), 55, { force: true, noPauses: true });
}
{ // LIVE Sonnet session: last request a few minutes before `now`, context = --live-ctx
  const s = newSession(HUB, 'feature/support-queue', SONNET, 'Support queue: SLA timers and escalation panel');
  const count = 44;
  const start = new Date(+now - 2 * 3600 * 1000 + 3 * 60000); // 2h earlier; the last request lands ~3 min before now
  // spread requests so the final one is 3 minutes before `now`
  let spacing = (2 * 3600 * 1000 - 6 * 60000) / count;
  let t = new Date(start);
  let ctx = 18000; const step = (liveCtx - ctx) / count;
  for (let i = 0; i < count; i++) {
    t = new Date(+start + spacing * i * 0.93 + 60000 * (i === 0 ? 0 : 0));
    if (i === count - 1) t = new Date(+now - 3 * 60000);
    const delta = i === count - 1 ? Math.max(0, liveCtx - ctx) : step * between(0.85, 1.15);
    const usage = i === 0 ? { read: 0, write5m: Math.round(ctx + delta) } : { read: Math.round(ctx), write5m: Math.round(delta) };
    ctx += delta;
    const tool = i === count - 1 ? null : toolFor(s); // the last answer ends the turn: Claude is waiting on you
    request(s, t, { input_tokens: 4, output_tokens: Math.round(300 + rnd() * rnd() * 5000), cache_creation_input_tokens: usage.write5m, cache_read_input_tokens: usage.read,
      cache_creation: { ephemeral_5m_input_tokens: usage.write5m, ephemeral_1h_input_tokens: 0 } }, tool ? [tool] : []);
  }
  liveSid = s.id;
}
// More live sessions for the hub, one per state: Claude working (tool call just answered), Claude working on a fresh
// prompt, and a tool call stuck for minutes (a permission prompt in a real session).
function liveSession(cwd, branch, model, title, count, ctx0, endAgoMs, last) {
  const s = newSession(cwd, branch, model, title);
  let ctx = ctx0;
  for (let i = 0; i < count; i++) {
    const t = new Date(+now - endAgoMs - (count - 1 - i) * between(60, 150) * 1000);
    const delta = between(900, 2600);
    const usage = i === 0 ? { read: 0, write5m: Math.round(ctx) } : { read: Math.round(ctx), write5m: Math.round(delta) };
    ctx += delta;
    const isLast = i === count - 1;
    const tool = isLast && last.tool ? last.tool : toolFor(s);
    if (isLast && last.noResult) s.noResults = true;
    request(s, t, { input_tokens: 4, output_tokens: Math.round(200 + rnd() * 1800), cache_creation_input_tokens: usage.write5m, cache_read_input_tokens: usage.read,
      cache_creation: { ephemeral_5m_input_tokens: usage.write5m, ephemeral_1h_input_tokens: 0 } }, isLast && last.noTool ? [] : tool ? [tool] : [], isLast && last.noTool ? 'end_turn' : undefined);
  }
  if (last.promptAgoMs) {
    const rel = path.join(encode(s.cwd), s.id + '.jsonl');
    files.get(rel).push(JSON.stringify({ type: 'user', uuid: 'u-live-' + s.id.slice(0, 8), timestamp: new Date(+now - last.promptAgoMs).toISOString(), cwd: s.cwd, sessionId: s.id, gitBranch: s.branch, isSidechain: false, message: { role: 'user', content: 'next step' } }));
  }
  return s;
}
liveSession(W + 'client-portal', 'feature/ticket-intake', OPUS, 'Intake: attachment upload', 26, 24000, 50 * 1000, { tool: { name: 'Bash', input: { command: 'npm test' }, chars: 2400 } });
liveSession(W + 'infra-tools', 'chore/ci-cache', SONNET, 'CI: cache node_modules between runs', 14, 16000, 4 * 60000, { tool: { name: 'Bash', input: { command: 'git push --force-with-lease' }, chars: 0 }, noResult: true });
liveSession(W + 'docs-site', 'main', 'claude-haiku-4-5-20251001', 'Update README for the hub', 9, 12000, 7 * 60000, { noTool: true, promptAgoMs: 40 * 1000 });
{ // A session that crosses midnight on the 1st: one session, two months
  const boundary = new Date(now.getFullYear(), now.getMonth(), 1);
  const s = newSession(HUB, 'feature/hub-registry', SONNET, 'Hub registry: auto-register dashboards');
  const u = (r, w) => ({ input_tokens: 6, output_tokens: 1800, cache_creation_input_tokens: w, cache_read_input_tokens: r, cache_creation: { ephemeral_5m_input_tokens: w, ephemeral_1h_input_tokens: 0 } });
  request(s, new Date(+boundary - 9 * 60000), u(60000, 3000), []);
  if (boundary < now) request(s, new Date(+boundary + 11 * 60000), u(63000, 2500), []);
}

let total = 0;
for (const [rel, lines] of files) {
  const p = path.join(out, '.claude', 'projects', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
  total += lines.length;
}
// A resumed session copies history into a new file under a new session id; the extension must not double count it.
const [firstRel] = files.keys();
fs.writeFileSync(path.join(out, '.claude', 'projects', path.dirname(firstRel), 'resumed-copy-0000.jsonl'),
  files.get(firstRel).join('\n').replace(/"sessionId":"[^"]+"/g, '"sessionId":"resumed-copy-0000"') + '\n');
console.log(`wrote ${files.size} sessions, ${total} lines under ${path.join(out, '.claude', 'projects')}`);

if (handoffDir) {
  // A plan the LIVE session presented a minute ago, saved the way hooks/save-plan.js saves it.
  const at = new Date(+now - 60000);
  const p2 = (x) => String(x).padStart(2, '0');
  const name = `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}.md`;
  const dir = path.join(handoffDir, '.claude', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(dir, name), ['---', 'source: ExitPlanMode', `session_id: ${liveSid}`, `cwd: ${HUB}`, `created: ${at.toISOString()}`, '---', '',
    '# Plan: SLA escalation panel for the support queue', '',
    '## Context', 'Agents miss SLA breaches because the queue only shows a timer. Add an escalation panel that lists tickets about to breach and lets a lead reassign them.', '',
    '## Steps', '1. Add `EscalationPanel.tsx` under `src/dashboards/queue/` that lists tickets within 30 minutes of breach, sorted by time left.',
    '2. Extend `src/shared/api/client.ts` with `getAtRiskTickets()` and `reassignTicket(id, agentId)`.',
    '3. Reuse `SlaTimer.tsx` for the countdown cells; move its threshold constants into `src/dashboards/queue/sla.ts`.',
    '4. Register the panel in `src/hub/registry.ts` next to the queue dashboard.',
    '5. Add tests in `src/dashboards/queue/EscalationPanel.test.tsx` and `src/shared/api/client.test.ts`.', '',
    '## Verification', '- `npm test` and `npx tsc --noEmit` pass.', '- The panel shows the seeded at-risk tickets in the dev server.', ''].join('\n'));
  console.log(`wrote a saved plan: ${path.join(dir, name)}`);
}
