'use strict';
// Session helpers: which session is "current", how big its context is, and what that costs.
// Pure functions (no vscode, no fs).
const { rateFor } = require('./pricing');
const f = require('./format');

const ACTIVE_MS = 60 * 60 * 1000; // a session counts as "active" if Claude wrote to it in the last hour

function branchLabel(b) {
  if (!b) return '(no branch)';
  if (b === 'HEAD') return '(detached HEAD)';
  return b;
}

const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || String(p).includes('\\');
function normPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return isWinPath(p) ? s.toLowerCase() : s; // Windows paths compare case-insensitively
}
function within(child, parent) {
  const a = normPath(child), b = normPath(parent);
  return !!a && !!b && (a === b || a.startsWith(b + '/'));
}

// Assumptions (documented in the README): the current session is the one Claude wrote to most
// recently (main conversation only; subagent turns carry the same sessionId). With several VS Code
// windows open, a session whose working folder is one of this window's workspace folders wins.
function pickActive(sessions, o) {
  const opt = o || {};
  const now = opt.now || new Date();
  const dirs = opt.workspaceDirs || [];
  const cand = (sessions || []).filter((s) => s.lastCtxAt).sort((a, b) => b.lastCtxAt - a.lastCtxAt);
  if (!cand.length) return null;
  let session = null, inWorkspace = false;
  if (dirs.length) {
    session = cand.find((s) => s.cwd && dirs.some((d) => within(s.cwd, d) || within(d, s.cwd))) || null;
    inWorkspace = !!session;
  }
  if (!session) session = cand[0];
  const ageMs = now - session.lastCtxAt;
  return { session, inWorkspace, ageMs, active: ageMs >= 0 ? ageMs <= ACTIVE_MS : true };
}

// Context size of the session's last main-conversation request, and what re-sending it costs.
function ctxInfo(session, o) {
  const opt = o || {};
  const window = opt.window > 0 ? opt.window : 200000;
  const tokens = session ? session.lastCtx : 0;
  const model = session ? session.lastModel : '';
  const r = rateFor(model, opt.pricingOverrides);
  const read = (r.cacheRead != null ? r.cacheRead : r.input * 0.1) / 1e6;
  const write = (r.cacheWrite5m != null ? r.cacheWrite5m : r.input * 1.25) / 1e6;
  return {
    tokens, window, pct: (tokens / window) * 100, model,
    warmPerRequest: tokens * read, coldPerRequest: tokens * write,
  };
}

// The concrete, numeric tip shown in the hover, the notification and the dashboard.
function adviceText(info) {
  return `Each request re-sends about ${f.tokensK(info.tokens)} tokens: roughly ${f.usdSmall(info.warmPerRequest)} per request at ${f.modelLabel(info.model)} while the cache is warm ` +
    `(${f.usdSmall(info.coldPerRequest)} if it expired). /compact (summarize) or /clear (fresh start) would shrink that.`;
}

module.exports = { ACTIVE_MS, branchLabel, normPath, within, pickActive, ctxInfo, adviceText };
