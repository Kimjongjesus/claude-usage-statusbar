'use strict';
// Status bar text and hover markdown. Pure functions: no vscode import, so they are unit-testable.
const f = require('./format');
const { topN, mergeModels } = require('./metrics');
const { branchLabel } = require('./sessions');

const ICON = { ok: '$(pulse)', warn: '$(warning)', crit: '$(error)' };

function statusText(s, d, ctx) {
  const base = `${ICON[d.level]} ${f.usdShort(s.totalUsd)} ${f.bar(d.pct, 5)} ${Math.floor(d.pct)}%`;
  // Context hint only when the current session's context is large (ctx = { show, tokens }).
  return ctx && ctx.show ? `${base} · ctx ${f.tokensK(ctx.tokens)}` : base;
}

// Truncate (never round up) so the hover agrees with the status bar and the dashboard ring.
function pctText(p) { return p < 10 ? (Math.floor(p * 10) / 10).toFixed(1) : String(Math.floor(p)); }

function resetLabel(d) { return f.monthName(d.resetsOn.getMonth()) + ' ' + d.resetsOn.getDate(); }

function tooltipMarkdown(s, d, opts) {
  const o = opts || {};
  const L = [];
  L.push(`## ${f.usd(s.totalUsd)} / ${f.usdWhole(d.budget)}`);
  L.push('');
  L.push(`\`${f.bar(d.pct, 20, f.BLOCKS)}\` **${pctText(d.pct)}%** used`);
  L.push('');
  const proj = d.projected === null ? '_needs a full day of data_'
    : f.usdWhole(d.projected) + (d.projected > d.budget ? ' ⚠ over budget' : '');
  L.push(`| ${f.monthLabelFromKey(s.month)} | |`);
  L.push('|:--|--:|');
  L.push(`| Remaining | **${f.usd(d.remaining)}** |`);
  L.push(`| Projected month end | ${proj} |`);
  L.push(`| Safe daily spend | ${f.usd(d.safeDaily)} / day |`);
  L.push(`| Days left | ${d.daysLeft} (resets ${resetLabel(d)}) |`);
  const models = topN(mergeModels(s.byModel), 3);
  if (models.length) {
    L.push('');
    L.push('| Top models | Spend |');
    L.push('|:--|--:|');
    for (const m of models) L.push(`| ${f.escMd(m.name)} | ${f.usd(m.usd)} · ${m.share.toFixed(0)}% |`);
  }
  const c = o.context;
  if (c && c.session) {
    const x = c.session, i = c.info;
    L.push('');
    L.push(`| ${c.active ? 'This session' : 'Last session'} | |`);
    L.push('|:--|--:|');
    L.push(`| ${f.escMd(f.ellipsize(x.title || [x.project, branchLabel(x.branch)].filter(Boolean).join(' · ') || x.sid.slice(0, 8), 40))} | **${f.usd(x.usd)}** |`);
    L.push(`| Context | ${f.tokensK(i.tokens)} / ${f.tokensK(i.window)} · ${Math.floor(i.pct)}% |`);
    if (c.advice) { L.push(''); L.push(`⚠ ${f.escMd(c.advice)}`); }
  }
  if (s.assumedModels.length) {
    L.push('');
    L.push(`⚠ Unknown pricing, assumed Sonnet rates: ${s.assumedModels.map(f.escMd).join(', ')}`);
  }
  if (!s.dirs.length) {
    L.push('');
    L.push('⚠ No Claude Code logs found yet. Looked in `~/.claude/projects`; add more under the `claudeUsage.dataDirs` setting.');
  }
  L.push('');
  L.push('_Estimate from local logs. Resets on the 1st (local time)._');
  if (o.links) {
    L.push('');
    L.push('[Open dashboard](command:claudeUsage.showDetails) · [Hub](command:claudeUsage.showHub) · [Waste report](command:claudeUsage.wasteReport) · [Set budget](command:claudeUsage.setBudget) · [Refresh](command:claudeUsage.refresh)');
  }
  return L.join('\n');
}

module.exports = { statusText, tooltipMarkdown, ICON };
