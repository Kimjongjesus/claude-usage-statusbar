'use strict';
// Window-resize regressions. Each test names the bug it guards; the browser sweep that found them is
// scripts/resize-sweep.py (dev only). These checks are string-level, so they stay dependency-free: they pin the
// markup and CSS rules that make the pages fit a narrow editor panel, a side bar or a zoomed window.
const assert = require('assert');
const { test } = require('./harness');
const { tmpdir, writeProjects, asst, userLine, titleLine } = require('./helpers');
const { summarize } = require('../lib/usage');
const { analyze } = require('../lib/waste');
const { derive } = require('../lib/metrics');
const hub = require('../lib/hub');
const { render: renderDash, CSS } = require('../lib/dashboard');
const { render: renderHub } = require('../lib/hub-view');
const { render: renderWaste } = require('../lib/waste-view');

const L = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h || 0, mi || 0, 0);
const NOW = L(2026, 10, 14, 15, 0);
const min = (n) => new Date(+NOW - n * 60000);
const SHOP = 'C:\\Users\\Alex\\work\\shop';
const LONG_BRANCH = 'feature/JIRA-48213-refactor-the-entire-notification-preferences-and-delivery-scheduling-subsystem';

// A month with a waiting Opus session (big context, repeated reads, a cold restart), a long branch name, and a
// previous month, so every table on all three pages has rows.
function pages() {
  const root = tmpdir('layout-');
  const lines = [
    titleLine('W', 'Investigate intermittent failures in the nightly reconciliation-job-with-an-extremely-long-hyphenated-identifier-name'),
    asst({ at: L(2026, 10, 14, 9, 0), sid: 'W', cwd: SHOP, branch: LONG_BRANCH, model: 'claude-opus-4-5', usage: { write5m: 40000, output: 900 } }),
    asst({ at: L(2026, 10, 14, 11, 0), sid: 'W', cwd: SHOP, branch: LONG_BRANCH, model: 'claude-opus-4-5', usage: { write5m: 60000, output: 900 } }),
    ...Array.from({ length: 30 }, (_, i) => asst({ at: new Date(+L(2026, 10, 14, 11, 1) + i * 90000), sid: 'W', cwd: SHOP, branch: LONG_BRANCH, model: 'claude-opus-4-5',
      usage: { read: 120000 + i * 2000, write5m: 500, output: 200 }, tools: [{ name: 'Read', input: { file_path: SHOP + '\\src\\a.ts' } }], stop: 'tool_use' })),
    asst({ at: min(4), sid: 'W', cwd: SHOP, branch: LONG_BRANCH, model: 'claude-opus-4-5', usage: { read: 170000, write5m: 2000, output: 300 }, stop: 'end_turn' }),
    userLine({ at: min(1), sid: 'W', cwd: SHOP }),
  ];
  writeProjects(root, { 'shop/w.jsonl': lines });
  const s = summarize({ dirs: [root], now: NOW });
  const d = derive(s, { budget: 1000, warn: 75, crit: 90 });
  const rep = analyze(s, { ctxThreshold: 150000 });
  const h = hub.buildHub(s, rep, { now: NOW, ctxThreshold: 150000, contextWindow: 200000, workspaceDirs: [] });
  const handoffs = [{ name: 'a.md', rootIndex: 0, relPath: '.claude/handoffs/a.md', mtimeMs: +min(2), title: 'Plan', project: 'shop', suggestion: { model: 'opus', effort: 'high', reason: 'multi-module' }, status: 'new' }];
  return {
    dash: renderDash(s, d, { nonce: 'n', updatedAt: NOW, history: { '2026-09': 640.5 } }),
    hub: renderHub(h, s, d, { nonce: 'n', updatedAt: NOW, handoffs, handoffHook: true }),
    waste: renderWaste(s, d, rep, { nonce: 'n', updatedAt: NOW }),
  };
}

const rule = (sel) => { // the declaration block of the first rule whose selector list is exactly `sel`
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(^|\\n|\\}\\s*)' + esc + '\\s*\\{([^}]*)\\}').exec(CSS);
  return m ? m[2] : null;
};

test('resize: every wide table sits in a sideways-scrolling box instead of overflowing its card (hub and waste report at narrow widths)', () => {
  const p = pages();
  for (const name of ['hub', 'waste']) {
    const tables = p[name].match(/<table class="t[ "]/g) || [];
    assert.ok(tables.length >= 2, name + ': fixture should render several tables');
    const wrapped = p[name].match(/<div class="scroll"[^>]*><table class="t[ "]/g) || [];
    assert.strictEqual(wrapped.length, tables.length, name + ': every table is wrapped in .scroll');
  }
  assert.ok(/<div class="scroll"[^>]*><table class="hist"/.test(p.dash), 'dashboard previous-months table is wrapped too');
  assert.ok(/<div class="scroll" tabindex="0"/.test(p.hub), 'scroll boxes are keyboard-focusable');
  assert.ok(/overflow-x:\s*auto/.test(rule('.scroll') || ''), '.scroll scrolls sideways');
});

test('resize: grid columns can shrink below their content, so long project / branch names no longer widen the whole dashboard', () => {
  const decls = CSS.match(/grid-template-columns:[^;}]*/g) || [];
  assert.ok(decls.length >= 8, 'found the grid rules');
  for (const dcl of decls) {
    const bare = dcl.replace(/minmax\(0,\s*1fr\)/g, '').match(/(^|[\s(,])\d*\.?\d*fr\b/);
    assert.ok(!bare, 'grid column must be minmax(0, 1fr), not a bare fr (a bare fr never shrinks below its nowrap text): ' + dcl);
  }
  assert.ok(/min-width:\s*0/.test(rule('.card') || ''), 'cards may shrink inside a flex/grid parent');
  const html = pages().dash;
  assert.ok(html.includes('class="cols"'), 'two-column block present');
});

test('resize: chart axis text stays at least 8px, the chart scrolls inside its card instead of shrinking below that', () => {
  const chart = rule('.chart') || '';
  const minW = Number((/min-width:\s*(\d+)px/.exec(chart) || [])[1]);
  assert.ok(minW > 0, '.chart has a min-width');
  // axis labels are 11 SVG units in a 720-unit viewBox: scale = minW / 720
  assert.ok(11 * minW / 720 >= 8, `axis text would render at ${(11 * minW / 720).toFixed(1)}px`);
  assert.ok(/overflow-x:\s*auto/.test(rule('.chartbox') || ''), '.chartbox scrolls sideways');
  const html = pages().dash;
  assert.strictEqual((html.match(/<div class="chartbox"><svg class="chart"/g) || []).length, 2, 'daily and pace charts are both wrapped');
});

test('resize: header buttons and title wrap on a very narrow panel instead of running off the right edge', () => {
  assert.ok(/flex-wrap:\s*wrap/.test(rule('.actions') || ''), '.actions wraps');
  assert.ok(/flex-wrap:\s*wrap/.test(rule('h1') || ''), 'h1 (title + month pill) wraps');
  assert.ok(/flex-wrap:\s*wrap/.test(rule('.head') || ''), '.head wraps');
});

test('resize: muted detail lines (project, branch, time, tips) wrap instead of being cut off with an ellipsis nobody can read', () => {
  const m = /ul\.rows \.sub[^{]*\{([^}]*)\}/.exec(CSS);
  assert.ok(m && /white-space:\s*normal/.test(m[1]) && /overflow-wrap:\s*anywhere/.test(m[1]), 'wrapping rule for row sub lines');
  assert.ok(/p\.sub/.test(m[0]) && /section\.card > \.sub/.test(m[0]) && /td:first-child \.sub/.test(m[0]), 'covers tips, the current-session line and hub rows');
  assert.ok(/overflow-wrap:\s*anywhere/.test(rule('footer p') || ''), 'footer lines (scanned folders) wrap');
});

test('resize: KPI row collapses to two columns at the same breakpoint as the dashboard grids (no 4 cramped columns on a side panel)', () => {
  const media = /@media \(max-width: 720px\)\s*\{([\s\S]*?)\n`;|@media \(max-width: 720px\)\s*\{([\s\S]*)$/.exec(CSS);
  const body = (media && (media[1] || media[2])) || '';
  assert.ok(/\.kpis\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(body), '.kpis is 2 columns at <= 720px');
  assert.ok(/\.tokens\s*\{\s*grid-template-columns:\s*repeat\(2/.test(body) && /\.stats\s*\{\s*grid-template-columns:\s*repeat\(2/.test(body), 'tokens and stats too');
});

test('resize: name + figure rows wrap (figure drops under the name) instead of overlapping when zoomed in on a narrow panel', () => {
  assert.ok(/flex-wrap:\s*wrap/.test(rule('.rowtop') || ''), '.rowtop wraps');
  const nm = /\.rowtop \.name\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(nm && /min-width:\s*0/.test(nm[1]) && /flex:\s*1 1 /.test(nm[1]), 'name may shrink to an ellipsis but not below a small basis');
});

test('resize: budget ring never wider than its card, and figure grids go single-column on a ~260px window (150-200% zoom)', () => {
  assert.ok(/max-width:\s*100%/.test(rule('.ring') || ''), '.ring max-width 100%');
  assert.ok(/overflow-wrap:\s*anywhere/.test(rule('h1') || ''), 'a long word in the title breaks instead of overflowing');
  const m = /@media \(max-width: 260px\)\s*\{([^\n]*)\}\s*(\n|$)/.exec(CSS);
  assert.ok(m && /\.stats/.test(m[1]) && /\.tokens/.test(m[1]) && /\.kpis/.test(m[1]) && /minmax\(0,\s*1fr\)/.test(m[1]), 'stats, tokens and kpis are one column at <= 260px');
  assert.ok(/\.ring-sub\s*\{\s*display:\s*none/.test(m[1]), 'the ring caption (10px SVG text) is dropped once the ring would shrink it below legibility; the percentage stays');
  const v = /@media \(max-width: 400px\)\s*\{\s*\.rowtop \.val\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(v && /white-space:\s*normal/.test(v[1]), 'figures in name/figure rows may wrap on a very narrow window instead of widening the page');
});

test('resize: hub project names that get an ellipsis carry the full name as a tooltip', () => {
  assert.ok(/<div class="name" title="shop">shop<\/div>/.test(pages().hub), 'project row has a title');
});
