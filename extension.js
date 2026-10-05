'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { summarize, defaultDirs } = require('./lib/usage');
const { derive, msToNextMidnight, decideNotification } = require('./lib/metrics');
const { statusText, tooltipMarkdown } = require('./lib/tooltip');
const { render } = require('./lib/dashboard');
const { render: renderWaste } = require('./lib/waste-view');
const { analyze } = require('./lib/waste');
const { pickActive, ctxInfo, adviceText } = require('./lib/sessions');
const hooksInstall = require('./lib/hooks-install');
const { watchDirs } = require('./lib/watch');
const f = require('./lib/format');

const OWN_COMMANDS = ['claudeUsage.showDetails', 'claudeUsage.setBudget', 'claudeUsage.refresh', 'claudeUsage.wasteReport'];
let ctx, item, panel, wastePanel, last, timer, midnight, watcher, watchedKey = '', renderSig = '', renderedAt = 0;
let clock = () => new Date(); // replaced in tests so the month boundary can be simulated

function num(v, d) { return Number.isFinite(v) && v > 0 ? v : d; }
function cfg() {
  const c = vscode.workspace.getConfiguration('claudeUsage');
  const warn = num(c.get('warnAtPercent', 75), 75);
  const nudge = c.get('contextNudgeAt', 150000);
  return {
    budget: num(c.get('monthlyBudgetUsd', 1000), 1000), warn, crit: Math.max(warn, num(c.get('criticalAtPercent', 90), 90)),
    dataDirs: c.get('dataDirs', []), pricingOverrides: c.get('pricingOverrides', {}), secs: num(c.get('refreshSeconds', 30), 30),
    notify: c.get('notifyOnThresholds', true),
    ctxWindow: num(c.get('contextWindow', 200000), 200000),
    ctxNudge: Number.isFinite(nudge) && nudge >= 0 ? nudge : 150000, // 0 turns the one-time context notice off
    ctxHintPct: num(c.get('contextHintAtPercent', 50), 50),
  };
}

function workspaceDirs() {
  const folders = (vscode.workspace && vscode.workspace.workspaceFolders) || [];
  return folders.map((w) => w && w.uri && w.uri.fsPath).filter(Boolean);
}

// Current session + its context size. Assumptions are documented in the README ("How it finds your current session").
function contextState(s, c, now) {
  const pick = pickActive(s.sessions, { workspaceDirs: workspaceDirs(), now });
  if (!pick) return null;
  const info = ctxInfo(pick.session, { window: c.ctxWindow, pricingOverrides: c.pricingOverrides });
  const big = pick.active && info.pct >= c.ctxHintPct;
  return { session: pick.session, info, active: pick.active, inWorkspace: pick.inWorkspace, nudgeAt: c.ctxNudge, advice: adviceText(info), show: big };
}

function refresh(force) {
  if (!item) return;
  const c = cfg();
  const now = clock();
  try {
    const s = summarize({ now, dataDirs: c.dataDirs, pricingOverrides: c.pricingOverrides });
    const d = derive(s, c);
    const cx = contextState(s, c, now);
    last = { s, d, c, now, cx };
    item.text = statusText(s, d, cx && { show: cx.show, tokens: cx.info.tokens });
    item.backgroundColor = d.level === 'crit' ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : d.level === 'warn' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    const md = new vscode.MarkdownString(tooltipMarkdown(s, d, { links: true, context: cx && Object.assign({}, cx, { advice: cx.show ? cx.advice : '' }) }), true);
    md.isTrusted = { enabledCommands: OWN_COMMANDS };
    item.tooltip = md;
    saveHistory(s);
    maybeNotify(s, d, c);
    maybeNudge(cx, c);
    // Re-render the panels only when something changed (re-setting html resets scroll).
    const sig = [s.month, s.totalUsd.toFixed(4), s.messages, c.budget, c.warn, c.crit, c.ctxWindow, c.ctxNudge].join('|');
    if (force === true || sig !== renderSig || now - renderedAt > 5 * 60 * 1000) { renderSig = sig; renderedAt = +now; renderPanel(); renderWastePanel(); }
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

// One notice per session, ever: the session id is stored BEFORE the message is shown, so a refresh, a
// restart or a second window can never repeat it. Only for a session Claude wrote to in the last hour.
function maybeNudge(cx, c) {
  if (!cx || !cx.active || !(c.ctxNudge > 0) || cx.info.tokens < c.ctxNudge) return;
  const done = ctx.globalState.get('contextNudged', []);
  if (done.includes(cx.session.sid)) return;
  ctx.globalState.update('contextNudged', done.concat(cx.session.sid).slice(-200));
  const msg = `This session's context is ${f.tokensK(cx.info.tokens)} tokens (${Math.floor(cx.info.pct)}% of ${f.tokensK(cx.info.window)}). ${cx.advice}`;
  Promise.resolve(vscode.window.showInformationMessage(msg, 'Open Waste Report', 'Dismiss')).then((pick) => {
    if (pick === 'Open Waste Report') showWaste();
  }, () => {});
}

function html() {
  const { s, d, now, cx } = last;
  const nonce = crypto.randomBytes(16).toString('base64');
  return render(s, d, { nonce, updatedAt: now, history: mergedHistory(s), context: cx });
}
function renderPanel() { if (panel && last) panel.webview.html = html(); }

function wasteHtml() {
  const { s, d, now, c } = last;
  const nonce = crypto.randomBytes(16).toString('base64');
  const rep = analyze(s, { pricingOverrides: c.pricingOverrides, ctxThreshold: c.ctxNudge > 0 ? c.ctxNudge : 150000 });
  return renderWaste(s, d, rep, { nonce, updatedAt: now });
}
function renderWastePanel() { if (wastePanel && last) wastePanel.webview.html = wasteHtml(); }

function showDashboard() {
  if (!last) refresh();
  if (!last) return;
  if (panel) { panel.reveal(); renderPanel(); return; }
  panel = vscode.window.createWebviewPanel('claudeUsage', 'Claude Usage', vscode.ViewColumn.Active,
    { enableScripts: false, enableCommandUris: ['claudeUsage.setBudget', 'claudeUsage.refresh', 'claudeUsage.wasteReport'], localResourceRoots: [] });
  panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
  renderPanel();
}

function showWaste() {
  if (!last) refresh();
  if (!last) return;
  if (wastePanel) { wastePanel.reveal(); renderWastePanel(); return; }
  wastePanel = vscode.window.createWebviewPanel('claudeUsageWaste', 'Claude Usage: Waste Report', vscode.ViewColumn.Active,
    { enableScripts: false, enableCommandUris: ['claudeUsage.showDetails', 'claudeUsage.refresh', 'claudeUsage.installHooks'], localResourceRoots: [] });
  wastePanel.onDidDispose(() => { wastePanel = undefined; }, null, ctx.subscriptions);
  renderWastePanel();
}

// ---- Install Token-Saver Hooks -------------------------------------------------------------------------
// Nothing is written until the user picks an install option AND confirms in a modal that lists every file.
function previewMarkdown(p) {
  return `# Claude Usage: Token-Saver Hooks

These are **opt-in** Claude Code hooks written in Node (they run the same on Windows, macOS and Linux). This page is a preview: **nothing has been written to disk.**

| Hook | Event | What it does |
|:--|:--|:--|
| guard-reads.js | PreToolUse (Read, Grep, Glob) | Blocks node_modules/dist/build, lockfiles, minified files, binaries and huge files |
| budget-guard.js | UserPromptSubmit | Warns you once per session at ${'75% / 90%'} of the month's budget |
| trim-output.js | PostToolUse (Bash, PowerShell, MCP) | Shortens huge command output before Claude reads it (Read/Grep/Glob output cannot be trimmed by hooks) |

Install copies the scripts to \`${p.dir}\`, backs up your settings file and merges the entries below into it. Your own hooks and permissions are kept.

\`\`\`json
${JSON.stringify(p.snippet, null, 2)}
\`\`\`
`;
}

async function installHooks() {
  const c = cfg();
  const home = os.homedir();
  const wsDir = workspaceDirs()[0];
  const all = { guard: true, budget: true, trim: true };
  const preview = hooksInstall.plan({ home, budget: c.budget, picks: all, scope: 'user' });
  try {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: previewMarkdown(preview) });
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
  } catch { /* the preview is a convenience */ }

  const choice = await vscode.window.showQuickPick([
    { label: '$(copy) Copy the settings snippet', id: 'copy', description: 'writes nothing' },
    { label: '$(copy) Copy the permissions.deny snippet', id: 'copyDeny', description: 'writes nothing' },
    { label: '$(person) Install for my user…', id: 'user', description: 'copies scripts to ~/.claude/token-saver-hooks and merges ~/.claude/settings.json (backup first)' },
    { label: '$(folder) Install for this project only…', id: 'project', description: 'merges .claude/settings.local.json (backup first); needs an open folder' },
  ], { title: 'Install Token-Saver Hooks', placeHolder: 'Nothing is written until you confirm on the next screen' });
  if (!choice) return;
  if (choice.id === 'copy') {
    await vscode.env.clipboard.writeText(JSON.stringify(preview.snippet, null, 2));
    vscode.window.showInformationMessage('Hooks snippet copied. Paste it into your Claude Code settings.json (scripts must exist at the paths shown).');
    return;
  }
  if (choice.id === 'copyDeny') {
    await vscode.env.clipboard.writeText(JSON.stringify({ permissions: { deny: hooksInstall.DENY_RULES } }, null, 2));
    vscode.window.showInformationMessage('permissions.deny snippet copied.');
    return;
  }
  if (choice.id === 'project' && !wsDir) { vscode.window.showWarningMessage('Open a folder first, or choose "Install for my user".'); return; }

  const picked = await vscode.window.showQuickPick([
    { label: 'Read guard (PreToolUse)', id: 'guard', picked: true, description: 'block node_modules, lockfiles, minified, binaries, huge files' },
    { label: 'Budget guard (UserPromptSubmit)', id: 'budget', picked: true, description: `warn at 75% / 90% of ${f.usdWhole(c.budget)}` },
    { label: 'Output trimmer (PostToolUse)', id: 'trim', picked: true, description: 'shorten huge Bash/MCP output' },
    { label: 'permissions.deny rules', id: 'deny', picked: false, description: 'also deny Read of node_modules, lockfiles, minified files' },
  ], { canPickMany: true, title: 'Which parts do you want?', placeHolder: 'Untick anything you do not want' });
  if (!picked || !picked.length) return;
  const picks = { guard: false, budget: false, trim: false, deny: false };
  for (const p of picked) picks[p.id] = true;

  const p = hooksInstall.plan({ home, budget: c.budget, picks, scope: choice.id, workspaceDir: wsDir });
  if (p.error) { vscode.window.showErrorMessage(p.error); return; }
  const lines = [];
  if (p.scripts.length) lines.push(`Copy ${p.scripts.length} scripts and ${p.libs.length} helper files to:\n  ${p.dir}`);
  if (p.backup) lines.push(`Back up your current settings to:\n  ${p.backup}`);
  lines.push(`${p.existed ? 'Update' : 'Create'} (existing hooks and permissions are kept):\n  ${p.file}`);
  const go = await vscode.window.showWarningMessage('Write these files?', { modal: true, detail: lines.join('\n\n') }, 'Write files');
  if (go !== 'Write files') return;
  try {
    const res = hooksInstall.apply(p, (ctx && ctx.extensionPath) || __dirname);
    vscode.window.showInformationMessage(`Token-Saver hooks installed (${res.written.length} files). New Claude Code sessions pick them up. ${p.backup ? 'Backup: ' + path.basename(p.backup) : ''}`);
  } catch (e) {
    vscode.window.showErrorMessage('Install failed: ' + ((e && e.message) || e));
  }
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
    vscode.commands.registerCommand('claudeUsage.wasteReport', showWaste),
    vscode.commands.registerCommand('claudeUsage.installHooks', installHooks),
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
  panel = wastePanel = undefined;
}

module.exports = {
  activate, deactivate,
  _test: { setClock(fn) { clock = fn; }, refresh, state: () => ({ item, panel, wastePanel, last }) },
};
