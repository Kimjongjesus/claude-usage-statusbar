'use strict';
// Month-to-date spend, read-only from Claude Code's local transcripts. The month is the
// local-time calendar month of `now`; nothing from earlier months is added to it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { costOf } = require('./pricing');
const { resolveDirs, lastSegment, lastSegments } = require('./paths');

function defaultDirs(extra, env, home, pathMod) {
  return resolveDirs({ env: env || process.env, homedir: home || os.homedir(), pathMod: pathMod || path, extra })
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function dayKey(d) { return monthKey(d) + '-' + String(d.getDate()).padStart(2, '0'); }

// Per-file cache so refreshes only reparse files that changed.
// entry: { sig, records: Map(id -> {ts, model, usage, cwd}) }
const cache = new Map();

function parseText(text) {
  const recs = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage"') === -1) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d && d.message;
    if (!m || !m.usage || typeof m.usage !== 'object' || !d.timestamp) continue;
    if (m.model === '<synthetic>') continue;
    const id = (m.id || d.uuid || '') + ':' + (d.requestId || '');
    // Streaming writes the same message several times; the last one is final.
    recs.set(id, { ts: d.timestamp, model: m.model, usage: m.usage, cwd: typeof d.cwd === 'string' ? d.cwd : '' });
  }
  return recs;
}

function parseFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return new Map(); }
  return parseText(text);
}

function collect(dirs) {
  const seen = new Set();
  const all = new Map(); // global dedupe across files (resumed sessions copy history)
  for (const dir of dirs) {
    for (const f of walk(dir)) {
      seen.add(f);
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      const sig = st.size + ':' + st.mtimeMs;
      let c = cache.get(f);
      if (!c || c.sig !== sig) { c = { sig, records: parseFile(f) }; cache.set(f, c); }
      for (const [id, r] of c.records) all.set(id, Object.assign({ file: f, root: dir }, r));
    }
  }
  for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);
  return all;
}

// Project key + label. Prefer the working directory Claude recorded (real folder name);
// fall back to the first folder under the projects dir (Claude's encoded cwd).
function projectKey(r) {
  if (r.cwd) return r.cwd;
  const rel = path.relative(r.root, r.file).split(/[\\/]/);
  return rel.length > 1 ? rel[0] : path.basename(path.dirname(r.file));
}
function projectLabels(keys) {
  const base = new Map();
  for (const k of keys) base.set(k, lastSegment(k) || k);
  const count = {};
  for (const l of base.values()) count[l] = (count[l] || 0) + 1;
  const out = {};
  for (const [k, l] of base) out[k] = count[l] > 1 ? lastSegments(k, 2) || l : l;
  return out;
}

function summarize(opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const key = monthKey(now);
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dirs = o.dirs || defaultDirs(o.dataDirs);
  const records = collect(dirs);
  const out = {
    month: key, year: now.getFullYear(), monthIndex: now.getMonth(),
    totalUsd: 0, messages: 0, assumedModels: [], dirs,
    daily: new Array(dim).fill(0),
    byDay: {}, byModel: {}, byProject: {}, history: {},
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    lastMessageAt: null,
  };
  const assumed = new Set();
  const byProjectKey = {};
  for (const r of records.values()) {
    const t = new Date(r.ts);
    if (isNaN(t)) continue;
    const { usd, assumed: a } = costOf(r.usage, r.model, o.pricingOverrides);
    const mk = monthKey(t);
    if (mk !== key) {
      // Secondary info only (small "previous months" list); never added to this month.
      if (mk < key) out.history[mk] = (out.history[mk] || 0) + usd;
      continue;
    }
    if (a) assumed.add(r.model);
    out.totalUsd += usd; out.messages++;
    out.daily[t.getDate() - 1] += usd;
    const dk = dayKey(t);
    out.byDay[dk] = (out.byDay[dk] || 0) + usd;
    const mdl = r.model || 'unknown';
    out.byModel[mdl] = (out.byModel[mdl] || 0) + usd;
    const pk = projectKey(r);
    byProjectKey[pk] = (byProjectKey[pk] || 0) + usd;
    const u = r.usage, cc = u.cache_creation || {};
    out.tokens.input += u.input_tokens || 0;
    out.tokens.output += u.output_tokens || 0;
    out.tokens.cacheWrite += u.cache_creation_input_tokens ||
      ((cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0));
    out.tokens.cacheRead += u.cache_read_input_tokens || 0;
    if (!out.lastMessageAt || t > out.lastMessageAt) out.lastMessageAt = t;
  }
  const labels = projectLabels(Object.keys(byProjectKey));
  for (const [k, v] of Object.entries(byProjectKey)) out.byProject[labels[k]] = (out.byProject[labels[k]] || 0) + v;
  out.assumedModels = [...assumed];
  out.daysInMonth = dim;
  out.dayOfMonth = now.getDate();
  // Fractional days elapsed since local midnight on the 1st.
  out.elapsedDays = (out.dayOfMonth - 1) + (now.getHours() * 60 + now.getMinutes()) / 1440;
  return out;
}

module.exports = { summarize, defaultDirs, monthKey, parseText };
