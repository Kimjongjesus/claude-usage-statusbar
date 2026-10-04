'use strict';
// Themed dashboard HTML. Pure string output: no scripts, no remote resources, no inline
// style attributes. The CSP only allows a single nonce'd <style> block. Colors come from
// VS Code's theme variables so light, dark and high-contrast all work.
const f = require('./format');
const { topN, mergeModels } = require('./metrics');

const CSS = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 20px 24px 40px; color: var(--vscode-foreground); background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.45; }
main { max-width: 980px; margin: 0 auto; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
h1 { font-size: 1.5em; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 10px; }
h2 { font-size: 0.8em; font-weight: 600; margin: 0 0 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
.pill { font-size: 0.55em; font-weight: 500; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent));
  color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background); }
.actions { display: flex; gap: 8px; }
a.btn { text-decoration: none; padding: 4px 12px; border-radius: 4px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-contrastBorder, transparent); }
a.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
a.btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
a.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.card { background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent));
  border-radius: 8px; padding: 16px 18px; margin-bottom: 14px; }
.hero { display: grid; grid-template-columns: 150px 1fr; gap: 22px; align-items: center; }
.ring { width: 150px; height: 150px; }
.ring-bg { fill: none; stroke: var(--vscode-input-background, rgba(128,128,128,.25)); stroke-width: 11; }
.ring-fg { fill: none; stroke-width: 11; stroke-linecap: round; }
.ring-pct { fill: var(--vscode-foreground); font-size: 26px; font-weight: 600; text-anchor: middle; }
.ring-sub { fill: var(--vscode-descriptionForeground); font-size: 10px; text-anchor: middle; }
.ok { stroke: var(--vscode-charts-green, #89d185); } .warn { stroke: var(--vscode-charts-yellow, #cca700); } .crit { stroke: var(--vscode-charts-red, #f14c4c); }
.big { font-size: 2.3em; font-weight: 600; line-height: 1.1; }
.big small { font-size: .5em; font-weight: 400; color: var(--vscode-descriptionForeground); }
.banner { display: inline-block; margin-top: 6px; padding: 2px 10px; border-radius: 4px; font-size: .9em; }
.banner.warn-bg { background: var(--vscode-statusBarItem-warningBackground, #7a5c00); color: var(--vscode-statusBarItem-warningForeground, #fff); }
.banner.crit-bg { background: var(--vscode-statusBarItem-errorBackground, #8a1f1f); color: var(--vscode-statusBarItem-errorForeground, #fff); }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 14px; }
.stat .k { color: var(--vscode-descriptionForeground); font-size: .85em; }
.stat .v { font-size: 1.2em; font-weight: 600; }
.stat .n { color: var(--vscode-descriptionForeground); font-size: .8em; }
.chart { width: 100%; height: auto; display: block; }
.grid { stroke: var(--vscode-panel-border, rgba(128,128,128,.3)); stroke-width: 1; opacity: .6; }
.axis { fill: var(--vscode-descriptionForeground); font-size: 11px; }
.axis.end { text-anchor: end; } .axis.mid { text-anchor: middle; }
.bar { fill: var(--vscode-charts-blue, #3794ff); } .bar.over { fill: var(--vscode-charts-orange, #d18616); }
.bar.today { fill: var(--vscode-charts-purple, #b180d7); }
.bar.zero { fill: var(--vscode-descriptionForeground); opacity: .5; } .bar.future { fill: var(--vscode-descriptionForeground); opacity: .18; }
.pace { stroke: var(--vscode-charts-yellow, #cca700); stroke-width: 1.5; stroke-dasharray: 5 4; fill: none; }
.budget { stroke: var(--vscode-charts-red, #f14c4c); stroke-width: 1.5; fill: none; }
.line { stroke: var(--vscode-charts-blue, #3794ff); stroke-width: 2.5; fill: none; stroke-linejoin: round; }
.area { fill: var(--vscode-charts-blue, #3794ff); opacity: .15; }
.proj { stroke: var(--vscode-charts-green, #89d185); stroke-width: 2; stroke-dasharray: 6 4; fill: none; }
.proj.over { stroke: var(--vscode-charts-orange, #d18616); }
.dot { fill: var(--vscode-charts-blue, #3794ff); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: .85em; }
.sw { display: inline-block; width: 18px; height: 0; border-top: 2px solid; margin-right: 6px; vertical-align: middle; }
.sw.pace-sw { border-color: var(--vscode-charts-yellow, #cca700); border-top-style: dashed; }
.sw.budget-sw { border-color: var(--vscode-charts-red, #f14c4c); }
.sw.proj-sw { border-color: var(--vscode-charts-green, #89d185); border-top-style: dashed; }
.sw.line-sw { border-color: var(--vscode-charts-blue, #3794ff); }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.cols .card { margin-bottom: 14px; }
ul.rows { list-style: none; margin: 0; padding: 0; }
ul.rows li { margin-bottom: 11px; }
.rowtop { display: flex; justify-content: space-between; gap: 10px; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.val { white-space: nowrap; font-variant-numeric: tabular-nums; } .val .pct { color: var(--vscode-descriptionForeground); margin-left: 6px; }
.meter { width: 100%; height: 6px; display: block; border-radius: 3px; margin-top: 4px; }
.meter-bg { fill: var(--vscode-input-background, rgba(128,128,128,.25)); }
.meter-fg { fill: var(--vscode-charts-blue, #3794ff); }
.tokens { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.tokens .v { font-size: 1.25em; font-weight: 600; font-variant-numeric: tabular-nums; }
.tokens .k { color: var(--vscode-descriptionForeground); font-size: .85em; }
details { margin: 4px 0 14px; color: var(--vscode-descriptionForeground); font-size: .9em; }
summary { cursor: pointer; } table.hist { border-collapse: collapse; margin-top: 6px; }
table.hist td { padding: 2px 18px 2px 0; font-variant-numeric: tabular-nums; }
.empty { color: var(--vscode-descriptionForeground); }
footer { color: var(--vscode-descriptionForeground); font-size: .85em; margin-top: 18px; }
footer p { margin: 4px 0; }
@media (max-width: 720px) { .hero { grid-template-columns: 1fr; justify-items: center; text-align: center; } .stats { grid-template-columns: repeat(2, 1fr); text-align: left; }
  .cols { grid-template-columns: 1fr; } .tokens { grid-template-columns: repeat(2, 1fr); } }
`;

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
const r1 = (n) => Math.round(n * 10) / 10;

function ring(d) {
  const R = 52, C = 2 * Math.PI * R;
  const len = Math.min(1, Math.max(0, d.pct / 100)) * C;
  return `<svg class="ring" viewBox="0 0 120 120" role="img" aria-label="${Math.floor(d.pct)} percent of budget used">
<circle class="ring-bg" cx="60" cy="60" r="${R}"/>
<circle class="ring-fg ${d.level}" cx="60" cy="60" r="${R}" stroke-dasharray="${len.toFixed(2)} ${(C - len + 1).toFixed(2)}" transform="rotate(-90 60 60)"/>
<text class="ring-pct" x="60" y="66">${Math.floor(d.pct)}%</text>
<text class="ring-sub" x="60" y="82">of budget</text></svg>`;
}

const W = 720, H = 230, PL = 56, PR = 16, PT = 14, PB = 26;
const PW = W - PL - PR, PH = H - PT - PB;

function dailyChart(s, d) {
  const dim = s.daysInMonth;
  const maxDaily = Math.max(...s.daily, 0);
  const mx = Math.max(maxDaily, d.evenPaceDaily * 1.15, 1);
  const step = niceStep(mx / 4);
  const yMax = step * Math.ceil(mx / step);
  const y = (v) => PT + PH - (v / yMax) * PH;
  const slot = PW / dim, bw = slot * 0.66;
  const o = [`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily spend this month">`];
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    o.push(`<line class="grid" x1="${PL}" x2="${W - PR}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>`);
    o.push(`<text class="axis end" x="${PL - 8}" y="${r1(y(v) + 4)}">${f.usdWhole(v)}</text>`);
  }
  for (let i = 0; i < dim; i++) {
    const v = s.daily[i], x = PL + i * slot + (slot - bw) / 2;
    const date = `${f.monthName(s.monthIndex).slice(0, 3)} ${i + 1}`;
    let cls = 'bar', h = (v / yMax) * PH;
    if (i + 1 > s.dayOfMonth) { cls = 'bar future'; h = 2; }
    else if (v <= 0) { cls = 'bar zero'; h = 1.5; }
    else if (i + 1 === s.dayOfMonth) cls = 'bar today';
    else if (v > d.evenPaceDaily) cls = 'bar over';
    o.push(`<rect class="${cls}" x="${r1(x)}" y="${r1(PT + PH - h)}" width="${r1(bw)}" height="${r1(h)}" rx="2"><title>${date}: ${i + 1 > s.dayOfMonth ? 'upcoming' : f.usd(v)}</title></rect>`);
    if (i === 0 || (i + 1) % 5 === 0 || i + 1 === dim) {
      o.push(`<text class="axis mid" x="${r1(x + bw / 2)}" y="${H - 8}">${i + 1}</text>`);
    }
  }
  o.push(`<line class="pace" x1="${PL}" x2="${W - PR}" y1="${r1(y(d.evenPaceDaily))}" y2="${r1(y(d.evenPaceDaily))}"/>`);
  o.push('</svg>');
  return o.join('\n') + `<div class="legend"><span><i class="sw pace-sw"></i>Even pace ${f.usd(d.evenPaceDaily)}/day</span>` +
    '<span>Orange bars are above that pace; purple is today.</span></div>';
}

function paceChart(s, d) {
  const dim = s.daysInMonth;
  const proj = d.projected;
  const mx = Math.max(d.budget, proj || 0, s.totalUsd) * 1.05;
  const step = niceStep(mx / 4);
  const yMax = step * Math.ceil(mx / step);
  const x = (day) => PL + (day / dim) * PW;
  const y = (v) => PT + PH - (v / yMax) * PH;
  const pts = [[0, 0]];
  let run = 0;
  for (let i = 0; i < s.dayOfMonth - 1; i++) { run += s.daily[i]; pts.push([i + 1, run]); }
  pts.push([Math.min(dim, s.elapsedDays), s.totalUsd]);
  const poly = pts.map(([dx, v]) => `${r1(x(dx))},${r1(y(v))}`).join(' ');
  const last = pts[pts.length - 1];
  const o = [`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative spend, projection and budget">`];
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    o.push(`<line class="grid" x1="${PL}" x2="${W - PR}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>`);
    o.push(`<text class="axis end" x="${PL - 8}" y="${r1(y(v) + 4)}">${f.usdWhole(v)}</text>`);
  }
  for (let day = 1; day <= dim; day++) {
    if (day === 1 || day % 5 === 0 || day === dim) o.push(`<text class="axis mid" x="${r1(x(day - 0.5))}" y="${H - 8}">${day}</text>`);
  }
  o.push(`<polygon class="area" points="${r1(x(0))},${r1(y(0))} ${poly} ${r1(x(last[0]))},${r1(y(0))}"/>`);
  o.push(`<line class="budget" x1="${PL}" x2="${W - PR}" y1="${r1(y(d.budget))}" y2="${r1(y(d.budget))}"/>`);
  o.push(`<text class="axis" x="${PL + 6}" y="${r1(y(d.budget) - 5)}">Budget ${f.usdWhole(d.budget)}</text>`);
  o.push(`<polyline class="line" points="${poly}"/>`);
  if (proj !== null) {
    o.push(`<line class="proj${proj > d.budget ? ' over' : ''}" x1="${r1(x(last[0]))}" y1="${r1(y(last[1]))}" x2="${r1(x(dim))}" y2="${r1(y(proj))}"/>`);
    o.push(`<text class="axis end" x="${W - PR}" y="${r1(Math.max(PT + 10, y(proj) - 7))}">≈ ${f.usdWhole(proj)}</text>`);
  }
  o.push(`<circle class="dot" cx="${r1(x(last[0]))}" cy="${r1(y(last[1]))}" r="4"/>`);
  o.push('</svg>');
  return o.join('\n') + '<div class="legend"><span><i class="sw line-sw"></i>Spent so far</span>' +
    '<span><i class="sw proj-sw"></i>Projected at current pace</span><span><i class="sw budget-sw"></i>Budget</span></div>';
}

function rows(items, titleFn) {
  if (!items.length) return '<p class="empty">Nothing logged this month yet.</p>';
  const max = items[0].usd || 1;
  return '<ul class="rows">' + items.map((it) => {
    const w = Math.max(1, (it.usd / max) * 100);
    return `<li><div class="rowtop"><span class="name" title="${f.escHtml(titleFn ? titleFn(it) : it.name)}">${f.escHtml(it.name)}</span>` +
      `<span class="val">${f.usd(it.usd)}<span class="pct">${it.share.toFixed(0)}%</span></span></div>` +
      `<svg class="meter" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="meter-bg" width="100" height="6"/><rect class="meter-fg" width="${r1(w)}" height="6"/></svg></li>`;
  }).join('') + '</ul>';
}

function render(s, d, opts) {
  const o = opts || {};
  const nonce = o.nonce || 'nonce';
  const updated = o.updatedAt || new Date();
  const hist = Object.entries(o.history || {}).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 6);
  const t = s.tokens;
  const resets = f.monthName(d.resetsOn.getMonth()) + ' ' + d.resetsOn.getDate();
  const banner = d.level === 'ok' ? '' :
    `<div class="banner ${d.level === 'crit' ? 'crit-bg' : 'warn-bg'}">${d.level === 'crit' ? 'Critical' : 'Warning'}: ${Math.floor(d.pct)}% of budget used${d.overBudget ? ' (over budget)' : ''}</div>`;
  const projText = d.projected === null ? 'Needs a full day of data' : f.usdWhole(d.projected) + (d.projected > d.budget ? ' (over budget)' : '');
  const models = topN(mergeModels(s.byModel), 8);
  const projects = topN(s.byProject, 8);
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Usage</title>
<style nonce="${nonce}">${CSS}</style></head>
<body><main>
<div class="head"><h1>Claude Usage <span class="pill">${f.monthLabelFromKey(s.month)}</span></h1>
<div class="actions"><a class="btn" href="command:claudeUsage.refresh">Refresh</a><a class="btn primary" href="command:claudeUsage.setBudget">Set budget</a></div></div>

<section class="card hero">${ring(d)}
<div><div class="big">${f.usd(s.totalUsd)} <small>of ${f.usdWhole(d.budget)} this month</small></div>${banner}
<div class="stats">
<div class="stat"><div class="k">Remaining</div><div class="v">${f.usd(d.remaining)}</div></div>
<div class="stat"><div class="k">Projected month end</div><div class="v">${projText}</div></div>
<div class="stat"><div class="k">Safe daily spend</div><div class="v">${f.usd(d.safeDaily)}</div><div class="n">per day, from today</div></div>
<div class="stat"><div class="k">Days left</div><div class="v">${d.daysLeft}</div><div class="n">resets ${resets}</div></div>
</div></div></section>

<section class="card"><h2>Daily spend</h2>${dailyChart(s, d)}</section>
<section class="card"><h2>Pace vs budget</h2>${paceChart(s, d)}</section>

<div class="cols">
<section class="card"><h2>By model</h2>${rows(models, (it) => it.name)}</section>
<section class="card"><h2>By project</h2>${rows(projects)}</section>
</div>

<section class="card"><h2>Tokens this month</h2><div class="tokens">
<div><div class="v" title="${f.count(t.input)}">${f.compact(t.input)}</div><div class="k">Input</div></div>
<div><div class="v" title="${f.count(t.output)}">${f.compact(t.output)}</div><div class="k">Output</div></div>
<div><div class="v" title="${f.count(t.cacheWrite)}">${f.compact(t.cacheWrite)}</div><div class="k">Cache write</div></div>
<div><div class="v" title="${f.count(t.cacheRead)}">${f.compact(t.cacheRead)}</div><div class="k">Cache read</div></div>
<div><div class="v">${f.count(s.messages)}</div><div class="k">Messages</div></div>
</div></section>
${hist.length ? `<details><summary>Previous months</summary><table class="hist">${hist.map(([k, v]) => `<tr><td>${f.monthLabelFromKey(k)}</td><td>${f.usd(v)}</td></tr>`).join('')}</table></details>` : ''}
<footer>
<p>Estimate from local Claude Code logs using a built-in price table, not your Anthropic invoice. Spend resets on the 1st of each month (local time).</p>
${s.assumedModels.length ? `<p>Unknown pricing, Sonnet rates assumed for: ${s.assumedModels.map(f.escHtml).join(', ')}</p>` : ''}
<p>Last updated ${f.clock(updated)}${s.lastMessageAt ? ` · last Claude message ${f.monthName(s.lastMessageAt.getMonth()).slice(0, 3)} ${s.lastMessageAt.getDate()} ${f.clock(s.lastMessageAt).slice(0, 5)}` : ''} · nothing leaves your machine.</p>
<p>Scanned: ${s.dirs.length ? s.dirs.map(f.escHtml).join(', ') : 'no Claude Code projects folder found'}</p>
</footer>
</main></body></html>`;
}

module.exports = { render, CSS };
