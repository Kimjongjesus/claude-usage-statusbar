'use strict';
// Orchestration hub model: every project and every session in one spend-first view.
// Pure functions (no vscode, no fs). Input is the month summary (usage.summarize) and the waste report
// (waste.analyze); nothing here re-reads the logs.
const f = require('./format');
const { normPath, within } = require('./sessions');
const { emptyPer } = require('./waste');

// Session state rules (heuristic, documented in the README):
//   Claude spoke last and ended its turn ................ waiting on you (for up to WAITING_MS), then idle
//   Claude spoke last with a tool call still open ....... active for PENDING_MS, then waiting on you (most likely a
//                                                         permission prompt, or a long-running command), then idle
//   a prompt or tool result came last ................... active (Claude is working) for WORKING_MS, then idle
const WAITING_MS = 60 * 60 * 1000;
const PENDING_MS = 2 * 60 * 1000;
const WORKING_MS = 10 * 60 * 1000;
const MODEL_FLAG_MIN_USD = 0.5;  // "expensive model on routine work" only when the estimated saving is worth a look
const SESSION_ROWS = 30;

function sessionState(x, now) {
  const a = x.lastCtxAt ? +x.lastCtxAt : 0;
  const u = x.lastUserAt ? +x.lastUserAt : 0;
  const lastAt = Math.max(a, u, x.last ? +x.last : 0);
  if (!lastAt) return { state: 'idle', why: '', lastAt: null };
  const age = Math.max(0, +now - lastAt);
  if (a && a >= u) {
    if (x.lastStop === 'tool_use') {
      if (age <= PENDING_MS) return { state: 'active', why: 'running a tool', lastAt: new Date(lastAt) };
      if (age <= WAITING_MS) return { state: 'waiting', why: 'a tool call is waiting: probably a permission prompt (or a long command)', lastAt: new Date(lastAt) };
      return { state: 'idle', why: '', lastAt: new Date(lastAt) };
    }
    if (age <= WAITING_MS) return { state: 'waiting', why: 'Claude finished its turn', lastAt: new Date(lastAt) };
    return { state: 'idle', why: '', lastAt: new Date(lastAt) };
  }
  if (age <= WORKING_MS) return { state: 'active', why: 'Claude is working', lastAt: new Date(lastAt) };
  return { state: 'idle', why: '', lastAt: new Date(lastAt) };
}

function sessionName(x) {
  return f.ellipsize(x.title || [x.project, x.branch].filter(Boolean).join(' · ') || String(x.sid).slice(0, 8), 64);
}

// Money-burner flags for one session. Every flag rests on a waste-report rule of thumb, so each carries
// heuristic: true and the view tags it.
function flagsFor(x, per, o) {
  const out = [];
  const p = per || emptyPer();
  const threshold = o.ctxThreshold;
  if (x.lastCtx >= threshold && x.state !== 'idle') {
    out.push({ kind: 'bloat', level: 'crit', label: `Context ${f.tokensK(x.lastCtx)}`, detail: `every request re-sends ${f.tokensK(x.lastCtx)} tokens; /compact or /clear`, usd: p.resendUsd, heuristic: true });
  } else if (p.over > 0) {
    out.push({ kind: 'bloat', level: 'warn', label: 'Bloated context', detail: `${f.count(p.over)} requests over ${f.tokensK(threshold)}; ${f.usd(p.resendUsd)} to re-send the excess`, usd: p.resendUsd, heuristic: true });
  }
  if (p.restarts > 0) {
    out.push({ kind: 'cold', level: 'warn', label: p.restarts === 1 ? 'Cold-cache restart' : `${f.count(p.restarts)} cold-cache restarts`, detail: `pauses longer than the cache lifetime cost ${f.usd(p.restartExtraUsd)} more than a warm cache`, usd: p.restartExtraUsd, heuristic: true });
  }
  if (p.saving >= MODEL_FLAG_MIN_USD) {
    out.push({ kind: 'model', level: 'warn', label: 'Expensive model on routine work', detail: `${f.count(p.routine)} routine requests; about ${f.usd(p.saving)} less on ${p.cheaper}`, usd: p.saving, heuristic: true });
  }
  return out;
}

// o: { now, ctxThreshold, contextWindow, workspaceDirs }
function buildHub(s, rep, o) {
  const opt = o || {};
  const now = opt.now || new Date();
  const ctxThreshold = opt.ctxThreshold > 0 ? opt.ctxThreshold : 150000;
  const window = opt.contextWindow > 0 ? opt.contextWindow : 200000;
  const ws = opt.workspaceDirs || [];
  const per = (rep && rep.perSession) || {};
  const total = s.totalUsd || 0;

  const all = (s.sessions || []).map((x) => {
    const st = sessionState(x, now);
    const row = {
      sid: x.sid, name: sessionName(x), title: x.title || '', project: x.project || '', cwd: x.cwd || '', branch: x.branch || '',
      model: x.lastModel || '', modelLabel: f.modelLabel(x.lastModel || 'unknown'),
      state: st.state, why: st.why, lastAt: st.lastAt || x.last,
      ctx: x.lastCtx || 0, ctxPct: ((x.lastCtx || 0) / window) * 100, peakCtx: x.peakCtx || 0,
      monthUsd: x.monthUsd || 0, usd: x.usd || 0, share: total ? ((x.monthUsd || 0) / total) * 100 : 0,
      requests: x.monthMessages || 0, lastCtx: x.lastCtx || 0,
      inWorkspace: !!x.cwd && ws.some((d) => within(x.cwd, d) || within(d, x.cwd)),
    };
    row.flags = flagsFor(row, per[x.sid], { ctxThreshold });
    row.flagUsd = row.flags.reduce((a, fl) => a + (fl.usd || 0), 0);
    return row;
  });
  const live = all.filter((x) => x.state !== 'idle');
  const month = all.filter((x) => x.requests > 0 || x.state !== 'idle');

  // Projects: same labels as the dashboard's By project card (s.byProject), plus live counts from the sessions.
  const projects = new Map();
  const proj = (name) => {
    if (!projects.has(name)) projects.set(name, { name, cwd: '', monthUsd: 0, share: 0, sessions: 0, live: 0, waiting: 0, active: 0, lastAt: null, flagUsd: 0 });
    return projects.get(name);
  };
  for (const [name, usd] of Object.entries(s.byProject || {})) { const P = proj(name); P.monthUsd = usd; P.share = total ? (usd / total) * 100 : 0; }
  for (const x of month) {
    const P = proj(x.project || '(unknown project)');
    if (x.requests > 0) P.sessions++;
    if (x.state !== 'idle') P.live++;
    if (x.state === 'waiting') P.waiting++;
    if (x.state === 'active') P.active++;
    P.flagUsd += x.flagUsd;
    if (!P.lastAt || (x.lastAt && x.lastAt > P.lastAt)) { P.lastAt = x.lastAt; if (x.cwd) P.cwd = x.cwd; }
    if (!P.cwd && x.cwd) P.cwd = x.cwd;
  }
  const projectRows = [...projects.values()].sort((a, b) => b.monthUsd - a.monthUsd || b.live - a.live || a.name.localeCompare(b.name));

  const order = { waiting: 0, active: 1, idle: 2 };
  live.sort((a, b) => order[a.state] - order[b.state] || b.lastAt - a.lastAt);
  const byCost = month.slice().sort((a, b) => b.monthUsd - a.monthUsd || b.lastAt - a.lastAt);
  const flagged = month.filter((x) => x.flags.length);
  return {
    projects: projectRows,
    live,
    sessions: byCost.slice(0, SESSION_ROWS),
    sessionCount: byCost.length,
    flagged: flagged.sort((a, b) => b.flagUsd - a.flagUsd),
    totals: {
      usd: total, projects: projectRows.length, sessions: byCost.length,
      live: live.length, waiting: live.filter((x) => x.state === 'waiting').length, active: live.filter((x) => x.state === 'active').length,
      flaggedSessions: flagged.length, flaggedUsd: flagged.reduce((a, x) => a + x.flagUsd, 0),
    },
    ctxThreshold, window,
  };
}

// Session ids come from log files; only plain ids are ever put into a command line.
const SAFE_SID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function resumeCommand(sid) {
  if (!SAFE_SID.test(String(sid || ''))) return null;
  return `claude --resume ${sid}`;
}

// Find a session row by id (the webview only ever sends an id back; everything else is looked up here).
function findSession(hub, sid) {
  if (!hub) return null;
  return hub.live.concat(hub.sessions).find((x) => x.sid === sid) || null;
}

// Status bar text for the hub item: "$(layers) 3 live" / "$(bell) 1 waiting · 3 live".
function hubStatusText(t) {
  if (!t) return '$(layers) Hub';
  if (t.waiting) return `$(bell) ${t.waiting} waiting · ${t.live} live`;
  if (t.live) return `$(layers) ${t.live} live`;
  return '$(layers) Hub';
}

module.exports = { buildHub, sessionState, flagsFor, resumeCommand, findSession, hubStatusText, normPath, WAITING_MS, PENDING_MS, WORKING_MS, MODEL_FLAG_MIN_USD, SAFE_SID };
