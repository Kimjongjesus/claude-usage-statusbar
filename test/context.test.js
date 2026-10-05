'use strict';
// Context meter, session cost in the hover, the one-time nudge, and the Waste Report command, driven through extension.js.
const assert = require('assert');
const { test } = require('./harness');
const { writeProjects, asst, M15 } = require('./helpers');
const { withExtension, L } = require('./extension.test');

const HUB = 'C:\\Users\\Eli\\work\\hub';
const tick = () => new Promise((r) => setImmediate(r));
// one request that sent `ctx` tokens (almost all from the cache) and wrote a short answer
const req = (at, sid, ctx, extra) => asst(Object.assign({ at, sid, cwd: HUB, branch: 'feature/sales', usage: { input: 2000, read: ctx - 2000, output: 1000 } }, extra || {}));

test('context meter: a large, active session adds "ctx 142k" to the status bar; the month total stays the headline', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    writeProjects(projects, { 'hub/live.jsonl': [req(L(2026, 10, 10, 11, 40), 'live', 90000), req(L(2026, 10, 10, 11, 50), 'live', 142000)] });
    ext.activate(ctx);
    const text = vs.items[0].text;
    assert.ok(text.startsWith('$(pulse) $0.1') && text.endsWith('% · ctx 142k'), text);
    assert.ok(/^\$\(pulse\) \$[\d.,]+ [●○]{5} \d+% · ctx 142k$/.test(text), 'same shape as before plus the hint: ' + text);
  });
});

test('hover: "this session $X", context size vs window, and the concrete saving when context is large', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    writeProjects(projects, { 'hub/live.jsonl': [req(L(2026, 10, 10, 11, 50), 'live', 142000)] });
    ext.activate(ctx);
    const md = vs.items[0].tooltip.value;
    // 2000 in x $3/M + 1000 out x $15/M + 140000 read x $0.30/M = $0.063
    for (const want of ['This session', '**$0.06**', '142k / 200k · 71%', 'Each request re-sends about 142k tokens', '$0.043 per request', '$0.53 if it expired', '/compact', '/clear', 'command:claudeUsage.wasteReport', 'Estimate from local logs', '## $0.06 / $1,000']) {
      assert.ok(md.includes(want.replace(/[()]/g, (c) => '\\' + c)) || md.includes(want), `hover missing "${want}"\n${md}`);
    }
    assert.ok(!md.includes('http'), 'no URLs');
  });
});

test('small context or a stale session: no status bar hint and no advice; a stale one is labelled "Last session"', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    writeProjects(projects, { 'hub/small.jsonl': [req(L(2026, 10, 10, 11, 55), 'small', 30000)] });
    ext.activate(ctx);
    assert.ok(!vs.items[0].text.includes('ctx'), vs.items[0].text);
    const md = vs.items[0].tooltip.value;
    assert.ok(md.includes('This session') && md.includes('30k / 200k · 15%') && !md.includes('re-sends'), md);
    // two hours later the same session is no longer "active"
    ext._test.setClock(() => L(2026, 10, 10, 14, 30));
    writeProjects(projects, { 'hub/small.jsonl': [req(L(2026, 10, 10, 11, 55), 'small', 190000)] });
    ext._test.refresh();
    assert.ok(!vs.items[0].text.includes('ctx'), 'stale big session shows no hint: ' + vs.items[0].text);
    assert.ok(vs.items[0].tooltip.value.includes('Last session'));
    assert.strictEqual(vs.infos.length, 0, 'and never nudges');
  });
});

test('settings: contextWindow changes the percentage; contextHintAtPercent moves the hint', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; vs.settings.contextWindow = 1000000; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    writeProjects(projects, { 'hub/a.jsonl': [req(L(2026, 10, 10, 11, 55), 'a', 142000)] });
    ext.activate(ctx);
    assert.ok(!vs.items[0].text.includes('ctx'), '142k of a 1M window is 14%: no hint');
    vs.settings.contextHintAtPercent = 10;
    for (const cb of vs.cfgListeners) cb({ affectsConfiguration: (s) => s === 'claudeUsage' });
    assert.ok(vs.items[0].text.endsWith('· ctx 142k'), vs.items[0].text);
    assert.ok(vs.items[0].tooltip.value.includes('142k / 1M · 14%'));
  });
});

test('the nudge fires once per session at the threshold, persists across refreshes, and a new session gets its own', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects, store }) => {
    let now = L(2026, 10, 10, 12, 0);
    ext._test.setClock(() => now);
    writeProjects(projects, { 'hub/a.jsonl': [req(L(2026, 10, 10, 11, 50), 'A', 120000)] });
    ext.activate(ctx);
    assert.strictEqual(vs.infos.length, 0, '120k is under the 150k default');
    writeProjects(projects, { 'hub/a.jsonl': [req(L(2026, 10, 10, 11, 50), 'A', 120000), req(L(2026, 10, 10, 11, 55), 'A', 160000)] });
    ext._test.refresh();
    assert.strictEqual(vs.infos.length, 1);
    const n = vs.infos[0];
    assert.ok(/context is 160k tokens \(80% of 200k\)/.test(n.m) && /\$0\.048 per request/.test(n.m) && /\/compact/.test(n.m) && /\/clear/.test(n.m), n.m);
    assert.deepStrictEqual(n.buttons, ['Open Waste Report', 'Dismiss']);
    assert.deepStrictEqual(store.contextNudged, ['A'], 'remembered BEFORE showing, so it can never repeat');
    for (let i = 0; i < 4; i++) ext._test.refresh();
    writeProjects(projects, { 'hub/a.jsonl': [req(L(2026, 10, 10, 11, 55), 'A', 175000), req(L(2026, 10, 10, 11, 58), 'A', 190000)] });
    ext._test.refresh();
    assert.strictEqual(vs.infos.length, 1, 'never nags the same session again, even when it grows');
    // a different session crossing the threshold is a separate, single notice
    now = L(2026, 10, 10, 15, 0);
    writeProjects(projects, { 'hub/b.jsonl': [req(L(2026, 10, 10, 14, 55), 'B', 155000)] });
    ext._test.refresh(); ext._test.refresh();
    assert.strictEqual(vs.infos.length, 2);
    assert.deepStrictEqual(store.contextNudged, ['A', 'B']);
  });
});

test('the nudge is configurable and can be turned off; it ignores sessions that are not active', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; vs.settings.contextNudgeAt = 0; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    writeProjects(projects, { 'hub/a.jsonl': [req(L(2026, 10, 10, 11, 55), 'A', 190000)] });
    ext.activate(ctx);
    assert.strictEqual(vs.infos.length, 0, '0 = off');
    assert.ok(vs.items[0].text.includes('ctx 190k'), 'the status bar hint is independent of the nudge');
    vs.settings.contextNudgeAt = 100000;
    for (const cb of vs.cfgListeners) cb({ affectsConfiguration: (s) => s === 'claudeUsage' });
    assert.strictEqual(vs.infos.length, 1, 'a lower threshold fires for the current session');
  });
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 18, 0));
    writeProjects(projects, { 'hub/old.jsonl': [req(L(2026, 10, 10, 9, 0), 'old', 190000)] });
    ext.activate(ctx);
    assert.strictEqual(vs.infos.length, 0, 'a finished session from this morning gets no notice');
  });
});

test('"Open Waste Report" in the nudge opens the report', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; vs.nextInfo = 'Open Waste Report'; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    writeProjects(projects, { 'hub/a.jsonl': [req(L(2026, 10, 10, 11, 55), 'A', 170000)] });
    ext.activate(ctx);
    await tick(); await tick();
    assert.ok(vs.panels.some((p) => p.type === 'claudeUsageWaste'));
  });
});

test('with several windows open, the session in THIS window\'s folder wins over a newer one elsewhere (Windows paths, any case)', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; vs.workspace.workspaceFolders = [{ uri: { fsPath: 'c:\\users\\eli\\WORK\\hub' } }]; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    writeProjects(projects, {
      'hub/mine.jsonl': [req(L(2026, 10, 10, 11, 30), 'mine', 120000)],
      'other/theirs.jsonl': [asst({ at: L(2026, 10, 10, 11, 55), sid: 'theirs', cwd: 'D:\\play\\other', usage: { input: 5, read: 80000, output: 10 } })],
    });
    ext.activate(ctx);
    assert.ok(vs.items[0].text.endsWith('· ctx 120k'), vs.items[0].text);
    assert.ok(vs.items[0].tooltip.value.includes('feature/sales') || vs.items[0].tooltip.value.includes('120k / 200k'));
  });
});

test('month rollover regression: on the 1st the headline is $0.00 again, while "this session" still reports the session\'s own total', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    writeProjects(projects, { 'hub/night.jsonl': [asst({ at: L(2026, 9, 30, 23, 50), sid: 'night', cwd: HUB, usage: { output: M15, read: 100000 } })] }); // $15 + $0.03
    ext._test.setClock(() => L(2026, 9, 30, 23, 55));
    ext.activate(ctx);
    assert.ok(vs.items[0].text.startsWith('$(pulse) $15.03'));
    ext._test.setClock(() => L(2026, 10, 1, 0, 1));
    ext._test.refresh();
    assert.ok(vs.items[0].text.startsWith('$(pulse) $0.00 ○○○○○ 0%'), vs.items[0].text);
    const md = vs.items[0].tooltip.value;
    assert.ok(md.includes('## $0.00 / $1,000') && md.includes('October 2026') && md.includes('**$15.03**'), md);
  });
});

test('Waste Report command: locked-down webview, same CSP as the dashboard, live updates, reuse and recreate', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx, projects }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    writeProjects(projects, { 'hub/a.jsonl': [req(L(2026, 10, 10, 11, 0), 'A', 100000)] });
    ext.activate(ctx);
    vs.cmds['claudeUsage.wasteReport']();
    assert.strictEqual(vs.panels.length, 1);
    const p = vs.panels[0];
    assert.strictEqual(p.type, 'claudeUsageWaste'); assert.strictEqual(p.title, 'Claude Usage: Waste Report');
    assert.strictEqual(p.opts.enableScripts, false); assert.deepStrictEqual(p.opts.localResourceRoots, []);
    assert.deepStrictEqual(p.opts.enableCommandUris.sort(), ['claudeUsage.installHooks', 'claudeUsage.refresh', 'claudeUsage.showDetails']);
    assert.ok(p.webview.html.includes(`default-src 'none'`) && p.webview.html.includes('Waste Report') && p.webview.html.includes('Most expensive sessions'));
    assert.ok(!/<script/i.test(p.webview.html));
    const before = p.webview.html;
    writeProjects(projects, { 'hub/b.jsonl': [req(L(2026, 10, 10, 11, 30), 'B', 50000, { usage: { output: M15 } })] });
    ext._test.refresh();
    assert.notStrictEqual(p.webview.html, before, 'open report follows new usage');
    vs.cmds['claudeUsage.wasteReport'](); assert.strictEqual(vs.panels.length, 1, 'reuses the panel');
    p._dispose(); vs.cmds['claudeUsage.wasteReport'](); assert.strictEqual(vs.panels.length, 2);
    // the dashboard links to it
    vs.cmds['claudeUsage.showDetails']();
    const dash = vs.panels[2];
    assert.ok(dash.opts.enableCommandUris.includes('claudeUsage.wasteReport'));
    assert.ok(dash.webview.html.includes('command:claudeUsage.wasteReport') && dash.webview.html.includes('Current session') && dash.webview.html.includes('By branch (feature)') && dash.webview.html.includes('Recent sessions'));
  });
});

test('no sessions yet (fresh install): no hint, no session section, nothing breaks', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12, 0));
    ext.activate(ctx);
    assert.strictEqual(vs.items[0].text, '$(pulse) $0.00 ○○○○○ 0%');
    assert.ok(!vs.items[0].tooltip.value.includes('This session'));
    vs.cmds['claudeUsage.showDetails'](); vs.cmds['claudeUsage.wasteReport']();
    assert.ok(vs.panels[0].webview.html.includes('No sessions this month yet'));
    assert.ok(vs.panels[1].webview.html.includes('No sessions this month yet'));
  });
});
