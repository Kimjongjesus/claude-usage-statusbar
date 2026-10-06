'use strict';
// The hub and the plan handoff inside the extension (fake vscode module, injected clock).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');
const { tmpdir, writeProjects, asst, userLine } = require('./helpers');
const { withExtension, L } = require('./extension.test');
const hi = require('../lib/hooks-install');

const NOW = L(2026, 10, 14, 15, 0);
const ago = (m) => new Date(+NOW - m * 60000);
const tick = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r)); };
function listAll(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } })(dir);
  return out.sort();
}

function sessions(projects, ws) {
  writeProjects(projects, {
    'ws/s1.jsonl': [
      asst({ at: ago(50), sid: 'S1', cwd: ws, branch: 'feature/hub', model: 'claude-sonnet-4-5', usage: { write5m: 18000, output: 400 }, stop: 'tool_use' }),
      asst({ at: ago(3), sid: 'S1', cwd: ws, branch: 'feature/hub', model: 'claude-sonnet-4-5', usage: { read: 140000, write5m: 2000, output: 600 }, stop: 'end_turn' }),
    ],
    'ws/s2.jsonl': [
      asst({ at: ago(9), sid: 'S2', cwd: ws, branch: 'main', usage: { write5m: 20000, output: 300 }, stop: 'end_turn' }),
      userLine({ at: ago(1), sid: 'S2', cwd: ws }),
    ],
  });
}

function plan(ws, name, body, mtime) {
  const dir = path.join(ws, '.claude', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  fs.utimesSync(p, mtime, mtime);
  return p;
}
const PLAN = '---\nsource: ExitPlanMode\nsession_id: S1\ncwd: CWD\ncreated: x\n---\n\n# Plan: Refund approvals\n\n1. src/dashboards/refunds/Approvals.tsx\n2. src/shared/api/client.ts\n3. src/hub/registry.ts\n4. server/routes/refunds.ts\n5. test/refunds.test.ts\n';

test('hub status item shows live / waiting counts and opens a locked-down hub page; the setting hides it', async () => {
  const ws = tmpdir('ws-');
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; vs.workspace.workspaceFolders = [{ uri: { fsPath: ws } }]; }, async ({ vs, ext, ctx, projects }) => {
    sessions(projects, ws);
    ext._test.setClock(() => NOW);
    ext.activate(ctx);
    const hubItem = vs.items[1];
    assert.strictEqual(hubItem.command, 'claudeUsage.showHub');
    assert.strictEqual(hubItem.text, '$(bell) 1 waiting · 2 live');
    assert.ok(hubItem.visible && /2 live session/.test(hubItem.tooltip));
    assert.strictEqual(vs.items[0].command, 'claudeUsage.showDetails', 'the main item still opens the dashboard');
    vs.cmds['claudeUsage.showHub']();
    const p = vs.panels.find((x) => x.type === 'claudeUsageHub');
    assert.ok(p, 'hub panel');
    assert.strictEqual(p.opts.enableScripts, false); assert.deepStrictEqual(p.opts.localResourceRoots, []);
    assert.deepStrictEqual(p.opts.enableCommandUris.slice().sort(), ['claudeUsage.hubAction', 'claudeUsage.refresh', 'claudeUsage.showDetails', 'claudeUsage.wasteReport']);
    assert.ok(p.webview.html.includes('Orchestration Hub') && p.webview.html.includes("default-src 'none'") && p.webview.html.includes('Waiting on you'));
    vs.cmds['claudeUsage.showHub'](); assert.strictEqual(vs.panels.filter((x) => x.type === 'claudeUsageHub').length, 1, 'reused');
    // the dashboard links to the hub and may run that command
    vs.cmds['claudeUsage.showDetails']();
    const dash = vs.panels.find((x) => x.type === 'claudeUsage');
    assert.ok(dash.opts.enableCommandUris.includes('claudeUsage.showHub') && dash.webview.html.includes('command:claudeUsage.showHub'));
    vs.settings.showHubItem = false;
    for (const cb of vs.cfgListeners) cb({ affectsConfiguration: (s) => s === 'claudeUsage' });
    assert.strictEqual(hubItem.visible, false);
  });
});

test('hub actions: resume copies the command and can open a terminal in the session folder; folder opens a new window; unknown ids do nothing', async () => {
  const ws = tmpdir('ws-');
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    sessions(projects, ws);
    ext._test.setClock(() => NOW);
    ext.activate(ctx);
    vs.infoQueue = ['Open terminal there'];
    await vs.cmds['claudeUsage.hubAction']({ op: 'resume', sid: 'S1' });
    assert.deepStrictEqual(vs.clipboard, ['claude --resume S1']);
    assert.strictEqual(vs.terminals.length, 1);
    assert.strictEqual(vs.terminals[0].opts.cwd, ws); assert.deepStrictEqual(vs.terminals[0].sent, ['claude --resume S1']);
    await vs.cmds['claudeUsage.hubAction']({ op: 'folder', sid: 'S2' });
    assert.deepStrictEqual(vs.executed[0], ['vscode.openFolder', { scheme: 'file', fsPath: ws }, { forceNewWindow: true }]);
    const warnsBefore = vs.messages.length;
    await vs.cmds['claudeUsage.hubAction']({ op: 'resume', sid: 'S1; rm -rf ~' });
    await vs.cmds['claudeUsage.hubAction']('garbage');
    await vs.cmds['claudeUsage.hubAction']({ op: 'folder', sid: 'nope' });
    assert.strictEqual(vs.clipboard.length, 1); assert.strictEqual(vs.terminals.length, 1); assert.strictEqual(vs.executed.length, 1);
    assert.strictEqual(vs.messages.length - warnsBefore, 3, 'each refused with a warning');
  });
});

test('plan handoff: a new plan is offered once with model, effort, reason and the saving; Send opens claude with the verified flags', async () => {
  const ws = tmpdir('ws-');
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; vs.workspace.workspaceFolders = [{ uri: { fsPath: ws } }]; }, async ({ vs, ext, ctx, projects, store }) => {
    sessions(projects, ws);
    const file = plan(ws, '20261014-145900.md', PLAN.replace('CWD', ws), ago(1));
    plan(ws, '20261014-120000.md', '# An old plan\n', ago(180));
    const before = listAll(ws).map((p) => p + ':' + fs.readFileSync(p, 'utf8').length);
    ext._test.setClock(() => NOW);
    vs.infoQueue = ['Send'];
    ext.activate(ctx);
    await tick();
    const offers = vs.infos.filter((i) => /^Send this plan to a new session\?/.test(i.m));
    assert.strictEqual(offers.length, 1, 'only the fresh plan is offered');
    const o = offers[0];
    assert.ok(o.m.includes('"Refund approvals"') && o.m.includes('Suggested: Opus · high.') && /Multi-module: 5 files/.test(o.m), o.m);
    assert.ok(/instead of re-sending 142k: about \$0\.0\d+ less per request/.test(o.m), o.m);
    assert.deepStrictEqual(o.buttons, [{ modal: false }, 'Send', 'Change', 'Skip']);
    assert.strictEqual(vs.terminals.length, 1);
    const t = vs.terminals[0];
    assert.strictEqual(t.opts.cwd, ws); assert.ok(t.shown); assert.strictEqual(t.opts.name, 'Claude · Opus · high');
    assert.deepStrictEqual(t.sent, ['claude --model opus --effort high "@.claude/handoffs/20261014-145900.md Implement this plan. It was written in an earlier session, so read the files it names before changing them."']);
    assert.ok(store.handoffsSeen.some((k) => k.startsWith(file + '|')));
    assert.ok(Object.values(store.handoffStatus).includes('sent · Opus · high'));
    // more refreshes, the watcher, a restart: never offered again
    ext._test.refresh(); ext._test.checkHandoffs(); await tick();
    assert.strictEqual(vs.infos.filter((i) => /^Send this plan/.test(i.m)).length, 1);
    // the extension wrote nothing into the project
    assert.deepStrictEqual(listAll(ws).map((p) => p + ':' + fs.readFileSync(p, 'utf8').length), before);
    // the hub lists the plan with its suggestion and a Send link that carries only a name and a folder index
    vs.cmds['claudeUsage.showHub']();
    const html = vs.panels.find((x) => x.type === 'claudeUsageHub').webview.html;
    assert.ok(html.includes('Plan handoffs') && html.includes('Refund approvals') && html.includes('sent · Opus · high'));
    const m = /href="command:claudeUsage\.hubAction\?([^"]+)"[^>]*>Send…/.exec(html);
    assert.deepStrictEqual(JSON.parse(decodeURIComponent(m[1].replace(/&quot;/g, '"'))), [{ op: 'handoff', name: '20261014-145900.md', root: 0 }]);
  });
});

test('plan handoff: Change lets you pick model and effort; Skip records it; the prompt can be turned off', async () => {
  const ws = tmpdir('ws-');
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; vs.workspace.workspaceFolders = [{ uri: { fsPath: ws } }]; }, async ({ vs, ext, ctx, projects, store }) => {
    sessions(projects, ws);
    plan(ws, '20261014-145900.md', PLAN.replace('CWD', ws), ago(1));
    ext._test.setClock(() => NOW);
    vs.infoQueue = ['Change'];
    vs.pickQueue = [(items) => items.find((i) => i.id === 'sonnet'), (items) => items.find((i) => i.id === 'low')];
    ext.activate(ctx);
    await tick();
    assert.ok(vs.picks[0].items.find((i) => i.id === 'opus').description === 'suggested');
    assert.deepStrictEqual(vs.picks[1].items.map((i) => i.id), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.ok(/^claude --model sonnet --effort low "@\.claude\/handoffs\/20261014-145900\.md /.test(vs.terminals[0].sent[0]));
    // "Other model…" goes through a validated input box
    plan(ws, '20261014-145930.md', '# Small fix\n- src/a.ts\n', ago(0.5));
    vs.infoQueue = ['Change'];
    vs.pickQueue = [(items) => items.find((i) => i.id === 'other'), (items) => items.find((i) => i.id === 'max')];
    vs.nextInput = 'claude-opus-4-5-20251101';
    ext._test.checkHandoffs(); await tick();
    const box = vs.inputs[vs.inputs.length - 1];
    assert.ok(box.validateInput('opus; rm -rf ~') && !box.validateInput('claude-opus-4-5-20251101'));
    assert.ok(vs.terminals[1].sent[0].startsWith('claude --model claude-opus-4-5-20251101 --effort max '));
    // Skip
    plan(ws, '20261014-145950.md', '# Another\n', ago(0.2));
    vs.infoQueue = ['Skip'];
    ext._test.checkHandoffs(); await tick();
    assert.strictEqual(vs.terminals.length, 2);
    assert.ok(Object.values(store.handoffStatus).includes('skipped'));
    // turned off
    vs.settings.planHandoffPrompt = false;
    plan(ws, '20261014-150000.md', '# Quiet\n', NOW);
    const n = vs.infos.length;
    ext._test.checkHandoffs(); await tick();
    assert.strictEqual(vs.infos.length, n, 'no prompt when planHandoffPrompt is false');
  });
});

test('Set Up Plan Handoff: preview first, nothing written until confirmed, then merges next to the token-saver hooks without removing them', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, store }) => {
    ext._test.setClock(() => NOW);
    ext.activate(ctx);
    const home = process.env.HOME;
    const settings = path.join(home, '.claude', 'settings.json');
    // the user already has the token-saver hooks and one of their own
    const saver = hi.plan({ home, budget: 1000, picks: { guard: true, budget: true, trim: true }, scope: 'user', set: 'savers' });
    hi.apply(saver, path.join(__dirname, '..'));
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['/opt/audit.js'] }] };
    const cur = JSON.parse(fs.readFileSync(settings, 'utf8')); cur.hooks.PreToolUse.push(mine);
    fs.writeFileSync(settings, JSON.stringify(cur));
    const snap = () => listAll(home).filter((p) => !p.includes(path.sep + 'projects' + path.sep)).map((p) => p + ':' + fs.readFileSync(p, 'utf8').length);
    const before = snap();
    vs.pickQueue = [(items) => items.find((i) => i.id === 'user')];
    vs.nextWarn = undefined; // declines the modal
    await vs.cmds['claudeUsage.setupHandoff']();
    assert.ok(vs.docs[vs.docs.length - 1].content.includes('nothing has been written') && vs.docs[vs.docs.length - 1].content.includes('"ExitPlanMode"'));
    assert.deepStrictEqual(snap(), before, 'declined: nothing written');
    vs.pickQueue = [(items) => items.find((i) => i.id === 'user')];
    vs.nextWarn = 'Write files';
    await vs.cmds['claudeUsage.setupHandoff']();
    const modal = vs.messages.filter((m) => m.level === 'warn').pop();
    assert.ok(/Copy 2 scripts to:/.test(modal.rest[0].detail), modal.rest[0].detail);
    const now = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const pre = now.hooks.PreToolUse;
    assert.deepStrictEqual(pre.map((g) => g.matcher), ['Read|Grep|Glob', 'Bash', 'ExitPlanMode'], 'token-saver read guard and the user hook kept');
    assert.ok(now.hooks.UserPromptSubmit && now.hooks.PostToolUse, 'other token-saver events kept');
    assert.ok(pre[2].hooks[0].args[0].endsWith(path.join('token-saver-hooks', 'save-plan.js')));
    assert.ok(fs.existsSync(path.join(home, '.claude', 'token-saver-hooks', 'save-plan.js')));
    assert.strictEqual(store.handoffHookInstalled, true);
    assert.ok(fs.readdirSync(path.join(home, '.claude')).some((n) => n.startsWith('settings.json.bak-')), 'backup first');
    // re-installing the token savers afterwards keeps the handoff hook
    hi.apply(hi.plan({ home, budget: 900, picks: { guard: true, budget: true, trim: true }, scope: 'user', set: 'savers' }), path.join(__dirname, '..'));
    assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.PreToolUse.some((g) => g.matcher === 'ExitPlanMode'));
  });
});
