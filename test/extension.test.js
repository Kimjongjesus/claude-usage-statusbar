'use strict';
// Drives extension.js against a fake `vscode` module with an injected clock and captured timers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { test } = require('./harness');
const { tmpdir, line, writeProjects, M15 } = require('./helpers');

const L = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);

function makeVscode() {
  const v = { items: [], messages: [], panels: [], inputs: [], settings: {}, updates: [], cmds: {}, cfgListeners: [] };
  v.StatusBarAlignment = { Right: 2 };
  v.ConfigurationTarget = { Global: 1 };
  v.ViewColumn = { Active: -1 };
  v.ThemeColor = class { constructor(id) { this.id = id; } };
  v.MarkdownString = class { constructor(value, icons) { this.value = value; this.supportThemeIcons = icons; } };
  v.window = {
    createStatusBarItem: () => { const i = { show() {}, dispose() {} }; v.items.push(i); return i; },
    showWarningMessage: (m) => { v.messages.push({ level: 'warn', m }); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { v.messages.push({ level: 'crit', m }); return Promise.resolve(undefined); },
    showInputBox: (o) => { v.inputs.push(o); return Promise.resolve(v.nextInput); },
    createWebviewPanel: (type, title, col, opts) => {
      const p = { type, title, opts, webview: { html: '' }, reveal() {}, onDidDispose(cb) { p._dispose = cb; } };
      v.panels.push(p); return p;
    },
  };
  v.commands = { registerCommand: (n, fn) => { v.cmds[n] = fn; return { dispose() {} }; } };
  v.workspace = {
    getConfiguration: () => ({
      get: (k, d) => (k in v.settings ? v.settings[k] : d),
      inspect: (k) => ({ globalValue: v.settings[k] }),
      update: (k, val) => { v.settings[k] = val; v.updates.push([k, val]); return Promise.resolve(); },
    }),
    onDidChangeConfiguration: (cb) => { v.cfgListeners.push(cb); return { dispose() {} }; },
  };
  return v;
}

async function withExtension(setup, body) {
  const root = tmpdir('cu-ext-');
  const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = root; process.env.USERPROFILE = root; process.env.CLAUDE_CONFIG_DIR = '';
  const projects = path.join(root, '.claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const vs = makeVscode();
  const origLoad = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? vs : origLoad.call(this, r, ...a); };
  // Capture timers so the test controls "time passing".
  const realSI = global.setInterval, realCI = global.clearInterval, realST = global.setTimeout, realCT = global.clearTimeout;
  const timers = { intervals: [], timeouts: [] };
  global.setInterval = (fn, ms) => { const t = { fn, ms, live: true }; timers.intervals.push(t); return t; };
  global.clearInterval = (t) => { if (t) t.live = false; };
  global.setTimeout = (fn, ms) => { const t = { fn, ms, live: true }; timers.timeouts.push(t); return t; };
  global.clearTimeout = (t) => { if (t) t.live = false; };
  const store = {};
  const ctx = { subscriptions: [], globalState: { get: (k, d) => (k in store ? store[k] : d), update: (k, val) => { store[k] = val; return Promise.resolve(); } } };
  delete require.cache[require.resolve('../extension')];
  const ext = require('../extension');
  try {
    if (setup) setup(vs, projects);
    await body({ vs, ext, ctx, projects, timers, store });
  } finally {
    ext.deactivate();
    global.setInterval = realSI; global.clearInterval = realCI; global.setTimeout = realST; global.clearTimeout = realCT;
    Module._load = origLoad;
    for (const [k, val] of Object.entries(savedEnv)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
    delete require.cache[require.resolve('../extension')];
  }
}
const live = (arr) => arr.filter((t) => t.live);

test('status bar rolls over on the 1st without a restart (poll timer)', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; vs.settings.refreshSeconds = 30; }, async ({ vs, ext, ctx, projects, timers }) => {
    writeProjects(projects, { 'p/sep.jsonl': [line({ at: L(2026, 9, 12, 10), out: M15 * 20 }), line({ at: L(2026, 9, 30, 23, 58), out: M15 * 10 })] });
    ext._test.setClock(() => L(2026, 9, 30, 23, 59));
    ext.activate(ctx);
    const item = vs.items[0];
    assert.strictEqual(item.text, '$(pulse) $450 ●●○○○ 45%', 'September month-to-date at 23:59');
    assert.ok(vs.items.length === 1);
    // Claude keeps working past midnight: a message lands in a new log file on Oct 1.
    writeProjects(projects, { 'p/oct.jsonl': [line({ at: L(2026, 10, 1, 0, 0, 40), out: M15 * 2 })] });
    ext._test.setClock(() => L(2026, 10, 1, 0, 1));
    const poll = live(timers.intervals).find((t) => t.ms === 30000);
    assert.ok(poll, 'a 30s poll interval is running');
    poll.fn(); // the timer ticks; no restart, no config change
    assert.strictEqual(item.text, '$(pulse) $30.00 ○○○○○ 3%', 'October starts from zero + only October usage');
    assert.ok(item.tooltip.value.includes('October 2026') && !item.tooltip.value.includes('September 2026'));
    assert.ok(item.backgroundColor === undefined);
  });
});

test('status bar rolls over exactly at midnight via the midnight timer (even with a long poll interval)', async () => {
  await withExtension((vs) => { vs.settings.refreshSeconds = 3600; }, async ({ vs, ext, ctx, projects, timers }) => {
    writeProjects(projects, { 'p/sep.jsonl': [line({ at: L(2026, 9, 30, 20), out: M15 * 10 })] });
    let now = L(2026, 9, 30, 23, 59, 30);
    ext._test.setClock(() => now);
    ext.activate(ctx);
    assert.strictEqual(vs.items[0].text, '$(pulse) $150 ●○○○○ 15%');
    const mid = live(timers.timeouts).find((t) => t.ms > 0 && t.ms <= 31000);
    assert.ok(mid, 'a timer is armed for ~30s after 23:59:30, i.e. just past midnight: ' + JSON.stringify(timers.timeouts.map((t) => t.ms)));
    now = L(2026, 10, 1, 0, 0, 1);
    mid.live = false; mid.fn();
    assert.strictEqual(vs.items[0].text, '$(pulse) $0.00 ○○○○○ 0%');
    assert.ok(live(timers.timeouts).some((t) => t.ms > 23 * 3600 * 1000), 're-armed for the next midnight');
  });
});

test('threshold notifications fire once per month per threshold (persisted in globalState)', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 100; }, async ({ vs, ext, ctx, projects, timers, store }) => {
    let now = L(2026, 10, 10, 12);
    ext._test.setClock(() => now);
    writeProjects(projects, { 'p/a.jsonl': [line({ at: L(2026, 10, 3, 9), out: M15 * 5 })] }); // $75 = 75% -> warn
    ext.activate(ctx);
    assert.deepStrictEqual(vs.messages.map((m) => m.level), ['warn']);
    assert.ok(vs.items[0].backgroundColor && vs.items[0].backgroundColor.id === 'statusBarItem.warningBackground');
    ext._test.refresh(); ext._test.refresh();
    assert.strictEqual(vs.messages.length, 1, 'no repeat of the warn notice');
    writeProjects(projects, { 'p/b.jsonl': [line({ at: L(2026, 10, 9, 9), out: M15 * 1.2 })] }); // +$18 = 93% -> crit
    ext._test.refresh();
    assert.deepStrictEqual(vs.messages.map((m) => m.level), ['warn', 'crit']);
    assert.ok(vs.items[0].backgroundColor.id === 'statusBarItem.errorBackground');
    ext._test.refresh();
    assert.strictEqual(vs.messages.length, 2, 'no repeat of the crit notice');
    assert.strictEqual(store.thresholdNotified.month, '2026-10');
    // New month: usage is 0 again, status goes back to normal, and thresholds re-arm.
    now = L(2026, 11, 2, 9);
    ext._test.refresh();
    assert.strictEqual(vs.items[0].backgroundColor, undefined);
    writeProjects(projects, { 'p/c.jsonl': [line({ at: L(2026, 11, 1, 9), out: M15 * 5.5 })] }); // $82.5 in November
    ext._test.refresh();
    assert.deepStrictEqual(vs.messages.map((m) => m.level), ['warn', 'crit', 'warn']);
  });
});

test('notifications can be turned off', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 10; vs.settings.notifyOnThresholds = false; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    writeProjects(projects, { 'p/a.jsonl': [line({ at: L(2026, 10, 3, 9), out: M15 })] });
    ext.activate(ctx);
    assert.strictEqual(vs.messages.length, 0);
  });
});

test('first run asks for the monthly budget (default 1000) once; Set Monthly Budget command re-asks', async () => {
  await withExtension(null, async ({ vs, ext, ctx, store }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    vs.nextInput = '750';
    ext.activate(ctx);
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    assert.strictEqual(vs.inputs.length, 1);
    assert.strictEqual(vs.inputs[0].value, '1000', 'default shown');
    assert.deepStrictEqual(vs.updates[0], ['monthlyBudgetUsd', 750]);
    assert.strictEqual(store.budgetConfirmed, true);
    assert.ok(vs.inputs[0].validateInput('abc') && vs.inputs[0].validateInput('0') && !vs.inputs[0].validateInput('1500'));
    assert.ok(vs.items[0].text.includes('0%'));
    vs.nextInput = undefined; // user cancels
    await vs.cmds['claudeUsage.setBudget']();
    assert.strictEqual(vs.inputs.length, 2);
    assert.strictEqual(vs.updates.length, 1, 'cancel changes nothing');
  });
});

test('first run does not nag when the budget is already set in settings', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 500; }, async ({ vs, ext, ctx, store }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    ext.activate(ctx);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(vs.inputs.length, 0);
    assert.strictEqual(store.budgetConfirmed, true);
  });
});

test('configuration change refreshes immediately', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    writeProjects(projects, { 'p/a.jsonl': [line({ at: L(2026, 10, 3, 9), out: M15 * 10 })] }); // $150
    ext.activate(ctx);
    assert.ok(vs.items[0].text.endsWith('15%'));
    vs.settings.monthlyBudgetUsd = 300;
    for (const cb of vs.cfgListeners) cb({ affectsConfiguration: (s) => s === 'claudeUsage' });
    assert.ok(vs.items[0].text.endsWith('50%'), vs.items[0].text);
  });
});

test('dashboard opens as a locked-down webview and live-updates; closing resets', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    writeProjects(projects, { 'p/a.jsonl': [line({ at: L(2026, 10, 3, 9), out: M15 * 10, cwd: 'C:\\w\\shop' })] });
    ext.activate(ctx);
    vs.cmds['claudeUsage.showDetails']();
    assert.strictEqual(vs.panels.length, 1);
    const p = vs.panels[0];
    assert.strictEqual(p.opts.enableScripts, false);
    assert.deepStrictEqual(p.opts.localResourceRoots, []);
    assert.ok(p.webview.html.includes("default-src 'none'") && p.webview.html.includes('shop') && p.webview.html.includes('$150.00'));
    writeProjects(projects, { 'p/b.jsonl': [line({ at: L(2026, 10, 9, 9), out: M15 * 10 })] });
    ext._test.refresh();
    assert.ok(p.webview.html.includes('$300.00'), 'open dashboard follows new usage');
    vs.cmds['claudeUsage.showDetails'](); assert.strictEqual(vs.panels.length, 1, 'reuses the panel');
    p._dispose();
    vs.cmds['claudeUsage.showDetails'](); assert.strictEqual(vs.panels.length, 2);
  });
});

test('hover is a themed-icon MarkdownString that only trusts its own commands', async () => {
  await withExtension(null, async ({ vs, ext, ctx }) => {
    vs.settings.monthlyBudgetUsd = 1000;
    ext._test.setClock(() => L(2026, 10, 10, 12));
    ext.activate(ctx);
    const tip = vs.items[0].tooltip;
    assert.strictEqual(tip.supportThemeIcons, true);
    assert.deepStrictEqual(tip.isTrusted.enabledCommands.sort(), ['claudeUsage.refresh', 'claudeUsage.setBudget', 'claudeUsage.showDetails']);
  });
});
