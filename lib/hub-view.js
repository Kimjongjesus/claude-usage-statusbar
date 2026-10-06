'use strict';
// The Orchestration Hub page: every project and session on one spend-first page. Same theme variables, nonce'd
// <style> and strict CSP as the dashboard: no scripts, no remote resources, no inline style attributes.
// Actions are VS Code command links (claudeUsage.hubAction) that carry only a session id or a handoff file name;
// the extension looks everything else up itself.
const f = require('./format');
const { docShell, meter } = require('./dashboard');
const { branchLabel } = require('./sessions');
const advice = require('./plan-advice');

const H = '<span class="tag">heuristic</span>';
const STATE = { active: 'Active', waiting: 'Waiting on you', idle: 'Idle' };

function act(op, payload, text, title) {
  const arg = encodeURIComponent(JSON.stringify([Object.assign({ op }, payload)]));
  return `<a class="lnk" href="command:claudeUsage.hubAction?${f.escHtml(arg)}" title="${f.escHtml(title || text)}">${f.escHtml(text)}</a>`;
}

function ago(d, now) {
  if (!d) return '';
  const s = Math.max(0, Math.round((+now - +d) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return f.stamp(d);
}

function badge(x) {
  return `<span class="state st-${x.state}" title="${f.escHtml(x.why || STATE[x.state])}">${STATE[x.state]}</span>`;
}

function flagChips(x) {
  if (!x.flags.length) return '';
  return x.flags.map((fl) => `<span class="flag fl-${fl.level}" title="${f.escHtml(fl.detail)}">${f.escHtml(fl.label)}${fl.usd >= 0.01 ? ' · ' + f.usd(fl.usd) : ''}</span>`).join('');
}

function ctxCell(x, hub) {
  const lvl = x.ctx >= hub.ctxThreshold ? 'm-crit' : x.ctxPct >= 50 ? 'm-warn' : 'm-good';
  return `${f.tokensK(x.ctx)}<span class="pct">${Math.floor(x.ctxPct)}%</span>${meter(x.ctxPct, lvl)}`;
}

function actions(x) {
  const out = [];
  if (x.sid) out.push(act('resume', { sid: x.sid }, 'Copy resume command', 'Copy "claude --resume <id>" for this session'));
  if (x.cwd) out.push(act('folder', { sid: x.sid }, 'Open folder', 'Open this session\'s folder in a new window'));
  return `<div class="acts">${out.join('')}</div>`;
}

function who(x) {
  return `<div class="name" title="${f.escHtml(x.title || x.sid)}">${f.escHtml(x.name)}</div><div class="sub">${f.escHtml([x.project, branchLabel(x.branch)].filter(Boolean).join(' · '))}</div>${actions(x)}`;
}

function liveCard(hub, now) {
  const live = hub.live;
  if (!live.length) return `<section class="card"><h2>Live now</h2><p class="empty">No session has been active in the last hour.</p></section>`;
  return `<section class="card"><h2>Live now <span class="tag">${f.count(hub.totals.waiting)} waiting · ${f.count(hub.totals.active)} active</span></h2>
<table class="t hub"><tr><th>Session</th><th>State</th><th>Model</th><th class="r">Context</th><th class="r">Cost (month)</th><th class="r">Last activity</th></tr>` +
    live.map((x) => `<tr class="${x.inWorkspace ? 'mine' : ''}"><td>${who(x)}${x.flags.length ? `<div class="flags">${flagChips(x)}</div>` : ''}</td><td>${badge(x)}</td><td class="nw">${f.escHtml(x.modelLabel)}</td>` +
      `<td class="r ctx">${ctxCell(x, hub)}</td><td class="r">${f.usd(x.monthUsd)}</td><td class="r">${f.escHtml(ago(x.lastAt, now))}</td></tr>`).join('') +
    '</table></section>';
}

function projectsCard(hub, now) {
  const rows = hub.projects;
  if (!rows.length) return `<section class="card"><h2>Projects</h2><p class="empty">Nothing logged this month yet.</p></section>`;
  return `<section class="card"><h2>Projects</h2><table class="t hub"><tr><th>Project</th><th class="r">Month cost</th><th class="share">Share of spend</th><th class="r">Sessions</th><th class="r">Live</th><th class="r">Last activity</th></tr>` +
    rows.map((p) => `<tr><td><div class="name" title="${f.escHtml(p.name)}">${f.escHtml(p.name)}</div>${p.flagUsd >= 0.01 ? `<div class="sub">flagged ${f.usd(p.flagUsd)}</div>` : ''}</td><td class="r">${f.usd(p.monthUsd)}</td>` +
      `<td class="share">${Math.round(p.share)}%${meter(Math.max(1, p.share))}</td><td class="r">${f.count(p.sessions)}</td>` +
      `<td class="r">${p.live ? `<b>${f.count(p.live)}</b>${p.waiting ? ` <span class="sub">(${f.count(p.waiting)} waiting)</span>` : ''}` : '&mdash;'}</td><td class="r">${f.escHtml(ago(p.lastAt, now))}</td></tr>`).join('') +
    '</table></section>';
}

function sessionsCard(hub, now) {
  const rows = hub.sessions;
  if (!rows.length) return `<section class="card"><h2>Sessions this month</h2><p class="empty">No sessions this month yet.</p></section>`;
  const more = hub.sessionCount > rows.length ? `<p class="callout">Showing the ${f.count(rows.length)} most expensive of ${f.count(hub.sessionCount)} sessions.</p>` : '';
  return `<section class="card"><h2>Sessions this month <span class="tag">by cost</span></h2>
<table class="t hub"><tr><th>Session</th><th>State</th><th>Model</th><th class="r">Context</th><th class="r">Cost</th><th class="r">Last activity</th><th>Flags ${H}</th></tr>` +
    rows.map((x) => `<tr class="${x.inWorkspace ? 'mine' : ''}"><td>${who(x)}</td><td>${badge(x)}</td><td class="nw">${f.escHtml(x.modelLabel)}</td><td class="r ctx">${ctxCell(x, hub)}</td>` +
      `<td class="r">${f.usd(x.monthUsd)}<div class="sub">${Math.round(x.share)}%</div></td><td class="r">${f.escHtml(ago(x.lastAt, now))}</td><td class="flags">${flagChips(x) || '<span class="sub">&mdash;</span>'}</td></tr>`).join('') +
    `</table>${more}</section>`;
}

function handoffsCard(handoffs, now, hookOn) {
  if (!handoffs) return '';
  if (!handoffs.length) {
    return `<section class="card"><h2>Plan handoffs</h2><p class="empty">No saved plans in this window's folders yet. ${hookOn ? '' : 'Run <b>Claude Usage: Set Up Plan Handoff</b> to save every plan Claude presents and get a model suggestion for it.'}</p></section>`;
  }
  return `<section class="card"><h2>Plan handoffs ${H}</h2><table class="t hub"><tr><th>Plan</th><th>Suggested</th><th class="r">Saved</th><th>Status</th><th></th></tr>` +
    handoffs.map((h) => `<tr><td><div class="name" title="${f.escHtml(h.relPath)}">${f.escHtml(h.title)}</div><div class="sub">${f.escHtml(h.project || '')}</div></td>` +
      `<td><b>${f.escHtml(advice.label(h.suggestion.model, h.suggestion.effort))}</b><div class="sub wrap">${f.escHtml(h.suggestion.reason)}</div></td>` +
      `<td class="r nw">${f.escHtml(ago(new Date(h.mtimeMs), now))}</td><td class="nw">${f.escHtml(h.status || 'new')}</td>` +
      `<td class="r"><span class="acts">${act('handoff', { name: h.name, root: h.rootIndex }, 'Send…', 'Send this plan to a new Claude Code session')}</span></td></tr>`).join('') +
    '</table></section>';
}

function render(hub, s, d, opts) {
  const o = opts || {};
  const nonce = o.nonce || 'nonce';
  const now = o.updatedAt || new Date();
  const t = hub.totals;
  const body = `<div class="head"><h1>Orchestration Hub <span class="pill">${f.monthLabelFromKey(s.month)}</span></h1>
<div class="actions"><a class="btn" href="command:claudeUsage.showDetails">Dashboard</a><a class="btn" href="command:claudeUsage.wasteReport">Waste report</a><a class="btn primary" href="command:claudeUsage.refresh">Refresh</a></div></div>
<section class="card"><div class="kpis">
<div><div class="v">${f.usd(s.totalUsd)}</div><div class="k">Spent this month</div><div class="n">${Math.floor(d.pct)}% of ${f.usdWhole(d.budget)}</div></div>
<div><div class="v">${f.count(t.live)}</div><div class="k">Live sessions</div><div class="n">${f.count(t.waiting)} waiting on you · ${f.count(t.active)} active</div></div>
<div><div class="v">${f.count(t.projects)}</div><div class="k">Projects</div><div class="n">${f.count(t.sessions)} sessions this month</div></div>
<div><div class="v">${f.usd(t.flaggedUsd)}</div><div class="k">Money-burner flags</div><div class="n">${f.count(t.flaggedSessions)} sessions · estimate</div></div>
</div></section>
${liveCard(hub, now)}
${handoffsCard(o.handoffs, now, o.handoffHook)}
${projectsCard(hub, now)}
${sessionsCard(hub, now)}
<footer>
<p><b>State</b> ${H}: <b>active</b> = Claude is working (a prompt or tool result in the last 10 minutes, or a tool call under 2 minutes old); <b>waiting on you</b> = Claude finished its turn, or a tool call has waited over 2 minutes (usually a permission prompt), within the last hour; <b>idle</b> = everything older. Rows from this window's folders are marked.</p>
<p><b>Flags</b> ${H}: context at or over ${f.tokensK(hub.ctxThreshold)} (or requests above it this month), restarts after the cache expired, and routine requests on a model with a cheaper sibling. Same rules as the Waste Report.</p>
<p>Estimate from local Claude Code logs, not your invoice. Last updated ${f.clock(now)} · nothing leaves your machine.</p>
</footer>`;
  return docShell('Claude Usage: Orchestration Hub', nonce, body);
}

module.exports = { render, ago };
