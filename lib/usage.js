'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { costOf } = require('./pricing');

function defaultDirs(extra) {
  const dirs = [path.join(os.homedir(), '.claude', 'projects'),
    path.join(os.homedir(), '.config', 'claude', 'projects')];
  if (process.env.CLAUDE_CONFIG_DIR) {
    for (const d of process.env.CLAUDE_CONFIG_DIR.split(path.delimiter)) if (d) dirs.push(path.join(d, 'projects'));
  }
  for (const d of extra || []) if (d) dirs.push(d);
  return [...new Set(dirs.map((d) => path.resolve(d)))].filter((d) => fs.existsSync(d));
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
// entry: { sig, records: Map(id -> {ts, model, usage}) }
const cache = new Map();

function parseFile(file) {
  const recs = new Map();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return recs; }
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage"') === -1) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message;
    if (!m || !m.usage || !d.timestamp) continue;
    if (m.model === '<synthetic>') continue;
    const id = (m.id || d.uuid || '') + ':' + (d.requestId || '');
    // Streaming writes the same message several times; the last one is final.
    recs.set(id, { ts: d.timestamp, model: m.model, usage: m.usage });
  }
  return recs;
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
      for (const [id, r] of c.records) all.set(id, Object.assign({ file: f }, r));
    }
  }
  for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);
  return all;
}

function summarize(opts) {
  const now = opts.now || new Date();
  const key = monthKey(now);
  const records = collect(defaultDirs(opts.dataDirs));
  const out = {
    month: key, totalUsd: 0, messages: 0, assumedModels: [],
    byDay: {}, byModel: {}, byProject: {}, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  };
  const assumed = new Set();
  for (const r of records.values()) {
    const t = new Date(r.ts);
    if (isNaN(t) || monthKey(t) !== key) continue;
    const { usd, assumed: a } = costOf(r.usage, r.model, opts.pricingOverrides);
    if (a) assumed.add(r.model);
    out.totalUsd += usd; out.messages++;
    const dk = dayKey(t);
    out.byDay[dk] = (out.byDay[dk] || 0) + usd;
    out.byModel[r.model] = (out.byModel[r.model] || 0) + usd;
    const proj = path.basename(path.dirname(r.file));
    out.byProject[proj] = (out.byProject[proj] || 0) + usd;
    const u = r.usage;
    out.tokens.input += u.input_tokens || 0; out.tokens.output += u.output_tokens || 0;
    out.tokens.cacheWrite += u.cache_creation_input_tokens || 0; out.tokens.cacheRead += u.cache_read_input_tokens || 0;
  }
  out.assumedModels = [...assumed];
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const day = now.getDate();
  out.daysInMonth = dim; out.dayOfMonth = day;
  const elapsed = (day - 1) + (now.getHours() * 60 + now.getMinutes()) / 1440;
  out.projectedUsd = elapsed > 0.05 ? (out.totalUsd / elapsed) * dim : out.totalUsd;
  return out;
}

module.exports = { summarize, defaultDirs, monthKey };
