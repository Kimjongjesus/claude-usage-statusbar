'use strict';
// Orchestration hub: session state, per-project rollup, money-burner flags, the page and its links.
const assert = require('assert');
const { test } = require('./harness');
const { tmpdir, writeProjects, asst, userLine, titleLine } = require('./helpers');
const { summarize } = require('../lib/usage');
const { analyze } = require('../lib/waste');
const hub = require('../lib/hub');
const { render } = require('../lib/hub-view');

const L = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);
const NOW = L(2026, 10, 14, 15, 0);
const min = (n) => new Date(+NOW - n * 60000);
const SHOP = 'C:\\Users\\Alex\\work\\shop', API = 'C:\\Users\\Alex\\work\\api';

test('session state: waiting after end_turn, active while working, waiting on a stuck tool call, idle when old', () => {
  const st = (x) => hub.sessionState(x, NOW).state;
  assert.strictEqual(st({ lastCtxAt: min(3), lastStop: 'end_turn' }), 'waiting', 'Claude finished its turn 3 min ago');
  assert.strictEqual(st({ lastCtxAt: min(59), lastStop: 'end_turn' }), 'waiting');
  assert.strictEqual(st({ lastCtxAt: min(61), lastStop: 'end_turn' }), 'idle', 'over an hour');
  assert.strictEqual(st({ lastCtxAt: min(1), lastStop: 'tool_use' }), 'active', 'tool running');
  const stuck = hub.sessionState({ lastCtxAt: min(5), lastStop: 'tool_use' }, NOW);
  assert.strictEqual(stuck.state, 'waiting'); assert.ok(/permission/.test(stuck.why));
  assert.strictEqual(st({ lastCtxAt: min(4), lastStop: 'end_turn', lastUserAt: min(1) }), 'active', 'a new prompt came after the answer');
  assert.strictEqual(st({ lastCtxAt: min(30), lastStop: 'end_turn', lastUserAt: min(12) }), 'idle', 'prompt with no answer for 12 min (interrupted)');
  assert.strictEqual(st({ lastCtxAt: min(2), lastStop: '' }), 'waiting', 'older logs without stop_reason count as a finished turn');
  assert.strictEqual(st({}), 'idle');
  assert.strictEqual(st({ lastCtxAt: new Date(+NOW + 30000), lastStop: 'tool_use' }), 'active', 'clock skew is not negative age');
});

function fixture() {
  const root = tmpdir('hub-');
  const big = { read: 170000, write5m: 2000, output: 300 };
  writeProjects(root, {
    // shop: a waiting Opus session with a big context and routine Read/Grep work; earlier this month it went cold
    'shop/w.jsonl': [
      titleLine('W', 'Checkout <b>redesign</b>'),
      asst({ at: L(2026, 10, 14, 9, 0), sid: 'W', cwd: SHOP, branch: 'feature/checkout', model: 'claude-opus-4-5', usage: { write5m: 40000, output: 900 } }),
      asst({ at: L(2026, 10, 14, 11, 0), sid: 'W', cwd: SHOP, branch: 'feature/checkout', model: 'claude-opus-4-5', usage: { write5m: 60000, output: 900 } }), // 2 h gap -> cold restart
      ...Array.from({ length: 40 }, (_, i) => asst({ at: new Date(+L(2026, 10, 14, 11, 1) + i * 90000), sid: 'W', cwd: SHOP, branch: 'feature/checkout', model: 'claude-opus-4-5', usage: { read: 60000 + i * 3000, write5m: 500, output: 200 }, tools: [{ name: 'Read', input: { file_path: SHOP + '\\a.ts' } }], stop: 'tool_use' })),
      asst({ at: min(4), sid: 'W', cwd: SHOP, branch: 'feature/checkout', model: 'claude-opus-4-5', usage: big, stop: 'end_turn' }),
    ],
    // shop: an active Sonnet session (prompt just sent)
    'shop/a.jsonl': [
      asst({ at: min(6), sid: 'A', cwd: SHOP, branch: 'fix/tax', usage: { write5m: 20000, output: 500 }, stop: 'end_turn' }),
      userLine({ at: min(1), sid: 'A', cwd: SHOP }),
    ],
    // api: an idle session from last week, and a subagent line that must not count as the main session's activity
    'api/i.jsonl': [
      asst({ at: L(2026, 10, 7, 10), sid: 'I', cwd: API, branch: 'main', usage: { write5m: 30000, output: 4000 }, stop: 'end_turn' }),
      userLine({ at: min(2), sid: 'I', cwd: API, side: true }),
    ],
    // last month only: not in the month list, not live
    'api/old.jsonl': [asst({ at: L(2026, 9, 20, 10), sid: 'OLD', cwd: API, usage: { output: 9000 }, stop: 'end_turn' })],
  });
  const s = summarize({ dirs: [root], now: NOW });
  const rep = analyze(s, { ctxThreshold: 150000 });
  return { s, rep, h: hub.buildHub(s, rep, { now: NOW, ctxThreshold: 150000, contextWindow: 200000, workspaceDirs: ['c:\\users\\alex\\work\\shop'] }) };
}

test('summarize records stop_reason, the last main-conversation user line and the first-request context per session', () => {
  const { s } = fixture();
  const by = Object.fromEntries(s.sessions.map((x) => [x.sid, x]));
  assert.strictEqual(by.W.lastStop, 'end_turn');
  assert.strictEqual(+by.A.lastUserAt, +min(1));
  assert.strictEqual(by.I.lastUserAt, null, 'a subagent (sidechain) line is not the main session\'s activity');
  assert.strictEqual(by.W.firstCtx, 40000);
});

test('hub: projects with month cost, share and live counts; sessions with branch, model, state, context, cost', () => {
  const { s, h } = fixture();
  assert.deepStrictEqual(h.projects.map((p) => p.name), ['shop', 'api']);
  const shop = h.projects[0];
  assert.strictEqual(shop.live, 2); assert.strictEqual(shop.waiting, 1); assert.strictEqual(shop.active, 1); assert.strictEqual(shop.sessions, 2);
  assert.ok(Math.abs(h.projects.reduce((a, p) => a + p.share, 0) - 100) < 1e-6, 'shares add up to 100%');
  assert.ok(Math.abs(shop.monthUsd - s.byProject.shop) < 1e-9);
  assert.strictEqual(h.projects[1].live, 0);
  assert.deepStrictEqual(h.live.map((x) => [x.sid, x.state]), [['W', 'waiting'], ['A', 'active']], 'waiting first');
  const W = h.live[0];
  assert.strictEqual(W.branch, 'feature/checkout'); assert.strictEqual(W.modelLabel, 'Opus 4.5'); assert.strictEqual(W.ctx, 172000);
  assert.strictEqual(W.inWorkspace, true, 'case-insensitive Windows path match with the open folder');
  assert.ok(!h.sessions.some((x) => x.sid === 'OLD'), 'last month only');
  assert.deepStrictEqual(h.sessions.map((x) => x.sid), h.sessions.slice().sort((a, b) => b.monthUsd - a.monthUsd).map((x) => x.sid), 'by cost');
  assert.deepStrictEqual(h.totals, Object.assign({}, h.totals, { live: 2, waiting: 1, active: 1, projects: 2, sessions: 3 }));
  assert.strictEqual(hub.hubStatusText(h.totals), '$(bell) 1 waiting · 2 live');
  assert.strictEqual(hub.hubStatusText({ live: 3, waiting: 0 }), '$(layers) 3 live');
  assert.strictEqual(hub.hubStatusText({ live: 0, waiting: 0 }), '$(layers) Hub');
});

test('hub flags reuse the waste-report rules: bloated context, cold-cache restarts, expensive model on routine work', () => {
  const { h, rep } = fixture();
  const W = h.sessions.find((x) => x.sid === 'W');
  const kinds = W.flags.map((x) => x.kind).sort();
  assert.deepStrictEqual(kinds, ['bloat', 'cold', 'model']);
  assert.ok(W.flags.every((x) => x.heuristic === true), 'every flag is tagged heuristic');
  assert.strictEqual(W.flags.find((x) => x.kind === 'bloat').label, 'Context 172k');
  assert.strictEqual(rep.perSession.W.restarts, 1);
  assert.ok(Math.abs(W.flags.find((x) => x.kind === 'model').usd - rep.perSession.W.saving) < 1e-9 && rep.perSession.W.saving >= hub.MODEL_FLAG_MIN_USD);
  assert.deepStrictEqual(h.sessions.find((x) => x.sid === 'A').flags, []);
  assert.strictEqual(h.totals.flaggedSessions, 1);
  // an idle session that was bloated earlier gets the "was bloated" flag, not the live context one
  const f2 = hub.flagsFor({ lastCtx: 190000, state: 'idle' }, { over: 3, resendUsd: 1.2, restarts: 0, saving: 0 }, { ctxThreshold: 150000 });
  assert.deepStrictEqual(f2.map((x) => [x.kind, x.label]), [['bloat', 'Bloated context']]);
  // without a waste report (status bar counts) only the live-context flag remains (it needs no analysis); states are the same
  const lite = hub.buildHub(fixture().s, null, { now: NOW });
  assert.deepStrictEqual(lite.sessions.find((x) => x.sid === 'W').flags.map((x) => x.kind), ['bloat']); assert.strictEqual(lite.totals.waiting, 1);
});

test('resume command only for plain session ids; findSession only returns rows the hub built', () => {
  assert.strictEqual(hub.resumeCommand('009a600f-6830-4be6-a298-ee1a7dc1547e'), 'claude --resume 009a600f-6830-4be6-a298-ee1a7dc1547e');
  for (const bad of ['', 'x; rm -rf ~', '$(whoami)', '-r', 'a b', 'a"b', null]) assert.strictEqual(hub.resumeCommand(bad), null, String(bad));
  const { h } = fixture();
  assert.strictEqual(hub.findSession(h, 'W').sid, 'W');
  assert.strictEqual(hub.findSession(h, 'nope'), null);
});

test('hub page: strict CSP, no scripts, escaped log text, command links carry only an op and a session id', () => {
  const { s, h } = fixture();
  const d = { pct: 42, budget: 1000 };
  const html = render(h, s, d, { nonce: 'N0NCE', updatedAt: NOW, handoffs: [] });
  assert.ok(html.includes("default-src 'none'; style-src 'nonce-N0NCE'"));
  assert.ok(!/<script/i.test(html) && !/\sstyle="/i.test(html) && !/\son\w+=/i.test(html));
  assert.ok(html.includes('Checkout &lt;b&gt;redesign&lt;/b&gt;') && !html.includes('<b>redesign'));
  assert.ok(html.includes('Waiting on you') && html.includes('Active') && html.includes('Live now') && html.includes('Projects') && html.includes('Sessions this month'));
  assert.ok(/class="tag">heuristic</.test(html));
  const links = [...html.matchAll(/href="command:claudeUsage\.hubAction\?([^"]+)"/g)].map((m) => JSON.parse(decodeURIComponent(m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"'))));
  assert.ok(links.length >= 4);
  for (const l of links) {
    assert.ok(Array.isArray(l) && l.length === 1);
    assert.deepStrictEqual(Object.keys(l[0]).sort(), ['op', 'sid']);
    assert.ok(['resume', 'folder'].includes(l[0].op));
  }
  assert.ok(!html.includes(SHOP.replace(/\\/g, '\\\\')) && !html.includes('Alex'), 'no folder paths (user names) on the page');
  assert.ok(html.includes('Set Up Plan Handoff'), 'empty handoff card points at the setup command');
});
