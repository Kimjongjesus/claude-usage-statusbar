'use strict';
// Waste report analysis. Every number is computed from the local transcripts; where a figure rests
// on a rule of thumb the result says so (`heuristic: true` plus a note in the view). No vscode, no fs.
const { costOf, costParts } = require('./pricing');
const { normPath } = require('./sessions');
const f = require('./format');

const COLD_GAP_MS = 5 * 60 * 1000;        // Anthropic's default prompt-cache lifetime
const COLD_GAP_1H_MS = 60 * 60 * 1000;    // extended (1h) cache
const COLD_MIN_TOKENS = 10000;            // ignore tiny rewrites
const HUGE_CHARS = 20000;                 // ~5k tokens by the usual 4 chars/token rule of thumb
const ROUTINE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Bash', 'PowerShell']);
const ROUTINE_MAX_OUT = 400;              // output tokens
const CHEAPER = [[/opus/i, 'claude-sonnet-4-5'], [/sonnet/i, 'claude-haiku-4-5']];

const tok = (chars) => Math.round(chars / 4);

function emptyReport() {
  return {
    expensive: [], split: { input: 0, output: 0, write5m: 0, write1h: 0, read: 0, total: 0 },
    coldStart: { sessions: 0, usd: 0, tokens: 0 }, coldRestarts: { count: 0, usd: 0, extraUsd: 0, tokens: 0, sessions: [], heuristic: true },
    bloat: { threshold: 150000, sessions: [], totalResendUsd: 0, heuristic: true },
    repeats: { files: [], totalExtraReads: 0, totalExtraTokens: 0, totalExtraUsd: 0, heuristic: true },
    huge: { items: [], count: 0, totalTokens: 0, minChars: HUGE_CHARS, heuristic: true },
    models: { rows: [], totalSaving: 0, routineDefinition: '', heuristic: true },
  };
}

function analyze(s, o) {
  const opt = o || {};
  const rep = emptyReport();
  const threshold = opt.ctxThreshold > 0 ? opt.ctxThreshold : 150000;
  rep.bloat.threshold = threshold;
  const det = s.detail;
  if (!det) return rep;
  const monthStart = new Date(s.year, s.monthIndex, 1).getTime();
  const sessById = new Map((s.sessions || []).map((x) => [x.sid, x]));

  // --- Most expensive sessions this month ---------------------------------------------------
  rep.expensive = (s.sessions || []).filter((x) => x.monthUsd > 0).sort((a, b) => b.monthUsd - a.monthUsd).slice(0, 8)
    .map((x) => ({ sid: x.sid, title: x.title, project: x.project, branch: x.branch, usd: x.monthUsd, share: s.totalUsd ? (x.monthUsd / s.totalUsd) * 100 : 0, messages: x.monthMessages, peakCtx: x.peakCtx, last: x.last }));

  // --- Cost by token class, and per-session ordered main-conversation records ---------------
  const bySess = new Map();
  for (const rec of det.records) {
    const parts = costParts(rec.r.usage, rec.r.model, opt.pricingOverrides);
    rec.parts = parts;
    for (const k of ['input', 'output', 'write5m', 'write1h', 'read']) rep.split[k] += parts[k];
    if (rec.r.side) continue; // subagent turns have their own context; they do not belong in a session's timeline
    if (!bySess.has(rec.sid)) bySess.set(rec.sid, []);
    bySess.get(rec.sid).push(rec);
  }
  rep.split.total = rep.split.input + rep.split.output + rep.split.write5m + rep.split.write1h + rep.split.read;

  const restartRows = [], bloatRows = [];
  for (const [sid, list] of bySess) {
    list.sort((a, b) => a.t - b.t);
    const S = sessById.get(sid) || {};
    // cold start = the session's very first request: nothing cached yet, so the whole prompt is a cache write
    const first = list[0];
    rep.coldStart.sessions++;
    rep.coldStart.usd += first.parts.write5m + first.parts.write1h;
    rep.coldStart.tokens += first.parts.writeTokens;
    const rs = { count: 0, usd: 0, extra: 0, tokens: 0 };
    const bl = { n: 0, resend: 0, reads: 0 };
    for (let i = 0; i < list.length; i++) {
      const cur = list[i], p = cur.parts;
      // Cache rewrite after an idle gap (heuristic: gap longer than the cache lifetime + a big write)
      if (i > 0) {
        const gap = cur.t - list[i - 1].t;
        const limit = p.write1h > p.write5m ? COLD_GAP_1H_MS : COLD_GAP_MS;
        if (gap > limit && p.writeTokens >= COLD_MIN_TOKENS) {
          const wUsd = p.write5m + p.write1h;
          rs.count++; rs.usd += wUsd; rs.tokens += p.writeTokens;
          rs.extra += Math.max(0, wUsd - p.writeTokens * p.rates.read); // extra over a warm-cache read
        }
      }
      // Context bloat: tokens above the threshold are re-sent (at the cache-read rate) on every request
      bl.reads += cur.ctx * p.rates.read;
      if (cur.ctx > threshold) { bl.n++; bl.resend += (cur.ctx - threshold) * p.rates.read; }
    }
    const who = { sid, title: S.title, project: S.project, branch: S.branch };
    if (rs.count) restartRows.push(Object.assign(who, rs));
    if (bl.n) bloatRows.push(Object.assign({}, who, { requests: list.length, over: bl.n, peakCtx: S.peakCtx || 0, resendUsd: bl.resend, totalReadUsd: bl.reads }));
  }
  restartRows.sort((a, b) => b.usd - a.usd);
  rep.coldRestarts.sessions = restartRows.slice(0, 5);
  for (const r of restartRows) { rep.coldRestarts.count += r.count; rep.coldRestarts.usd += r.usd; rep.coldRestarts.extraUsd += r.extra; rep.coldRestarts.tokens += r.tokens; }
  bloatRows.sort((a, b) => b.resendUsd - a.resendUsd);
  rep.bloat.sessions = bloatRows.slice(0, 6);
  rep.bloat.totalResendUsd = bloatRows.reduce((a, r) => a + r.resendUsd, 0);

  // --- Repeated reads of the same file within one session ------------------------------------
  const reads = new Map(); // sid + file -> reads
  for (const [id, u] of det.toolUses) {
    if (u.name !== 'Read' || !u.file) continue;
    if (new Date(u.ts).getTime() < monthStart) continue;
    const key = u.sid + '\u0000' + normPath(u.file);
    if (!reads.has(key)) reads.set(key, { sid: u.sid, file: u.file, items: [] });
    const res = det.results.get(id);
    reads.get(key).items.push({ ts: u.ts, chars: res ? res.chars : 0 });
  }
  const files = new Map();
  for (const g of reads.values()) {
    g.items.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const k = normPath(g.file);
    let F = files.get(k);
    if (!F) { F = { file: g.file, reads: 0, sessions: 0, extraReads: 0, extraChars: 0, extraUsd: 0 }; files.set(k, F); }
    F.reads += g.items.length; F.sessions++;
    if (g.items.length > 1) {
      const S = sessById.get(g.sid);
      const rate = costParts({ cache_creation_input_tokens: 1 }, S ? S.lastModel : '', opt.pricingOverrides).rates.write5m;
      const avg = g.items.reduce((a, x) => a + x.chars, 0) / g.items.length;
      for (const it of g.items.slice(1)) { // the first read is needed; the rest are repeats
        const c = it.chars || avg;
        F.extraReads++; F.extraChars += c; F.extraUsd += tok(c) * rate;
      }
    }
  }
  const repeated = [...files.values()].filter((x) => x.extraReads > 0).sort((a, b) => b.extraChars - a.extraChars);
  rep.repeats.files = repeated.slice(0, 8).map((x) => ({ file: x.file, reads: x.reads, sessions: x.sessions, extraReads: x.extraReads, extraTokens: tok(x.extraChars), extraUsd: x.extraUsd }));
  rep.repeats.totalExtraReads = repeated.reduce((a, x) => a + x.extraReads, 0);
  rep.repeats.totalExtraTokens = repeated.reduce((a, x) => a + tok(x.extraChars), 0);
  rep.repeats.totalExtraUsd = repeated.reduce((a, x) => a + x.extraUsd, 0);

  // --- Huge tool results -----------------------------------------------------------------------
  const big = [];
  for (const [id, r] of det.results) {
    if (r.chars < HUGE_CHARS) continue;
    if (new Date(r.ts).getTime() < monthStart) continue;
    const u = det.toolUses.get(id);
    big.push({ tool: u ? u.name : 'unknown', target: u ? (u.file || u.cmd || '') : '', chars: r.chars, tokens: tok(r.chars), sid: u ? u.sid : '' });
  }
  big.sort((a, b) => b.chars - a.chars);
  rep.huge.count = big.length;
  rep.huge.totalTokens = big.reduce((a, x) => a + x.tokens, 0);
  rep.huge.items = big.slice(0, 8);

  // --- Per-model share + estimated saving from moving routine work to a cheaper model ----------
  const rows = new Map();
  for (const rec of det.records) {
    const r = rec.r;
    const label = f.modelLabel(r.model || 'unknown');
    let row = rows.get(label);
    if (!row) { row = { label, usd: 0, requests: 0, routine: 0, routineUsd: 0, saving: 0, cheaper: '' }; rows.set(label, row); }
    row.usd += rec.usd; row.requests++;
    const tools = r.tools || [];
    const routine = tools.length > 0 && tools.every((t) => ROUTINE_TOOLS.has(t)) && (r.usage.output_tokens || 0) <= ROUTINE_MAX_OUT;
    const target = CHEAPER.find(([re]) => re.test(r.model || ''));
    if (routine && target) {
      const alt = costOf(r.usage, target[1], opt.pricingOverrides).usd;
      row.routine++; row.routineUsd += rec.usd; row.saving += Math.max(0, rec.usd - alt);
      row.cheaper = f.modelLabel(target[1]);
    }
  }
  const total = s.totalUsd || 1;
  rep.models.rows = [...rows.values()].sort((a, b) => b.usd - a.usd).map((x) => Object.assign(x, { share: (x.usd / total) * 100 }));
  rep.models.totalSaving = rep.models.rows.reduce((a, x) => a + x.saving, 0);
  rep.models.routineDefinition = `a request whose only tool calls were ${[...ROUTINE_TOOLS].join(', ')} and whose answer was at most ${ROUTINE_MAX_OUT} output tokens`;
  return rep;
}

module.exports = { analyze, HUGE_CHARS, COLD_GAP_MS, ROUTINE_TOOLS, ROUTINE_MAX_OUT };
