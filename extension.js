'use strict';
const vscode = require('vscode');
const { summarize, defaultDirs } = require('./lib/usage');

let item, timer, last, channel;
const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function cfg() {
  const c = vscode.workspace.getConfiguration('claudeUsage');
  return {
    budget: c.get('monthlyBudgetUsd', 1000), warn: c.get('warnAtPercent', 75), crit: c.get('criticalAtPercent', 90),
    dataDirs: c.get('dataDirs', []), pricingOverrides: c.get('pricingOverrides', {}), secs: c.get('refreshSeconds', 30),
  };
}

function top(obj, n) { return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n); }

function refresh(ctx) {
  const c = cfg();
  try {
    const s = summarize({ dataDirs: c.dataDirs, pricingOverrides: c.pricingOverrides });
    last = { s, c };
    const pct = (s.totalUsd / c.budget) * 100;
    item.text = `$(graph) ${fmt(s.totalUsd)} / ${fmt(c.budget)} (${pct.toFixed(0)}%)`;
    item.backgroundColor = pct >= c.crit ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : pct >= c.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Claude Code, ${s.month}**\n\n`);
    md.appendMarkdown(`Spent: ${fmt(s.totalUsd)} of ${fmt(c.budget)} (${pct.toFixed(1)}%)  \n`);
    md.appendMarkdown(`Remaining: ${fmt(Math.max(0, c.budget - s.totalUsd))}  \n`);
    md.appendMarkdown(`Projected month end: ${fmt(s.projectedUsd)}  \n`);
    const left = s.daysInMonth - s.dayOfMonth + 1;
    md.appendMarkdown(`Safe daily spend from now: ${fmt(Math.max(0, c.budget - s.totalUsd) / left)}/day (${left} days left)\n\n`);
    md.appendMarkdown('_Estimate from local logs. Click for breakdown._');
    if (s.assumedModels.length) md.appendMarkdown(`\n\n⚠ Unknown pricing, assumed Sonnet rates: ${s.assumedModels.join(', ')}`);
    item.tooltip = md;
    // Persist month totals so history survives log cleanup.
    const hist = ctx.globalState.get('monthTotals', {});
    if (!hist[s.month] || s.totalUsd >= hist[s.month]) { hist[s.month] = s.totalUsd; ctx.globalState.update('monthTotals', hist); }
  } catch (e) {
    item.text = '$(warning) Claude usage: error';
    item.tooltip = String(e && e.message || e);
  }
}

function showDetails(ctx) {
  if (!last) refresh(ctx);
  const { s, c } = last;
  channel.clear();
  channel.appendLine(`Claude Code usage, ${s.month}  (estimate from local logs)`);
  channel.appendLine(`Total ${fmt(s.totalUsd)} / ${fmt(c.budget)}   projected ${fmt(s.projectedUsd)}   messages ${s.messages}`);
  channel.appendLine(`Tokens: in ${s.tokens.input}  out ${s.tokens.output}  cache-write ${s.tokens.cacheWrite}  cache-read ${s.tokens.cacheRead}`);
  channel.appendLine('\nBy model:'); for (const [k, v] of top(s.byModel, 20)) channel.appendLine(`  ${fmt(v).padStart(12)}  ${k}`);
  channel.appendLine('\nBy project:'); for (const [k, v] of top(s.byProject, 15)) channel.appendLine(`  ${fmt(v).padStart(12)}  ${k}`);
  channel.appendLine('\nBy day:'); for (const k of Object.keys(s.byDay).sort()) channel.appendLine(`  ${k}  ${fmt(s.byDay[k]).padStart(12)}`);
  const hist = ctx.globalState.get('monthTotals', {});
  channel.appendLine('\nPast months (saved by this extension):');
  for (const k of Object.keys(hist).sort()) channel.appendLine(`  ${k}  ${fmt(hist[k]).padStart(12)}`);
  channel.appendLine('\nScanned: ' + (defaultDirs(c.dataDirs).join(', ') || '(no Claude projects dir found)'));
  channel.show(true);
}

function schedule(ctx) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => refresh(ctx), Math.max(5, cfg().secs) * 1000);
}

function activate(ctx) {
  channel = vscode.window.createOutputChannel('Claude Usage');
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'claudeUsage.showDetails';
  item.text = '$(graph) Claude…';
  item.show();
  ctx.subscriptions.push(item, channel,
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(ctx)),
    vscode.commands.registerCommand('claudeUsage.showDetails', () => showDetails(ctx)),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('claudeUsage')) { refresh(ctx); schedule(ctx); } }),
    { dispose() { if (timer) clearInterval(timer); } });
  refresh(ctx); schedule(ctx);
}
function deactivate() { if (timer) clearInterval(timer); }
module.exports = { activate, deactivate };
