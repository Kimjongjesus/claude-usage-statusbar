'use strict';
// The Waste Report page. Same theme variables, nonce'd <style> and strict CSP as the dashboard:
// no scripts, no remote resources, no inline style attributes. Pure string output.
const f = require('./format');
const { docShell } = require('./dashboard');
const { branchLabel } = require('./sessions');

const H = '<span class="tag">heuristic</span>';
const r1 = (n) => Math.round(n * 10) / 10;
const pct = (n, tot) => (tot > 0 ? (n / tot) * 100 : 0);

function who(x) {
  return f.escHtml(f.ellipsize(x.title || [x.project, branchLabel(x.branch)].filter(Boolean).join(' · ') || String(x.sid).slice(0, 8), 56));
}
function whoSub(x) { return f.escHtml([x.project, branchLabel(x.branch)].filter(Boolean).join(' · ')); }

function empty(msg) { return `<p class="empty">${f.escHtml(msg)}</p>`; }

function stackBar(split) {
  const parts = [['seg-in', split.input], ['seg-out', split.output], ['seg-w', split.write5m + split.write1h], ['seg-r', split.read]];
  const total = parts.reduce((a, p) => a + p[1], 0) || 1;
  let x = 0;
  const rects = parts.map(([cls, v]) => {
    const w = (v / total) * 100;
    const r = `<rect class="${cls}" x="${r1(x)}" y="0" width="${r1(w)}" height="14"/>`;
    x += w;
    return r;
  }).join('');
  return `<svg class="stack" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label="Cost by token class">${rects}</svg>`;
}

function section(title, tag, body) { return `<section class="card"><h2>${title}${tag ? ' ' + tag : ''}</h2>${body}</section>`; }

function expensive(rep) {
  if (!rep.expensive.length) return empty('No sessions this month yet.');
  return `<table class="t"><tr><th>Session</th><th class="r">Cost</th><th class="r">Share</th><th class="r">Requests</th><th class="r">Peak context</th></tr>` +
    rep.expensive.map((x) => `<tr><td><div class="name" title="${f.escHtml(x.title || x.sid)}">${who(x)}</div><div class="sub">${whoSub(x)} · ${f.escHtml(f.stamp(x.last))}</div></td>` +
      `<td class="r">${f.usd(x.usd)}</td><td class="r">${x.share.toFixed(0)}%</td><td class="r">${f.count(x.messages)}</td><td class="r">${f.tokensK(x.peakCtx)}</td></tr>`).join('') + '</table>';
}

function cacheSplit(rep) {
  const sp = rep.split, tot = sp.total || 1;
  const w = sp.write5m + sp.write1h;
  const legend = (cls, label, v) => `<span><i class="sw blk ${cls}"></i>${label} ${f.usd(v)} (${pct(v, tot).toFixed(0)}%)</span>`;
  const cs = rep.coldStart, cr = rep.coldRestarts;
  return `${stackBar(sp)}<div class="legend">${legend('seg-in', 'Input', sp.input)}${legend('seg-out', 'Output', sp.output)}${legend('seg-w', 'Cache writes', w)}${legend('seg-r', 'Cache reads', sp.read)}</div>
<table class="t"><tr><th>Where cache-write money went</th><th class="r">Requests</th><th class="r">Cost</th></tr>
<tr><td>Cold start: the first request of each session writes the whole prompt to the cache</td><td class="r">${f.count(cs.sessions)} sessions</td><td class="r">${f.usd(cs.usd)}</td></tr>
<tr><td>Expired-cache rewrites ${H}<div class="sub">a pause longer than the cache lifetime (5 min), then a big cache write of 10k+ tokens</div></td><td class="r">${f.count(cr.count)}</td><td class="r">${f.usd(cr.usd)}</td></tr></table>
<p class="callout">Cache reads cost about a tenth of normal input, so a warm cache is cheap. ${cr.count ? `The ${f.count(cr.count)} rewrites above cost <b>${f.usd(cr.extraUsd)}</b> more than reading the same tokens from a warm cache would have. Keep sessions moving, or start a fresh one (<b>/clear</b>) instead of coming back to a long idle one.` : 'No expired-cache rewrites found.'}</p>`;
}

function bloat(rep) {
  const b = rep.bloat;
  if (!b.sessions.length) return empty(`No session went above ${f.tokensK(b.threshold)} tokens of context this month.`);
  return `<table class="t"><tr><th>Session</th><th class="r">Peak context</th><th class="r">Requests over ${f.tokensK(b.threshold)}</th><th class="r">Re-send above threshold</th></tr>` +
    b.sessions.map((x) => `<tr><td><div class="name" title="${f.escHtml(x.title || x.sid)}">${who(x)}</div><div class="sub">${whoSub(x)} · ${f.count(x.requests)} requests</div></td>` +
      `<td class="r">${f.tokensK(x.peakCtx)}</td><td class="r">${f.count(x.over)}</td><td class="r">${f.usd(x.resendUsd)}</td></tr>`).join('') + '</table>' +
    `<p class="callout">Every request re-sends the whole conversation. Tokens above ${f.tokensK(b.threshold)} cost <b>${f.usd(b.totalResendUsd)}</b> to re-send this month (cache-read rate, summed over those requests). Running <b>/compact</b> or <b>/clear</b> near ${f.tokensK(b.threshold)} would have avoided most of it.</p>`;
}

function repeats(rep) {
  const r = rep.repeats;
  if (!r.files.length) return empty('No file was read more than once in the same session this month.');
  return `<table class="t"><tr><th>File</th><th class="r">Reads</th><th class="r">Sessions</th><th class="r">Repeat reads</th><th class="r">~Tokens added</th><th class="r">~Cost</th></tr>` +
    r.files.map((x) => `<tr><td class="wrap" title="${f.escHtml(x.file)}">${f.escHtml(f.tailPath(x.file, 3))}</td><td class="r">${f.count(x.reads)}</td><td class="r">${f.count(x.sessions)}</td><td class="r">${f.count(x.extraReads)}</td>` +
      `<td class="r">${f.tokensK(x.extraTokens)}</td><td class="r">${f.usd(x.extraUsd)}</td></tr>`).join('') + '</table>' +
    `<p class="callout">${f.count(r.totalExtraReads)} repeat reads added about <b>${f.tokensK(r.totalExtraTokens)}</b> tokens to context (at least ${f.usd(r.totalExtraUsd)} to write to the cache, then re-sent on later requests). Tokens are estimated as result size / 4. Some repeats are legitimate (the file changed in between); that is not checked.</p>`;
}

function huge(rep) {
  const h = rep.huge;
  if (!h.items.length) return empty(`No single tool result was larger than about ${f.tokensK(h.minChars / 4)} tokens this month.`);
  return `<table class="t"><tr><th>Tool</th><th>Target</th><th class="r">~Tokens</th></tr>` +
    h.items.map((x) => `<tr><td>${f.escHtml(x.tool)}</td><td class="wrap" title="${f.escHtml(x.target)}">${f.escHtml(f.ellipsize(x.target.includes('\\') || x.target.includes('/') ? f.tailPath(x.target, 3) : x.target, 70))}</td><td class="r">${f.tokensK(x.tokens)}</td></tr>`).join('') + '</table>' +
    `<p class="callout">${f.count(h.count)} results were over ${f.tokensK(h.minChars / 4)} tokens (about <b>${f.tokensK(h.totalTokens)}</b> in total). Each one stays in the conversation and is re-sent on every later request. Reading with an offset/limit, grepping first, or the Token-Saver hooks (output trimming) keep them out.</p>`;
}

function models(rep) {
  const m = rep.models;
  if (!m.rows.length) return empty('No model usage this month yet.');
  return `<table class="t"><tr><th>Model</th><th class="r">Spend</th><th class="r">Share</th><th class="r">Routine requests ${H}</th><th class="r">Est. saving on a cheaper model</th></tr>` +
    m.rows.map((x) => `<tr><td>${f.escHtml(x.label)}</td><td class="r">${f.usd(x.usd)}</td><td class="r">${x.share.toFixed(0)}%</td><td class="r">${x.cheaper ? f.count(x.routine) + ' of ' + f.count(x.requests) : '&mdash;'}</td>` +
      `<td class="r">${x.cheaper ? f.usd(x.saving) + ' <span class="sub">on ' + f.escHtml(x.cheaper) + '</span>' : '&mdash;'}</td></tr>`).join('') + '</table>' +
    `<p class="callout">Routine = ${f.escHtml(m.routineDefinition)}. Saving = what those exact tokens would have cost on the next cheaper model family (Opus to Sonnet, Sonnet to Haiku) at the built-in prices. ` +
    `Estimated total: <b>${f.usd(m.totalSaving)}</b>. It is an upper-bound style estimate: a cheaper model may need more turns, and a model switch restarts the cache.</p>`;
}

function render(s, d, rep, opts) {
  const o = opts || {};
  const nonce = o.nonce || 'nonce';
  const updated = o.updatedAt || new Date();
  const body = `<div class="head"><h1>Waste Report <span class="pill">${f.monthLabelFromKey(s.month)}</span></h1>
<div class="actions"><a class="btn" href="command:claudeUsage.showDetails">Dashboard</a><a class="btn" href="command:claudeUsage.refresh">Refresh</a><a class="btn primary" href="command:claudeUsage.installHooks">Install token-saver hooks</a></div></div>
<p class="sub">Spend so far: <b>${f.usd(s.totalUsd)}</b> across ${f.count(s.messages)} requests. Every figure below is computed from your local Claude Code logs. Items tagged ${H} rest on a stated rule of thumb, not a measurement.</p>
${section('Most expensive sessions', '', expensive(rep))}
${section('Cold start vs cache reads', '', cacheSplit(rep))}
${section('Context-bloat sessions', H, bloat(rep))}
${section('Repeated reads of the same file', H, repeats(rep))}
${section('Huge tool results', H, huge(rep))}
${section('Model share and routine work', H, models(rep))}
<footer>
<p>Estimate from local Claude Code logs using a built-in price table, not your Anthropic invoice. Token counts for tool results are characters / 4. Nothing leaves your machine.</p>
<p>Last updated ${f.clock(updated)} · ${f.monthLabelFromKey(s.month)} only (resets on the 1st, local time).</p>
</footer>`;
  return docShell('Claude Usage: Waste Report', nonce, body);
}

module.exports = { render };
