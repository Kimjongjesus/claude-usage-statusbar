'use strict';
// Waste report: every number is derived from the logs; heuristics are labelled.
const assert = require('assert');
const path = require('path');
const { test } = require('./harness');
const { tmpdir, writeProjects, asst, toolResult, titleLine } = require('./helpers');
const { summarize } = require('../lib/usage');
const { derive } = require('../lib/metrics');
const { analyze } = require('../lib/waste');
const { render } = require('../lib/waste-view');
const { render: renderDash } = require('../lib/dashboard');

const L = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ` expected ${b}, got ${a}`);
const HUB = 'C:\\Users\\Eli\\work\\hub';

function scenario() {
  const root = tmpdir();
  const file = 'C:\\hub\\src\\app.ts';
  let n = 0;
  const read = (f, at, sid, chars) => {
    const id = 'rd' + (++n);
    return [asst({ at, sid, cwd: HUB, branch: 'feature/a', usage: { read: 1000, output: 50 }, tools: [{ id, name: 'Read', input: { file_path: f } }] }),
      toolResult({ at: new Date(+at + 1000), sid, toolUseId: id, chars })];
  };
  writeProjects(root, {
    'hub/s1.jsonl': [
      // S1 (Sonnet 4.5): cold start, normal turn, 29 min pause + big cache rewrite, then a bloated 160k request
      asst({ at: L(2026, 10, 10, 9, 0), sid: 'S1', cwd: HUB, branch: 'feature/a', usage: { input: 0, write5m: 50000, output: 1000 } }),
      asst({ at: L(2026, 10, 10, 9, 1), sid: 'S1', cwd: HUB, branch: 'feature/a', usage: { input: 10, read: 50000, write5m: 2000, output: 100 } }),
      asst({ at: L(2026, 10, 10, 9, 30), sid: 'S1', cwd: HUB, branch: 'feature/a', usage: { write5m: 52000, output: 100 } }),
      asst({ at: L(2026, 10, 10, 9, 31), sid: 'S1', cwd: HUB, branch: 'feature/a', usage: { read: 160000, output: 100 } }),
      titleLine('S1', 'Sales dashboard <img src=x onerror=alert(1)>'),
    ].concat(
      read(file, L(2026, 10, 10, 10, 0), 'S1', 4000),
      read(file, L(2026, 10, 10, 10, 5), 'S1', 4000),
      read('c:\\HUB\\src\\APP.ts', L(2026, 10, 10, 10, 9), 'S1', 4000), // same file, different case (Windows)
      read('C:\\hub\\src\\other.ts', L(2026, 10, 10, 10, 10), 'S1', 4000),
    ),
    'hub/s2.jsonl': read(file, L(2026, 10, 11, 9, 0), 'S2', 4000),
    // huge tool results
    'hub/s3.jsonl': (() => {
      const out = [];
      for (const [id, name, input, chars] of [['hb', 'Bash', { command: 'npm run build 2>&1' }, 80000], ['hr', 'Read', { file_path: 'C:\\hub\\dist\\bundle.js' }, 30000], ['hs', 'Bash', { command: 'ls' }, 19999]]) {
        const at = L(2026, 10, 12, 9, out.length);
        out.push(asst({ at, sid: 'S3', cwd: HUB, branch: 'main', usage: { output: 50 }, tools: [{ id, name, input }] }), toolResult({ at: new Date(+at + 1000), sid: 'S3', toolUseId: id, chars }));
      }
      return out;
    })(),
    // Opus session with routine (read-only, short) and non-routine requests
    'hub/s4.jsonl': [
      asst({ at: L(2026, 10, 13, 9, 0), sid: 'S4', cwd: HUB, branch: 'main', model: 'claude-opus-4-5-20251101', usage: { input: 1000, read: 20000, output: 300 }, tools: [{ name: 'Read', input: { file_path: 'C:\\q.ts' } }] }),
      asst({ at: L(2026, 10, 13, 9, 1), sid: 'S4', cwd: HUB, branch: 'main', model: 'claude-opus-4-5-20251101', usage: { input: 1000, read: 20000, output: 300 }, tools: [{ name: 'Grep', input: {} }, { name: 'Bash', input: { command: 'ls' } }] }),
      asst({ at: L(2026, 10, 13, 9, 2), sid: 'S4', cwd: HUB, branch: 'main', model: 'claude-opus-4-5-20251101', usage: { input: 1000, read: 20000, output: 2000 }, tools: [{ name: 'Read', input: { file_path: 'C:\\q.ts' } }] }), // long answer: not routine
      asst({ at: L(2026, 10, 13, 9, 3), sid: 'S4', cwd: HUB, branch: 'main', model: 'claude-opus-4-5-20251101', usage: { input: 1000, read: 20000, output: 300 }, tools: [{ name: 'Edit', input: { file_path: 'C:\\q.ts' } }] }), // edits: not routine
      asst({ at: L(2026, 10, 13, 9, 4), sid: 'S4', cwd: HUB, branch: 'main', model: 'claude-opus-4-5-20251101', usage: { input: 1000, read: 20000, output: 300 } }), // no tools: not routine
    ],
  });
  return summarize({ now: L(2026, 10, 15, 12), dirs: [root] });
}

test('waste: most expensive sessions are ranked by this month\'s cost and carry share, requests and peak context', () => {
  const s = scenario();
  const rep = analyze(s, { ctxThreshold: 150000 });
  assert.ok(rep.expensive.length >= 4);
  for (let i = 1; i < rep.expensive.length; i++) assert.ok(rep.expensive[i - 1].usd >= rep.expensive[i].usd);
  const s4 = rep.expensive.find((x) => x.sid === 'S4');
  assert.strictEqual(s4.messages, 5);
  assert.ok(Math.abs(rep.expensive.reduce((a, x) => a + x.share, 0) - 100) < 1e-6 || rep.expensive.length === 8);
  assert.strictEqual(rep.expensive.find((x) => x.sid === 'S1').peakCtx, 160000);
});

test('waste: cost split by token class adds up to the month total; cold start and expired-cache rewrites are separated', () => {
  const s = scenario();
  const rep = analyze(s, { ctxThreshold: 150000 });
  close(rep.split.total, s.totalUsd, 'split reconciles with the headline number');
  // cold start = first request of each session: S1 wrote 50k tokens at $3.75/M, the other sessions wrote nothing at their first request
  close(rep.coldStart.usd, 50000 * 3.75 / 1e6);
  assert.strictEqual(rep.coldStart.sessions, 4);
  // 29-minute pause then a 52k cache write: one rewrite, costing the write minus what a warm read would have cost
  assert.strictEqual(rep.coldRestarts.count, 1);
  close(rep.coldRestarts.usd, 52000 * 3.75 / 1e6);
  close(rep.coldRestarts.extraUsd, 52000 * 3.75 / 1e6 - 52000 * 0.3 / 1e6);
  assert.strictEqual(rep.coldRestarts.heuristic, true);
});

test('waste: context-bloat sessions price the tokens above the threshold at the cache-read rate', () => {
  const rep = analyze(scenario(), { ctxThreshold: 150000 });
  assert.strictEqual(rep.bloat.sessions.length, 1);
  const b = rep.bloat.sessions[0];
  assert.strictEqual(b.sid, 'S1'); assert.strictEqual(b.over, 1); assert.strictEqual(b.peakCtx, 160000);
  close(b.resendUsd, 10000 * 0.3 / 1e6);
  // a higher threshold means nothing is flagged
  assert.strictEqual(analyze(scenario(), { ctxThreshold: 400000 }).bloat.sessions.length, 0);
});

test('waste: repeated reads of the same file (case-insensitive on Windows paths) count the extra reads and their tokens', () => {
  const rep = analyze(scenario(), { ctxThreshold: 150000 });
  const top = rep.repeats.files[0];
  assert.strictEqual(top.file.toLowerCase(), 'c:\\hub\\src\\app.ts');
  assert.strictEqual(top.reads, 4); assert.strictEqual(top.sessions, 2);
  assert.strictEqual(top.extraReads, 2, 'S1 read it 3 times: 2 repeats; S2 read it once');
  assert.strictEqual(top.extraTokens, 2000, '2 x 4000 chars / 4');
  close(top.extraUsd, 2000 * 3.75 / 1e6);
  assert.ok(!rep.repeats.files.some((x) => /other\.ts/i.test(x.file)), 'a file read once is not a repeat');
  assert.strictEqual(rep.repeats.heuristic, true);
});

test('waste: huge tool results are listed with the tool and target; results under the limit are ignored', () => {
  const rep = analyze(scenario(), { ctxThreshold: 150000 });
  assert.strictEqual(rep.huge.count, 2);
  assert.deepStrictEqual(rep.huge.items.map((x) => [x.tool, x.tokens]), [['Bash', 20000], ['Read', 7500]]);
  assert.strictEqual(rep.huge.items[0].target, 'npm run build 2>&1');
  assert.strictEqual(rep.huge.totalTokens, 27500);
});

test('waste: model share, and the saving from moving ROUTINE requests to the next cheaper family, are priced from the logged tokens', () => {
  const rep = analyze(scenario(), { ctxThreshold: 150000 });
  const opus = rep.models.rows.find((r) => r.label === 'Opus 4.5');
  const sonnet = rep.models.rows.find((r) => r.label === 'Sonnet 4.5');
  assert.strictEqual(opus.requests, 5);
  assert.strictEqual(opus.routine, 2, 'only short read-only requests are routine');
  // each routine request: Opus 4.5 22,500 micro-dollars, Sonnet 4.5 13,500 -> 9,000 saved
  close(opus.saving, 2 * 9000 / 1e6);
  assert.strictEqual(opus.cheaper, 'Sonnet 4.5');
  assert.ok(sonnet.routine >= 4, 'Sonnet read requests are routine and could move to Haiku');
  assert.ok(sonnet.saving > 0 && sonnet.cheaper === 'Haiku 4.5');
  close(rep.models.totalSaving, opus.saving + sonnet.saving);
  assert.ok(/Read, Grep, Glob/.test(rep.models.routineDefinition) && /400 output tokens/.test(rep.models.routineDefinition), 'the heuristic is spelled out');
  close(rep.models.rows.reduce((a, r) => a + r.share, 0), 100, 'shares add to 100');
});

test('waste: no data yields an empty, renderable report (no crash on a fresh install)', () => {
  const root = tmpdir();
  const s = summarize({ now: L(2026, 10, 15), dirs: [root] });
  const rep = analyze(s, {});
  assert.strictEqual(rep.expensive.length, 0);
  const html = render(s, derive(s, { budget: 1000, warn: 75, crit: 90 }), rep, { nonce: 'n' });
  assert.ok(html.includes('No sessions this month yet') && html.includes('Waste Report'));
  assert.doesNotThrow(() => analyze({ year: 2026, monthIndex: 9, totalUsd: 0, sessions: [] }, {}), 'a summary without detail is tolerated');
});

test('waste view: strict CSP, no scripts / remote resources / inline styles, themed, heuristics labelled, log text escaped', () => {
  const s = scenario();
  const d = derive(s, { budget: 1000, warn: 75, crit: 90 });
  const html = render(s, d, analyze(s, { ctxThreshold: 150000 }), { nonce: 'abc123', updatedAt: L(2026, 10, 15, 12) });
  assert.ok(html.includes(`content="default-src 'none'; style-src 'nonce-abc123'"`));
  assert.ok(!/<script/i.test(html) && !/\son\w+\s*=/i.test(html.replace(/&lt;[^]*?&gt;/g, '')), 'no script or event handlers');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no inline style attributes');
  assert.ok(!/(src|href)\s*=\s*"https?:/i.test(html) && !/url\(\s*['"]?https?:/i.test(html) && !/@import/.test(html), 'no remote resources');
  assert.ok(html.includes('var(--vscode-editor-background)') && html.includes('var(--vscode-foreground)'), 'uses the VS Code theme variables');
  for (const want of ['Most expensive sessions', 'Cold start vs cache reads', 'Context-bloat sessions', 'Repeated reads of the same file', 'Huge tool results', 'Model share and routine work', 'Estimate from local Claude Code logs']) {
    assert.ok(html.includes(want), want);
  }
  assert.ok((html.match(/<span class="tag">heuristic<\/span>/g) || []).length >= 5, 'heuristic sections and rows are tagged');
  assert.ok(html.includes('Sales dashboard &lt;img src=x onerror=alert(1)&gt;'), 'titles from the logs are HTML-escaped');
  assert.ok(!html.includes('<img src=x'), 'no injected markup');
  assert.ok(html.includes('command:claudeUsage.installHooks') && html.includes('command:claudeUsage.showDetails'));
});

test('dashboard: sessions, branch breakdown and context card render, month headline stays first', () => {
  const s = scenario();
  const d = derive(s, { budget: 1000, warn: 75, crit: 90 });
  const html = renderDash(s, d, { nonce: 'n', context: { session: s.sessions[0], info: { tokens: 142000, window: 200000, pct: 71, warmPerRequest: 0.0426, coldPerRequest: 0.5325, model: 'claude-sonnet-4-5' }, advice: 'Each request re-sends about 142k tokens.', active: true, nudgeAt: 150000 } });
  assert.ok(html.indexOf('this month') < html.indexOf('Current session') && html.indexOf('Current session') < html.indexOf('Recent sessions'));
  for (const want of ['By branch (feature)', 'feature/a', 'Recent sessions', '142k / 200k', 'active now', 'command:claudeUsage.wasteReport']) assert.ok(html.includes(want), want);
  assert.ok(!/<script/i.test(html) && !/\sstyle\s*=/i.test(html));
});

test('dashboard footer shows the home folder as ~ (Windows and POSIX), leaves other paths alone', () => {
  const { tilde } = require('../lib/dashboard');
  assert.strictEqual(tilde('C:\\Users\\Eli\\.claude\\projects', 'C:\\Users\\Eli'), '~\\.claude\\projects');
  assert.strictEqual(tilde('c:\\users\\eli\\.claude\\projects', 'C:\\Users\\Eli\\'), '~\\.claude\\projects', 'case-insensitive, trailing slash ok');
  assert.strictEqual(tilde('/home/eli/.claude/projects', '/home/eli'), '~/.claude/projects');
  assert.strictEqual(tilde('D:\\logs\\projects', 'C:\\Users\\Eli'), 'D:\\logs\\projects');
  assert.strictEqual(tilde('C:\\Users\\Elias\\.claude', 'C:\\Users\\Eli'), 'C:\\Users\\Elias\\.claude', 'a longer sibling name is not the home folder');
  assert.strictEqual(tilde('/x/y', undefined), '/x/y');
  const s = scenario();
  const html = renderDash(s, derive(s, { budget: 1000, warn: 75, crit: 90 }), { nonce: 'n', home: path.dirname(s.dirs[0]) });
  assert.ok(html.includes('Scanned: ~'), 'footer uses ~');
});
