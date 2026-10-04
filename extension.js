'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const { summarize, defaultDirs } = require('./lib/usage');
const { derive, msToNextMidnight, decideNotification } = require('./lib/metrics');
const { statusText, tooltipMarkdown } = require('./lib/tooltip');
const { render } = require('./lib/dashboard');
const { watchDirs } = require('./lib/watch');
const f = require('./lib/format');

const OWN_COMMANDS = ['claudeUsage.showDetails', 'claudeUsage.setBudget', 'claudeUsage.refresh'];
let ctx, item, panel, last, timer, midnight, watcher, watchedKey = '', renderSig = '', renderedAt = 0;
let clock = () => new Date(); // replaced in tests so the month boundary can be simulated

function num(v, d) { return Number.isFinite(v) && v > 0 ? v : d; }
function cfg() {
  const c = vscode.workspace.getConfiguration('claudeUsage');
  const warn = num(c.get('warnAtPercent', 75), 75);
  return {
    budget: num(c.get('monthlyBudgetUsd', 1000), 1000), warn, crit: Math.max(warn, num(c.get('criticalAtPercent', 90), 90)),
    dataDirs: c.get('dataDirs', []), pricingOverrides: c.get('pricingOverrides', {}), secs: num(c.get('refreshSeconds', 30), 30),
    notify: c.get('notifyOnThresholds', true),
  };
}

function refresh(force) {
  if (!item) return;
  const c = cfg();
  const now = clock();
  try {
    const s = summarize({ now, dataDirs: c.dataDirs, pricingOverrides: c.pricingOverrides });
    const d = derive(s, c);
    last = { s, d, c, now };
    item.text = statusText(s, d);
    item.backgroundColor = d.level === 'crit' ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : d.level === 'warn' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const md = new vscode.MarkdownString(tooltipMarkdown(s, d, { links: true }), true);
    md.isTrusted = { enabledCommands: OWN_COMMANDS };
    item.tooltip = md;
    saveHistory(s);
    maybeNotify(s, d, c);
    // Re-render the dashboard only when something changed (re-setting html resets scroll).
    const sig = [s.month, s.totalUsd.toFixed(4), s.messages, c.budget, c.warn, c.crit].join('|');
    if (force === true || sig !== renderSig || now - renderedAt > 5 * 60 * 1000) { renderSig = sig; renderedAt = +now; renderPanel(); }
    rewatchIfNeeded(s.dirs, c);
  } catch (e) {
    item.text = '$(warning) Claude usage: error';
    item.backgroundColor = undefined;
    item.tooltip = String((e && e.message) || e);
  }
}

// Past-month totals the extension has seen, so they survive log cleanup. Secondary only:
// never added to the current month.
function savedHistory() { return ctx.globalState.get('monthTotals', {}); }
function saveHistory(s) {
  const hist = Object.assign({}, savedHistory());
  let changed = false;
  for (const [k, v] of Object.entries(s.history)) if (!(hist[k] >= v)) { hist[k] = v; changed = true; }
  if (changed) ctx.globalState.update('monthTotals', hist);
}
function mergedHistory(s) {
  const out = Object.assign({}, savedHistory());
  for (const [k, v] of Object.entries(s.history)) if (!(out[k] >= v)) out[k] = v;
  for (const k of Object.keys(out)) if (k >= s.month) delete out[k];
  return out;
}

function maybeNotify(s, d, c) {
  if (!c.notify) return;
  const res = decideNotification(d.pct, c.warn, c.crit, s.month, ctx.globalState.get('thresholdNotified'));
  if (!res.level) return;
  ctx.globalState.update('thresholdNotified', res.state); // persist first: never notify twice
  const msg = `Claude Code spend is at ${Math.floor(d.pct)}% of your ${f.usdWhole(d.budget)} budget for ${f.monthLabelFromKey(s.month)} (${f.usd(s.totalUsd)}).`;
  const show = res.level === 'crit' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
  Promise.resolve(show(msg, 'Open Dashboard', 'Set Budget')).then((pick) => {
    if (pick === 'Open Dashboard') showDashboard();
    else if (pick === 'Set Budget') promptBudget();
  }, () => {});
}

function html() {
  const { s, d, now } = last;
  const nonce = crypto.randomBytes(16).toString('base64');
  return render(s, d, { nonce, updatedAt: now, history: mergedHistory(s) });
}
function renderPanel() { if (panel && last) panel.webview.html = html(); }

function showDashboard() {
  if (!last) refresh();
  if (!last) return;
  if (panel) { panel.reveal(); renderPanel(); return; }
  panel = vscode.window.createWebviewPanel('claudeUsage', 'Claude Usage', vscode.ViewColumn.Active,
    { enableScripts: false, enableCommandUris: ['claudeUsage.setBudget', 'claudeUsage.refresh'], localResourceRoots: [] });
  panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
  renderPanel();
}

async function promptBudget() {
  const cur = cfg().budget;
  const v = await vscode.window.showInputBox({
    title: 'Claude Usage: Monthly Budget',
    prompt: 'Monthly Claude budget in USD. Spend is counted from the 1st of each month (local time).',
    value: String(cur),
    validateInput: (t) => (Number.isFinite(Number(t)) && Number(t) >= 1 ? undefined : 'Enter a number of at least 1'),
  });
  if (v === undefined) return false;
  await vscode.workspace.getConfiguration('claudeUsage').update('monthlyBudgetUsd', Number(v), vscode.ConfigurationTarget.Global);
  refresh(true);
  return true;
}

async function firstRun() {
  if (ctx.globalState.get('budgetConfirmed')) return;
  const insp = vscode.workspace.getConfiguration('claudeUsage').inspect('monthlyBudgetUsd');
  const explicit = insp && (insp.globalValue !== undefined || insp.workspaceValue !== undefined);
  if (!explicit) await promptBudget();
  await ctx.globalState.update('budgetConfirmed', true);
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, Math.max(5, cfg().secs) * 1000);
  scheduleMidnight();
}
// Roll over on the 1st without waiting for the next poll (and without a restart).
function scheduleMidnight() {
  if (midnight) clearTimeout(midnight);
  midnight = setTimeout(() => { refresh(); scheduleMidnight(); }, msToNextMidnight(clock()));
}

function rewatchIfNeeded(dirs, c) {
  const key = dirs.join('|');
  if (key === watchedKey && watcher) return;
  watchedKey = key;
  if (watcher) watcher.dispose();
  watcher = watchDirs(dirs.length ? dirs : defaultDirs(c.dataDirs), refresh, 3000);
}

function activate(context) {
  ctx = context;
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'Claude Usage';
  item.command = 'claudeUsage.showDetails';
  item.text = '$(pulse) Claude…';
  item.show();
  ctx.subscriptions.push(item,
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(true)),
    vscode.commands.registerCommand('claudeUsage.showDetails', showDashboard),
    vscode.commands.registerCommand('claudeUsage.setBudget', promptBudget),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage')) { watchedKey = ''; refresh(true); schedule(); }
    }),
    { dispose() { deactivate(); } });
  refresh();
  schedule();
  firstRun().catch(() => {});
}

function deactivate() {
  if (timer) clearInterval(timer);
  if (midnight) clearTimeout(midnight);
  if (watcher) watcher.dispose();
  timer = midnight = watcher = undefined;
  watchedKey = '';
}

module.exports = {
  activate, deactivate,
  _test: { setClock(fn) { clock = fn; }, refresh, state: () => ({ item, panel, last }) },
};
