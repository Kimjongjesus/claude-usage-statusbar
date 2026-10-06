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
const hubModel = require('./lib/hub');
const { render: renderHub } = require('./lib/hub-view');
const handoffs = require('./lib/handoffs');
const advice = require('./lib/plan-advice');
const fs = require('fs');

const OWN_COMMANDS = ['claudeUsage.showDetails', 'claudeUsage.setBudget', 'claudeUsage.refresh', 'claudeUsage.wasteReport', 'claudeUsage.showHub'];
let ctx, item, hubItem, panel, wastePanel, hubPanel, last, timer, midnight, watcher, watchedKey = '', renderSig = '', renderedAt = 0;
let hoWatcher, hoWatchedKey = '', hoList = [], prompting = false, hubSig = '';
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
    showHub: c.get('showHubItem', true) !== false,
    handoffPrompt: c.get('planHandoffPrompt', true) !== false,
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
    // Hub status item: live / waiting counts (no waste analysis needed for the counts).
    const lite = hubModel.buildHub(s, null, hubOpts(c, now));
    last.hubLite = lite;
    if (hubItem) {
      hubItem.text = hubModel.hubStatusText(lite.totals);
      hubItem.tooltip = `Claude orchestration hub: ${lite.totals.live} live session(s), ${lite.totals.waiting} waiting on you, ${lite.totals.projects} project(s) this month. Click to open.`;
      if (c.showHub) hubItem.show(); else hubItem.hide();
    }
    const hs = lite.live.map((x) => x.sid + ':' + x.state).join(',');
    // Re-render the panels only when something changed (re-setting html resets scroll).
    const sig = [s.month, s.totalUsd.toFixed(4), s.messages, c.budget, c.warn, c.crit, c.ctxWindow, c.ctxNudge].join('|');
    if (force === true || sig !== renderSig || hs !== hubSig || now - renderedAt > 5 * 60 * 1000) { renderSig = sig; hubSig = hs; renderedAt = +now; renderPanel(); renderWastePanel(); renderHubPanel(); }
    rewatchIfNeeded(s.dirs, c);
    checkHandoffs();
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
  return render(s, d, { nonce, updatedAt: now, history: mergedHistory(s), context: cx, home: os.homedir() });
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
    { enableScripts: false, enableCommandUris: ['claudeUsage.setBudget', 'claudeUsage.refresh', 'claudeUsage.wasteReport', 'claudeUsage.showHub'], localResourceRoots: [] });
  panel.onDidDispose(() => { panel = undefined; }, null, ctx.subscriptions);
  renderPanel();
}

function showWaste() {
  if (!last) refresh();
  if (!last) return;
  if (wastePanel) { wastePanel.reveal(); renderWastePanel(); return; }
  wastePanel = vscode.window.createWebviewPanel('claudeUsageWaste', 'Claude Usage: Waste Report', vscode.ViewColumn.Active,
    { enableScripts: false, enableCommandUris: ['claudeUsage.showDetails', 'claudeUsage.refresh', 'claudeUsage.installHooks', 'claudeUsage.showHub'], localResourceRoots: [] });
  wastePanel.onDidDispose(() => { wastePanel = undefined; }, null, ctx.subscriptions);
  renderWastePanel();
}

// ---- Orchestration hub -------------------------------------------------------------------------------------
function hubOpts(c, now) { return { now, ctxThreshold: c.ctxNudge > 0 ? c.ctxNudge : 150000, contextWindow: c.ctxWindow, workspaceDirs: workspaceDirs() }; }

function fullHub() {
  const { s, c, now } = last;
  const rep = analyze(s, { pricingOverrides: c.pricingOverrides, ctxThreshold: c.ctxNudge > 0 ? c.ctxNudge : 150000 });
  return hubModel.buildHub(s, rep, hubOpts(c, now));
}

function handoffRows() {
  const status = ctx.globalState.get('handoffStatus', {});
  const roots = workspaceDirs();
  return hoList.slice(0, 8).map((e) => {
    const h = handoffs.read(e);
    if (!h) return null;
    const sug = advice.suggest(h.plan);
    return { name: e.name, rootIndex: roots.indexOf(e.root), relPath: e.relPath, mtimeMs: e.mtimeMs, title: h.title, project: path.basename(e.root), suggestion: sug, status: status[handoffs.keyOf(e)] || 'new' };
  }).filter(Boolean);
}

function hubHtml() {
  const { s, d, now } = last;
  const hub = fullHub();
  last.hub = hub;
  const nonce = crypto.randomBytes(16).toString('base64');
  return renderHub(hub, s, d, { nonce, updatedAt: now, handoffs: handoffRows(), handoffHook: !!ctx.globalState.get('handoffHookInstalled') });
}
function renderHubPanel() { if (hubPanel && last) hubPanel.webview.html = hubHtml(); }

function showHub() {
  if (!last) refresh();
  if (!last) return;
  if (hubPanel) { hubPanel.reveal(); renderHubPanel(); return; }
  hubPanel = vscode.window.createWebviewPanel('claudeUsageHub', 'Claude Usage: Hub', vscode.ViewColumn.Active,
    { enableScripts: false, enableCommandUris: ['claudeUsage.hubAction', 'claudeUsage.showDetails', 'claudeUsage.wasteReport', 'claudeUsage.refresh'], localResourceRoots: [] });
  hubPanel.onDidDispose(() => { hubPanel = undefined; }, null, ctx.subscriptions);
  renderHubPanel();
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Links in the hub page call this with { op, sid } or { op: 'handoff', name, root }. Nothing from the page is
// trusted: the session / plan is looked up in what the extension itself read, and only its own values are used.
async function hubAction(arg) {
  const a = arg && typeof arg === 'object' ? arg : {};
  if (!last) refresh();
  if (!last) return;
  if (a.op === 'handoff') {
    const root = workspaceDirs()[a.root];
    const e = hoList.find((x) => x.root === root && x.name === a.name);
    if (!e) { vscode.window.showWarningMessage('That plan is no longer in this window\'s folders.'); return; }
    await offerHandoff(e, true);
    return;
  }
  const x = hubModel.findSession(last.hub || last.hubLite, a.sid);
  if (!x) { vscode.window.showWarningMessage('That session is not in the current list. Refresh the hub and try again.'); return; }
  if (a.op === 'resume') {
    const cmd = hubModel.resumeCommand(x.sid);
    if (!cmd) { vscode.window.showWarningMessage('This session id cannot be resumed from the command line.'); return; }
    await vscode.env.clipboard.writeText(cmd);
    const where = x.cwd ? ` Run it in ${x.cwd}.` : '';
    const pick = await vscode.window.showInformationMessage(`Copied: ${cmd}.${where}`, ...(x.cwd && isDir(x.cwd) ? ['Open terminal there'] : []));
    if (pick === 'Open terminal there') {
      const term = vscode.window.createTerminal({ name: 'Claude: ' + f.ellipsize(x.name, 30), cwd: x.cwd });
      term.show();
      term.sendText(cmd);
    }
    return;
  }
  if (a.op === 'folder') {
    if (!x.cwd || !isDir(x.cwd)) { vscode.window.showWarningMessage(`Folder not found on this machine: ${x.cwd || '(unknown)'}`); return; }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(x.cwd), { forceNewWindow: true });
  }
}

// ---- Plan handoff ------------------------------------------------------------------------------------------
// hooks/save-plan.js writes each presented plan to <folder>/.claude/handoffs/. This watches the folders of this
// window, offers each new plan once (remembered in global state, never by touching the file) and, on Send, opens
// a new terminal with `claude --model <m> --effort <e> "@<plan file> Implement this plan..."`.
function rewatchHandoffs() {
  const roots = workspaceDirs();
  const targets = roots.map((r) => handoffs.handoffDir(r)).map((d) => (isDir(d) ? d : path.dirname(d))).filter(isDir);
  const key = targets.join('|');
  if (key === hoWatchedKey && hoWatcher) return;
  hoWatchedKey = key;
  if (hoWatcher) hoWatcher.dispose();
  hoWatcher = targets.length ? watchDirs(targets, checkHandoffs, 1000) : undefined;
}

function checkHandoffs() {
  if (!ctx) return;
  try {
    rewatchHandoffs();
    const before = hoList.map(handoffs.keyOf).join(',');
    hoList = handoffs.list(workspaceDirs());
    if (before !== hoList.map(handoffs.keyOf).join(',')) renderHubPanel();
    if (prompting || !cfg().handoffPrompt) return;
    const seen = ctx.globalState.get('handoffsSeen', []);
    const fresh = handoffs.pending(hoList, seen, clock());
    if (!fresh.length) return;
    // Persist first (like the other notices): a refresh, a second window or a restart never repeats the offer.
    ctx.globalState.update('handoffsSeen', seen.concat(fresh.map(handoffs.keyOf)).slice(-300));
    prompting = true;
    Promise.resolve(offerHandoff(fresh[0], false)).catch(() => {}).then(() => { prompting = false; });
  } catch { /* the handoff prompt is a convenience; never break the status bar */ }
}

function setStatus(e, text) {
  const st = Object.assign({}, ctx.globalState.get('handoffStatus', {}));
  st[handoffs.keyOf(e)] = text;
  const keys = Object.keys(st);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete st[k];
  ctx.globalState.update('handoffStatus', st);
  renderHubPanel();
}

function adviceFor(e) {
  const h = handoffs.read(e);
  if (!h) return null;
  const c = cfg();
  const sug = advice.suggest(h.plan);
  const sav = advice.savings({ sessions: last ? last.s.sessions : [], sid: h.meta.session_id, cwd: h.meta.cwd || e.root, planChars: h.plan.length, pricingOverrides: c.pricingOverrides });
  return { h, sug, sav };
}

async function offerHandoff(e, fromHub) {
  const a = adviceFor(e);
  if (!a) return;
  const { h, sug, sav } = a;
  const msg = `Send this plan to a new session? "${h.title}". Suggested: ${advice.label(sug.model, sug.effort)}. ${sug.reason} ${sav.text}`;
  const pick = await vscode.window.showInformationMessage(msg, { modal: !!fromHub }, 'Send', 'Change', 'Skip');
  if (pick === 'Send') return launchHandoff(e, sug.model, sug.effort);
  if (pick === 'Change') {
    const chosen = await pickModelEffort(sug);
    if (chosen) return launchHandoff(e, chosen.model, chosen.effort);
    return;
  }
  if (pick === 'Skip') setStatus(e, 'skipped');
}

async function pickModelEffort(sug) {
  const models = [
    { label: 'Opus', id: 'opus', description: sug.model === 'opus' ? 'suggested' : 'deep reasoning, multi-module work' },
    { label: 'Sonnet', id: 'sonnet', description: sug.model === 'sonnet' ? 'suggested' : 'routine work, cheaper' },
    { label: 'Other model…', id: 'other', description: 'type an alias or a full model name' },
  ];
  const m = await vscode.window.showQuickPick(models, { title: 'Model for the new session', placeHolder: `Suggested: ${advice.label(sug.model, sug.effort)}` });
  if (!m) return null;
  let model = m.id;
  if (model === 'other') {
    const v = await vscode.window.showInputBox({ title: 'Model for the new session', prompt: 'A Claude Code model alias or full model name (passed to --model)',
      validateInput: (t) => (advice.validModel(t) ? undefined : 'Letters, digits, dots, dashes, colons and brackets only') });
    if (!v) return null;
    model = v;
  }
  const efforts = advice.EFFORTS.map((x) => ({ label: x, id: x, description: x === sug.effort ? 'suggested' : '' }));
  const ef = await vscode.window.showQuickPick(efforts, { title: 'Effort (thinking level) for the new session', placeHolder: `Suggested: ${sug.effort}` });
  if (!ef) return null;
  return { model, effort: ef.id };
}

function launchHandoff(e, model, effort) {
  let L;
  try { L = advice.launchCommand({ model, effort, relPath: e.relPath }); } catch (err) { vscode.window.showErrorMessage(String((err && err.message) || err)); return; }
  if (!isDir(e.root)) { vscode.window.showWarningMessage('The plan\'s folder is gone: ' + e.root); return; }
  const term = vscode.window.createTerminal({ name: `Claude · ${advice.label(model, effort)}`, cwd: e.root });
  term.show();
  term.sendText(L.line);
  setStatus(e, `sent · ${advice.label(model, effort)}`);
}

// Command Palette: pick one of the recent plans (if the toast was dismissed).
async function sendPlan() {
  hoList = handoffs.list(workspaceDirs());
  if (!hoList.length) {
    const go = await vscode.window.showInformationMessage('No saved plans in this window\'s folders. The Plan Handoff hook saves each plan Claude presents.', 'Set Up Plan Handoff');
    if (go === 'Set Up Plan Handoff') await setupHandoff();
    return;
  }
  const status = ctx.globalState.get('handoffStatus', {});
  const items = hoList.slice(0, 20).map((e) => {
    const h = handoffs.read(e);
    const sug = h ? advice.suggest(h.plan) : null;
    return { label: h ? h.title : e.name, description: sug ? advice.label(sug.model, sug.effort) : '', detail: `${path.basename(e.root)} · ${f.stamp(new Date(e.mtimeMs))} · ${status[handoffs.keyOf(e)] || 'new'}`, e };
  });
  const pick = await vscode.window.showQuickPick(items, { title: 'Send a plan to a new Claude Code session', placeHolder: 'Newest first' });
  if (pick) await offerHandoff(pick.e, true);
}

// ---- Install Token-Saver Hooks -------------------------------------------------------------------------
// Nothing is written until the user picks an install option AND confirms in a modal that lists every file.
function previewMarkdown(p) {
  return `# Claude Usage: Token-Saver Hooks

These are **opt-in** Claude Code hooks written in Node (they run the same on Windows, macOS and Linux). This page is a preview: **nothing has been written to disk.**

| Hook | Event | What it does |
|:--|:--|:--|
| guard-reads.js | PreToolUse (Read, Grep, Glob) | Blocks node_modules/dist/build, lockfiles, minified files, binaries and huge files |
| budget-guard.js | UserPromptSubmit | Warns you once per session at 75% and again at 90% of the month's budget |
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

  const p = hooksInstall.plan({ home, budget: c.budget, picks, scope: choice.id, workspaceDir: wsDir, set: 'savers' });
  if (p.error) { vscode.window.showErrorMessage(p.error); return; }
  const res = await confirmAndApply(p);
  if (res) vscode.window.showInformationMessage(`Token-Saver hooks installed (${res.written.length} files). New Claude Code sessions pick them up. ${res.backup ? 'Backup: ' + path.basename(res.backup) : ''}`);
}

// Shared by both installers: one modal that lists every file, then apply() (which re-checks the settings file).
async function confirmAndApply(p) {
  const lines = [];
  if (p.scripts.length) lines.push(`Copy ${p.scripts.length} scripts${p.libs.length ? ` and ${p.libs.length} helper files` : ''} to:\n  ${p.dir}`);
  if (p.backup) lines.push(`Back up your current settings to:\n  ${p.backup}`);
  lines.push(`${p.existed ? 'Update' : 'Create'} (existing hooks and permissions are kept):\n  ${p.file}`);
  const go = await vscode.window.showWarningMessage('Write these files?', { modal: true, detail: lines.join('\n\n') }, 'Write files');
  if (go !== 'Write files') return null;
  try {
    return hooksInstall.apply(p, (ctx && ctx.extensionPath) || __dirname);
  } catch (e) {
    vscode.window.showErrorMessage('Install failed: ' + ((e && e.message) || e));
    return null;
  }
}

// ---- Set Up Plan Handoff (opt-in hook on ExitPlanMode) --------------------------------------------------------
async function setupHandoff() {
  const home = os.homedir();
  const wsDir = workspaceDirs()[0];
  const preview = hooksInstall.plan({ home, picks: { handoff: true }, scope: 'user', set: 'handoff' });
  try {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# Claude Usage: Plan Handoff

An **opt-in** Claude Code hook (Node, same on Windows, macOS and Linux). This page is a preview: **nothing has been written to disk.**

When Claude presents a plan (the ExitPlanMode tool), \`save-plan.js\` saves it to \`<project>/.claude/handoffs/<time>.md\` (plus a \`.gitignore\` there so plans are never committed). It never blocks or changes the plan approval. VS Code then asks **Send this plan to a new session?** with a suggested model and effort, and opens a new terminal running \`claude --model <model> --effort <effort>\` with the plan as the first prompt.

Install copies the script to \`${preview.dir}\`, backs up your settings file and merges the entry below. Your own hooks, and the Token-Saver hooks if you have them, are kept.

\`\`\`json
${JSON.stringify(preview.snippet, null, 2)}
\`\`\`
` });
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
  } catch { /* the preview is a convenience */ }
  const choice = await vscode.window.showQuickPick([
    { label: '$(person) Install for my user…', id: 'user', description: 'every project; merges ~/.claude/settings.json (backup first)' },
    { label: '$(folder) Install for this project only…', id: 'project', description: 'merges .claude/settings.local.json (backup first); needs an open folder' },
    { label: '$(copy) Copy the settings snippet', id: 'copy', description: 'writes nothing' },
  ], { title: 'Set Up Plan Handoff', placeHolder: 'Nothing is written until you confirm on the next screen' });
  if (!choice) return;
  if (choice.id === 'copy') {
    await vscode.env.clipboard.writeText(JSON.stringify(preview.snippet, null, 2));
    vscode.window.showInformationMessage('Plan Handoff snippet copied. The script must exist at the path shown (copy hooks/save-plan.js and hooks/_common.js there).');
    return;
  }
  if (choice.id === 'project' && !wsDir) { vscode.window.showWarningMessage('Open a folder first, or choose "Install for my user".'); return; }
  const p = hooksInstall.plan({ home, picks: { handoff: true }, scope: choice.id, workspaceDir: wsDir, set: 'handoff' });
  if (p.error) { vscode.window.showErrorMessage(p.error); return; }
  const res = await confirmAndApply(p);
  if (!res) return;
  await ctx.globalState.update('handoffHookInstalled', true);
  vscode.window.showInformationMessage(`Plan Handoff installed (${res.written.length} files). New Claude Code sessions pick it up; plans are saved to .claude/handoffs in the project folder. ${res.backup ? 'Backup: ' + path.basename(res.backup) : ''}`);
  renderHubPanel();
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
  hubItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  hubItem.name = 'Claude Hub';
  hubItem.command = 'claudeUsage.showHub';
  hubItem.text = '$(layers) Hub';
  ctx.subscriptions.push(item, hubItem,
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(true)),
    vscode.commands.registerCommand('claudeUsage.showDetails', showDashboard),
    vscode.commands.registerCommand('claudeUsage.setBudget', promptBudget),
    vscode.commands.registerCommand('claudeUsage.wasteReport', showWaste),
    vscode.commands.registerCommand('claudeUsage.installHooks', installHooks),
    vscode.commands.registerCommand('claudeUsage.showHub', showHub),
    vscode.commands.registerCommand('claudeUsage.hubAction', hubAction),
    vscode.commands.registerCommand('claudeUsage.setupHandoff', setupHandoff),
    vscode.commands.registerCommand('claudeUsage.sendPlan', sendPlan),
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
  if (hoWatcher) hoWatcher.dispose();
  timer = midnight = watcher = hoWatcher = undefined;
  watchedKey = hoWatchedKey = hubSig = '';
  hoList = []; prompting = false;
  panel = wastePanel = hubPanel = undefined;
}

module.exports = {
  activate, deactivate,
  _test: { setClock(fn) { clock = fn; }, refresh, checkHandoffs, state: () => ({ item, hubItem, panel, wastePanel, hubPanel, last, hoList, prompting }) },
};
