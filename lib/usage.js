'use strict';
// Month-to-date spend, read-only from Claude Code's local transcripts. The month is the
// local-time calendar month of `now`; nothing from earlier months is added to it.
//
// v0.3 also derives per-session / per-branch numbers and the raw material for the waste
// report (tool calls, tool-result sizes) from the same logs. None of that changes how the
// month-to-date total is computed: it is still the sum over de-duplicated assistant messages.
const fs = require('fs');
const crypto = require('crypto');
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

// ---------------------------------------------------------------------------------------
// Parsing one transcript file. Real Claude Code transcripts (checked against v2.1 logs):
//  - every record carries sessionId, cwd, gitBranch and isSidechain (true for subagent turns)
//  - one assistant message is written as SEVERAL lines (one per content block) that share
//    message.id + requestId; the last line holds the final usage numbers
//  - tool calls are `tool_use` content blocks on assistant lines; their results come back as
//    `tool_result` blocks on user lines, joined by tool_use_id
//  - a resumed/forked session copies earlier messages into a NEW file under the NEW sessionId
//  - `ai-title` records carry Claude's auto-generated session title
// ---------------------------------------------------------------------------------------

function newState(detail) {
  return { detail: !!detail, records: new Map(), toolUses: new Map(), results: new Map(), titles: new Map() };
}

function blockChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) if (b && typeof b.text === 'string') n += b.text.length; // images are not counted
  return n;
}

function ingestLine(line, st) {
  if (!line) return;
  const hasUsage = line.indexOf('"usage"') !== -1;
  const hasResult = st.detail && line.indexOf('"tool_result"') !== -1;
  const hasTitle = line.indexOf('"ai-title"') !== -1;
  if (!hasUsage && !hasResult && !hasTitle) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (!d || typeof d !== 'object') return;
  if (hasTitle && d.type === 'ai-title' && typeof d.aiTitle === 'string' && d.sessionId) st.titles.set(d.sessionId, d.aiTitle);
  const m = d.message;
  if (!m || typeof m !== 'object') return;
  if (hasResult && d.type === 'user' && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && b.type === 'tool_result' && b.tool_use_id) st.results.set(b.tool_use_id, { chars: blockChars(b.content), ts: d.timestamp || '' });
    }
  }
  if (!m.usage || typeof m.usage !== 'object' || !d.timestamp) return;
  if (m.model === '<synthetic>') return;
  const id = (m.id || d.uuid || '') + ':' + (d.requestId || '');
  const prev = st.records.get(id);
  const tools = prev ? prev.tools : [];
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (!tools.includes(b.name)) tools.push(b.name);
      if (st.detail && b.id) {
        const inp = b.input && typeof b.input === 'object' ? b.input : {};
        const file = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : typeof inp.path === 'string' ? inp.path : '';
        const cmd = typeof inp.command === 'string' ? inp.command.slice(0, 160) : '';
        st.toolUses.set(b.id, { name: b.name, file, cmd, sid: d.sessionId || '', ts: d.timestamp });
      }
    }
  }
  // Streaming writes the same message several times; the last one is final.
  st.records.set(id, {
    ts: d.timestamp, model: m.model, usage: m.usage, cwd: typeof d.cwd === 'string' ? d.cwd : '',
    sid: typeof d.sessionId === 'string' ? d.sessionId : '', branch: typeof d.gitBranch === 'string' ? d.gitBranch : '',
    side: d.isSidechain === true, tools,
  });
}

// Whole-string parse. Kept as the public, test-friendly entry point: parseText -> Map(id -> record).
function parseFileText(text, detail) {
  const st = newState(detail);
  for (const line of text.split('\n')) ingestLine(line, st);
  return st;
}
function parseText(text) { return parseFileText(text, false).records; }

// Cache entry per file: { sig, offset, digest, detail, st }. Transcripts are append-only, so a grown file
// is parsed from where the last pass stopped instead of from byte 0. "Append-only" is never assumed: the
// bytes already consumed are re-hashed (a cheap sequential read, no JSON parsing) and must match the hash
// taken last time, otherwise the file was rewritten or replaced and is parsed from scratch. A matching
// size and header alone are NOT proof (a rewrite can keep both).
const cache = new Map();
const CHUNK = 1 << 20;

function readRange(fd, start, end) {
  const len = Math.max(0, end - start);
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

// Streams bytes [0, end) of the file into a fresh hash. Returns the hash object, or null if the file is shorter than `end`.
function hashPrefix(fd, end) {
  const h = crypto.createHash('sha1');
  for (let pos = 0; pos < end; pos += CHUNK) {
    const b = readRange(fd, pos, Math.min(end, pos + CHUNK));
    if (b.length !== Math.min(end, pos + CHUNK) - pos) return null;
    h.update(b);
  }
  return h;
}

// Parses every complete line of `buf` into `st`; returns how many bytes were consumed. A last line
// without a trailing newline counts only when it is complete JSON (it may still be mid-write).
function consume(buf, st) {
  const nl = buf.lastIndexOf(0x0a);
  const body = nl >= 0 ? buf.subarray(0, nl + 1).toString('utf8') : '';
  const tail = buf.subarray(nl + 1).toString('utf8');
  for (const line of body.split('\n')) ingestLine(line, st);
  let used = nl + 1;
  if (tail) {
    let whole = false;
    try { JSON.parse(tail); whole = true; } catch { /* partial line */ }
    if (whole) { ingestLine(tail, st); used = buf.length; }
  }
  return used;
}

function parseFileCached(file, detail) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const prev = cache.get(file);
    if (prev && prev.detail === detail && size >= prev.offset) {
      const h = hashPrefix(fd, prev.offset);
      if (h && h.copy().digest('hex') === prev.digest) {
        if (size > prev.offset) {
          const add = readRange(fd, prev.offset, size);
          const used = consume(add, prev.st);
          h.update(add.subarray(0, used));
          prev.offset += used;
        }
        prev.digest = h.digest('hex');
        return prev;
      }
    }
    // New file, different parse mode, shrunk, or the consumed bytes changed: parse from scratch.
    const st = newState(detail);
    const all = readRange(fd, 0, size);
    const used = consume(all, st);
    return { detail, st, offset: used, digest: crypto.createHash('sha1').update(all.subarray(0, used)).digest('hex') };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// o.detailSince: files last written before this time (ms) skip tool-call/tool-result parsing.
// o.skipBefore: files last written before this time are not read at all (hook scripts: this month only).
function collect(dirs, o) {
  const opt = o || {};
  const seen = new Set();
  const all = { records: new Map(), toolUses: new Map(), results: new Map(), titles: new Map() };
  const keep = (map, id, val) => { const p = map.get(id); if (!p || val.mt < p.mt || (val.mt === p.mt && val.file < p.file)) map.set(id, val); };
  for (const dir of dirs) {
    for (const f of walk(dir)) {
      let stt;
      try { stt = fs.statSync(f); } catch { continue; }
      if (opt.skipBefore && stt.mtimeMs < opt.skipBefore) continue;
      seen.add(f);
      const detail = opt.detailSince === undefined ? true : stt.mtimeMs >= opt.detailSince;
      const sig = stt.size + ':' + stt.mtimeMs;
      let c = cache.get(f);
      if (!c || c.sig !== sig || c.detail !== detail) {
        c = parseFileCached(f, detail);
        if (!c) continue;
        c.sig = sig;
        cache.set(f, c);
      }
      const mt = stt.mtimeMs;
      // A resumed session copies history into a new file: keep the copy from the OLDEST file so a
      // message stays attributed to the session that produced it (totals are unaffected).
      for (const [id, r] of c.st.records) keep(all.records, id, Object.assign({ file: f, root: dir, mt }, r));
      for (const [id, r] of c.st.toolUses) keep(all.toolUses, id, Object.assign({ file: f, mt }, r));
      for (const [id, r] of c.st.results) keep(all.results, id, Object.assign({ file: f, mt }, r));
      for (const [sid, t] of c.st.titles) all.titles.set(sid, t);
    }
  }
  for (const f of cache.keys()) if (!seen.has(f) && !opt.skipBefore) cache.delete(f);
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

// A record without a sessionId (very old logs) falls back to its session folder / file name.
function sessionKey(r) {
  if (r.sid) return r.sid;
  const rel = path.relative(r.root, r.file).split(/[\\/]/);
  return rel.length >= 3 ? rel[1] : path.basename(r.file, '.jsonl');
}

// What one request sent to the model: new input + everything read from or written to the cache.
function ctxTokens(u) {
  const cc = u.cache_creation || {};
  const w = u.cache_creation_input_tokens || ((cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0));
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + w;
}

function summarize(opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const key = monthKey(now);
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const dirs = o.dirs || defaultDirs(o.dataDirs);
  const got = collect(dirs, { detailSince: o.monthOnly ? Infinity : monthStart, skipBefore: o.monthOnly ? monthStart : 0 });
  const out = {
    month: key, year: now.getFullYear(), monthIndex: now.getMonth(),
    totalUsd: 0, messages: 0, assumedModels: [], dirs,
    daily: new Array(dim).fill(0),
    byDay: {}, byModel: {}, byProject: {}, history: {},
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    lastMessageAt: null,
    sessions: [], byBranch: [],
    detail: { records: [], toolUses: got.toolUses, results: got.results },
  };
  const assumed = new Set();
  const byProjectKey = {};
  const sess = new Map();      // sessionId -> aggregate (all months; monthUsd is this month only)
  const branchAgg = new Map(); // project key + branch -> this-month aggregate
  for (const r of got.records.values()) {
    const t = new Date(r.ts);
    if (isNaN(t)) continue;
    const { usd, assumed: a } = costOf(r.usage, r.model, o.pricingOverrides);
    const mk = monthKey(t);
    // Per-session bookkeeping covers every month, so a session that crosses midnight on the 1st stays whole.
    const sid = sessionKey(r);
    let S = sess.get(sid);
    if (!S) {
      S = { sid, usd: 0, monthUsd: 0, messages: 0, monthMessages: 0, first: t, last: t, cwd: '', branch: '', byModel: {}, peakCtx: 0, lastCtx: 0, lastCtxAt: null, lastModel: '', title: got.titles.get(sid) || '' };
      sess.set(sid, S);
    }
    S.usd += usd; S.messages++;
    if (mk === key) { S.monthUsd += usd; S.monthMessages++; }
    if (t < S.first) S.first = t;
    if (t >= S.last) { S.last = t; if (r.cwd) S.cwd = r.cwd; if (r.branch) S.branch = r.branch; }
    if (!S.cwd && r.cwd) S.cwd = r.cwd;
    const mdlKey = r.model || 'unknown';
    S.byModel[mdlKey] = (S.byModel[mdlKey] || 0) + usd;
    if (!r.side) {
      const c = ctxTokens(r.usage);
      if (c > S.peakCtx) S.peakCtx = c;
      if (!S.lastCtxAt || t >= S.lastCtxAt) { S.lastCtxAt = t; S.lastCtx = c; S.lastModel = r.model || ''; }
    }
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
    const bk = pk + '\u0000' + (r.branch || '');
    let B = branchAgg.get(bk);
    if (!B) { B = { projectKey: pk, branch: r.branch || '', usd: 0, messages: 0, sessions: new Set(), last: t }; branchAgg.set(bk, B); }
    B.usd += usd; B.messages++; B.sessions.add(sid);
    if (t > B.last) B.last = t;
    const u = r.usage, cc = u.cache_creation || {};
    out.tokens.input += u.input_tokens || 0;
    out.tokens.output += u.output_tokens || 0;
    out.tokens.cacheWrite += u.cache_creation_input_tokens ||
      ((cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0));
    out.tokens.cacheRead += u.cache_read_input_tokens || 0;
    if (!out.lastMessageAt || t > out.lastMessageAt) out.lastMessageAt = t;
    out.detail.records.push({ r, t, usd, sid, ctx: ctxTokens(r.usage) });
  }
  const labels = projectLabels(Object.keys(byProjectKey));
  for (const [k, v] of Object.entries(byProjectKey)) out.byProject[labels[k]] = (out.byProject[labels[k]] || 0) + v;
  out.assumedModels = [...assumed];
  // Sessions, newest activity first. `project` uses the same labels as the By project card.
  const extra = projectLabels([...new Set([...sess.values()].map((x) => x.cwd).filter((c) => c && !labels[c]))]);
  out.sessions = [...sess.values()].map((x) => Object.assign(x, { project: x.cwd ? (labels[x.cwd] || extra[x.cwd] || x.cwd) : '' }))
    .sort((a, b) => b.last - a.last);
  out.byBranch = [...branchAgg.values()].map((b) => ({
    branch: b.branch, project: labels[b.projectKey] || b.projectKey, usd: b.usd,
    messages: b.messages, sessions: b.sessions.size, last: b.last,
  })).sort((a, b) => b.usd - a.usd);
  out.daysInMonth = dim;
  out.dayOfMonth = now.getDate();
  // Fractional days elapsed since local midnight on the 1st.
  out.elapsedDays = (out.dayOfMonth - 1) + (now.getHours() * 60 + now.getMinutes()) / 1440;
  return out;
}

module.exports = { summarize, defaultDirs, monthKey, parseText, parseFileText, ctxTokens };
