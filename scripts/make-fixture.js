#!/usr/bin/env node
'use strict';
// Dev-only: writes a realistic fake Claude Code history (two earlier months plus the current
// month) under <out>/.claude/projects so the extension can be demoed and screenshotted
// without real data. Deterministic (seeded). Not shipped in the .vsix.
//   node scripts/make-fixture.js <out-home-dir> [--now 2026-10-04T10:30:00] [--oct-base 75]
const fs = require('fs');
const path = require('path');
const { costOf } = require('../lib/pricing');

const args = process.argv.slice(2);
const out = args[0];
if (!out) { console.error('usage: make-fixture.js <out-home-dir> [--now ISO] [--oct-base N]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const now = opt('--now') ? new Date(opt('--now')) : new Date();
const curBase = Number(opt('--oct-base', 75));

let seed = 20261004;
function rnd() { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (arr) => { let r = rnd() * arr.reduce((a, x) => a + x[1], 0); for (const [v, w] of arr) { r -= w; if (r <= 0) return v; } return arr[0][0]; };
const hex = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');

const PROJECTS = [['C:\\Users\\eli\\work\\payments-api', 45], ['C:\\Users\\eli\\work\\infra-tools', 25], ['C:\\Users\\eli\\work\\mobile-app', 20], ['C:\\Users\\eli\\work\\docs-site', 10]];
const MODELS = [['claude-sonnet-4-5-20250929', 62], ['claude-opus-4-5-20251101', 33], ['claude-haiku-4-5-20251001', 5]];
const encode = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function message(model) {
  const heavy = model.includes('opus') ? 1.0 : model.includes('haiku') ? 0.5 : 0.8;
  const cacheRead = Math.round((20000 + rnd() * 140000) * heavy);
  const w5 = Math.round(rnd() * 14000), w1 = rnd() < 0.15 ? Math.round(rnd() * 20000) : 0;
  return { input_tokens: 2 + Math.floor(rnd() * 30), output_tokens: Math.round(300 + rnd() * rnd() * 7000),
    cache_creation_input_tokens: w5 + w1, cache_read_input_tokens: cacheRead, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 } };
}

const files = new Map(); // relative path -> lines
function emit(cwd, session, at, model, usage, id) {
  const rel = path.join(encode(cwd), session + '.jsonl');
  if (!files.has(rel)) files.set(rel, []);
  const base = { timestamp: at.toISOString(), cwd, sessionId: session, version: '2.1.0' };
  const l = files.get(rel);
  l.push(JSON.stringify(Object.assign({ type: 'user', uuid: 'u' + id, message: { role: 'user', content: 'working on it' } }, base)));
  // Streaming writes the same message twice; the second one is final.
  const partial = Object.assign({}, usage, { output_tokens: 8 });
  const mk = (u) => JSON.stringify(Object.assign({ type: 'assistant', uuid: 'a' + id, requestId: 'req_' + id, message: { id: 'msg_' + id, role: 'assistant', model, usage: u } }, base));
  l.push(mk(partial)); l.push(mk(usage));
}

let n = 0;
function day(date, target) {
  let spent = 0;
  while (spent < target) {
    const cwd = pick(PROJECTS), model = pick(MODELS), session = [hex(8), hex(4), hex(4), hex(4), hex(12)].join('-');
    let t = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9 + Math.floor(rnd() * 8), Math.floor(rnd() * 60));
    const count = 15 + Math.floor(rnd() * 50);
    for (let i = 0; i < count && spent < target; i++) {
      t = new Date(t.getTime() + (20 + rnd() * 400) * 1000);
      if (t > now) return;
      const usage = message(model);
      spent += costOf(usage, model).usd;
      emit(cwd, session, t, model, usage, ++n);
    }
  }
}

const first = new Date(now.getFullYear(), now.getMonth() - 2, 1);
for (let d = new Date(first); d <= now; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
  const base = d.getMonth() === now.getMonth() ? curBase : d.getMonth() === (now.getMonth() + 11) % 12 ? 42 : 30;
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  day(d, base * (weekend ? 0.15 : 1) * (0.55 + rnd() * 0.9));
}
// Make the boundary visible: messages just before and after midnight on the 1st.
const boundary = new Date(now.getFullYear(), now.getMonth(), 1);
emit(PROJECTS[0][0], 'boundary-session-0001', new Date(boundary.getTime() - 9 * 60 * 1000), MODELS[0][0], message(MODELS[0][0]), ++n);
if (boundary < now) emit(PROJECTS[0][0], 'boundary-session-0002', new Date(boundary.getTime() + 11 * 60 * 1000), MODELS[0][0], message(MODELS[0][0]), ++n);

let total = 0;
for (const [rel, lines] of files) {
  const p = path.join(out, '.claude', 'projects', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
  total += lines.length;
}
// A resumed session copies history into a new file; the extension must not double count it.
const [firstRel] = files.keys();
fs.writeFileSync(path.join(out, '.claude', 'projects', path.dirname(firstRel), 'resumed-copy-0000.jsonl'), files.get(firstRel).join('\n') + '\n');
console.log(`wrote ${files.size} sessions, ${total} lines under ${path.join(out, '.claude', 'projects')}`);
