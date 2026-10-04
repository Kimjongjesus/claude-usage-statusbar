'use strict';
const assert = require('assert');
const { test } = require('./harness');
const f = require('../lib/format');
const { derive, decideNotification, msToNextMidnight, mergeModels, topN } = require('../lib/metrics');
const { statusText, tooltipMarkdown } = require('../lib/tooltip');
const { render } = require('../lib/dashboard');

function sample(over) {
  const s = Object.assign({
    month: '2026-10', year: 2026, monthIndex: 9, daysInMonth: 31, dayOfMonth: 14, elapsedDays: 13.5, messages: 420,
    totalUsd: 412.3, assumedModels: [], dirs: ['/home/eli/.claude/projects'], history: {},
    daily: new Array(31).fill(0), byModel: { 'claude-opus-4-5-20251101': 300, 'claude-sonnet-4-5-20250929': 100, 'claude-haiku-4-5-20251001': 12.3 },
    byProject: { 'payments-api': 250, 'infra <tools>': 162.3 }, tokens: { input: 1200000, output: 800000, cacheWrite: 3400000, cacheRead: 91000000 },
    lastMessageAt: new Date(2026, 9, 14, 11, 20),
  }, over || {});
  for (let i = 0; i < 14; i++) s.daily[i] = 20 + i * 3;
  return s;
}
const C = { budget: 1000, warn: 75, crit: 90 };

test('format: money, bar, model labels', () => {
  assert.strictEqual(f.usd(1234.5), '$1,234.50');
  assert.strictEqual(f.usdShort(412.3), '$412');
  assert.strictEqual(f.usdShort(41.2), '$41.20');
  assert.strictEqual(f.usdWhole(1000), '$1,000');
  assert.strictEqual(f.bar(41, 5), '●●○○○');
  assert.strictEqual(f.bar(0, 5), '○○○○○');
  assert.strictEqual(f.bar(250, 5), '●●●●●');
  assert.strictEqual(f.modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.strictEqual(f.modelLabel('claude-opus-4-20250514'), 'Opus 4');
  assert.strictEqual(f.modelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.strictEqual(f.modelLabel('claude-3-5-haiku-20241022'), 'Haiku 3.5');
  assert.strictEqual(f.modelLabel('mystery'), 'mystery');
  assert.deepStrictEqual(mergeModels({ 'claude-sonnet-4-5-20250929': 1, 'claude-sonnet-4-5': 2 }), { 'Sonnet 4.5': 3 });
  assert.strictEqual(topN({ a: 3, b: 1 }, 1)[0].share, 75);
});

test('status bar text is narrow and carries icon, amount, bar and percent', () => {
  const ok = statusText(sample(), derive(sample(), C));
  assert.strictEqual(ok, '$(pulse) $412 ●●○○○ 41%');
  assert.ok(ok.length <= 24);
  assert.ok(statusText(sample({ totalUsd: 800 }), derive(sample({ totalUsd: 800 }), C)).startsWith('$(warning)'));
  assert.ok(statusText(sample({ totalUsd: 950 }), derive(sample({ totalUsd: 950 }), C)).startsWith('$(error)'));
  assert.strictEqual(derive(sample({ totalUsd: 999.9 }), C).level, 'crit');
  assert.ok(statusText(sample({ totalUsd: 999.9 }), derive(sample({ totalUsd: 999.9 }), C)).endsWith('99%')); // never claims 100% early
});

test('hover tooltip has spent/budget, bar, remaining, projection, safe daily, days left, top 3 models', () => {
  const s = sample();
  const md = tooltipMarkdown(s, derive(s, C), { links: true });
  for (const want of ['## $412.30 / $1,000', '█', 'Remaining', '$587.70', 'Projected month end', 'Safe daily spend', 'Days left', 'resets November 1',
    'Opus 4.5', 'Sonnet 4.5', 'Haiku 4.5', 'Estimate from local logs', 'command:claudeUsage.setBudget']) {
    assert.ok(md.includes(want), 'tooltip missing ' + want + '\n' + md);
  }
  assert.ok(!md.includes('http'), 'tooltip has no URLs');
  const many = sample({ byModel: { a1: 5, b2: 4, c3: 3, d4: 2 } });
  assert.strictEqual((tooltipMarkdown(many, derive(many, C)).match(/^\| (a1|b2|c3|d4) /gm) || []).length, 3);
});

test('hover flags over-budget projection and unknown pricing; escapes log-derived text', () => {
  const s = sample({ totalUsd: 900, assumedModels: ['weird*model'] });
  const md = tooltipMarkdown(s, derive(s, C));
  assert.ok(md.includes('over budget'));
  assert.ok(md.includes('weird\\*model'));
});

test('dashboard: complete, themed, escaped, and carries the estimate disclosure', () => {
  const s = sample();
  const html = render(s, derive(s, C), { nonce: 'abc123', updatedAt: new Date(2026, 9, 14, 12, 0, 5), history: { '2026-09': 640.5, '2026-08': 300 } });
  for (const want of ['By model', 'By project', 'Daily spend', 'Pace vs budget', 'Tokens this month', 'Projected month end', 'Safe daily spend',
    'Last updated 12:00:05', 'Estimate from local Claude Code logs', 'Previous months', 'September 2026', '<svg', 'var(--vscode-editor-background)', 'var(--vscode-charts-blue',
    'command:claudeUsage.setBudget', 'Opus 4.5', 'payments-api']) {
    assert.ok(html.includes(want), 'dashboard missing ' + want);
  }
  assert.ok(html.includes('infra &lt;tools&gt;') && !html.includes('infra <tools>'), 'project names are HTML-escaped');
});

test('dashboard: strict CSP and no remote or scriptable content at all', () => {
  const s = sample();
  const html = render(s, derive(s, C), { nonce: 'n0nce' });
  assert.ok(html.includes(`content="default-src 'none'; style-src 'nonce-n0nce'"`), 'CSP meta');
  assert.ok(!/<script/i.test(html), 'no script tags');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no inline style attributes (CSP would block them)');
  assert.ok(!/https?:|\/\//.test(html), 'no URLs of any kind');
  assert.ok(!/<(link|img|iframe|object|embed|form)\b/i.test(html), 'no resource-loading elements');
  assert.ok(!/@import|url\(/i.test(html), 'no CSS fetches');
  assert.ok(!/\ssrc\s*=/i.test(html), 'no src attributes');
  assert.ok(/<style nonce="n0nce">/.test(html));
});

test('dashboard renders edge states: empty month, over budget, no logs', () => {
  const empty = sample({ totalUsd: 0, messages: 0, byModel: {}, byProject: {}, daily: new Array(31).fill(0), dirs: [], lastMessageAt: null, elapsedDays: 0.2, dayOfMonth: 1 });
  const h1 = render(empty, derive(empty, C), { nonce: 'x' });
  assert.ok(h1.includes('Nothing logged this month yet.') && h1.includes('needs a full day of data') && h1.includes('no Claude Code projects folder found'));
  assert.ok(!h1.includes('NaN') && !h1.includes('undefined'));
  const over = sample({ totalUsd: 1300 });
  const h2 = render(over, derive(over, C), { nonce: 'x' });
  assert.ok(h2.includes('Critical') && h2.includes('over budget') && !h2.includes('NaN'));
  assert.ok(tooltipMarkdown(empty, derive(empty, C)).includes('No Claude Code logs found'));
});

test('threshold notifications: once per month per threshold', () => {
  let r = decideNotification(50, 75, 90, '2026-10', undefined);
  assert.strictEqual(r.level, null);
  r = decideNotification(76, 75, 90, '2026-10', r.state); assert.strictEqual(r.level, 'warn');
  r = decideNotification(80, 75, 90, '2026-10', r.state); assert.strictEqual(r.level, null, 'warn does not repeat');
  r = decideNotification(91, 75, 90, '2026-10', r.state); assert.strictEqual(r.level, 'crit');
  r = decideNotification(99, 75, 90, '2026-10', r.state); assert.strictEqual(r.level, null, 'crit does not repeat');
  r = decideNotification(76, 75, 90, '2026-11', r.state); assert.strictEqual(r.level, 'warn', 'a new month re-arms');
  r = decideNotification(95, 75, 90, '2026-12', r.state); assert.strictEqual(r.level, 'crit', 'jumping past both fires only crit');
  r = decideNotification(95, 75, 90, '2026-12', r.state); assert.strictEqual(r.level, null);
});

test('msToNextMidnight lands one second after local midnight, including across DST dates', () => {
  for (const [y, m, d, h] of [[2026, 9, 30, 23], [2026, 3, 7, 12], [2026, 10, 31, 3], [2026, 12, 31, 23]]) {
    const now = new Date(y, m - 1, d, h, 30);
    const at = new Date(now.getTime() + msToNextMidnight(now));
    assert.strictEqual(at.getHours() + ':' + at.getMinutes() + ':' + at.getSeconds(), '0:0:1', `${y}-${m}-${d}`);
    assert.strictEqual(at.getDate(), new Date(y, m - 1, d + 1).getDate());
  }
});
