'use strict';
// v0.3 data layer: sessions, branches, context size, session picking, incremental parsing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');
const { tmpdir, writeProjects, line, M15, asst, toolResult, titleLine } = require('./helpers');
const { summarize, parseFileText, ctxTokens } = require('../lib/usage');
const { pickActive, ctxInfo, adviceText, branchLabel, within } = require('../lib/sessions');
const f = require('../lib/format');

const L = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ` expected ${b}, got ${a}`);
const sess = (s, sid) => s.sessions.find((x) => x.sid === sid);

test('per-session and per-branch cost: sums per session id, grouped by project + branch, month total unchanged', () => {
  const root = tmpdir();
  writeProjects(root, {
    'hub/a.jsonl': [
      asst({ at: L(2026, 10, 3, 9), sid: 'sA', branch: 'feature/sales-dash', usage: { output: M15 } }),            // $15
      asst({ at: L(2026, 10, 3, 9, 30), sid: 'sA', branch: 'feature/sales-dash', usage: { output: M15 / 2 } }),    // $7.50
      titleLine('sA', 'Build sales dashboard'),
    ],
    'hub/b.jsonl': [asst({ at: L(2026, 10, 4, 11), sid: 'sB', branch: 'main', usage: { output: M15 } })],           // $15
    'hub/c.jsonl': [asst({ at: L(2026, 10, 5, 11), sid: 'sC', branch: 'feature/sales-dash', usage: { output: M15 / 3 } })], // $5
  });
  const s = summarize({ now: L(2026, 10, 6, 12), dirs: [root] });
  close(s.totalUsd, 42.5, 'month total is the sum of every message');
  close(sess(s, 'sA').usd, 22.5); close(sess(s, 'sB').usd, 15); close(sess(s, 'sC').usd, 5);
  assert.strictEqual(sess(s, 'sA').title, 'Build sales dashboard');
  assert.strictEqual(sess(s, 'sA').project, 'hub');
  assert.deepStrictEqual(s.sessions.map((x) => x.sid), ['sC', 'sB', 'sA'], 'newest activity first');
  const feat = s.byBranch.find((b) => b.branch === 'feature/sales-dash');
  close(feat.usd, 27.5); assert.strictEqual(feat.sessions, 2); assert.strictEqual(feat.project, 'hub');
  assert.deepStrictEqual(s.byBranch.map((b) => b.branch), ['feature/sales-dash', 'main'], 'biggest feature first');
  close(s.byBranch.reduce((a, b) => a + b.usd, 0), s.totalUsd, 'branches add up to the month total');
});

test('one assistant message written as several streamed lines is counted once; tool calls are merged', () => {
  const root = tmpdir();
  const at = L(2026, 10, 3, 9);
  writeProjects(root, {
    'hub/a.jsonl': [
      asst({ at, id: 'M1', sid: 's1', usage: { output: 10 }, content: [{ type: 'text', text: 'hi' }] }),
      asst({ at, id: 'M1', sid: 's1', usage: { output: 20 }, tools: [{ id: 'tu1', name: 'Read', input: { file_path: 'C:\\x\\a.ts' } }] }),
      asst({ at, id: 'M1', sid: 's1', usage: { output: M15 }, tools: [{ id: 'tu2', name: 'Grep', input: { path: 'C:\\x' } }] }),
    ],
  });
  const s = summarize({ now: L(2026, 10, 4), dirs: [root] });
  assert.strictEqual(s.messages, 1);
  close(s.totalUsd, 15);
  assert.deepStrictEqual(s.detail.records[0].r.tools.sort(), ['Grep', 'Read']);
  assert.strictEqual(s.detail.toolUses.get('tu1').file, 'C:\\x\\a.ts');
});

test('a resumed session copies history into a new file: the message stays with the session that wrote it, totals unchanged', () => {
  const root = tmpdir();
  const at = L(2026, 10, 3, 9);
  const orig = asst({ at, id: 'M1', sid: 'original', usage: { output: M15 } });
  const copied = asst({ at, id: 'M1', sid: 'resumed', usage: { output: M15 } });
  writeProjects(root, {
    'hub/original.jsonl': [orig],
    'hub/resumed.jsonl': [copied, asst({ at: L(2026, 10, 3, 10), id: 'M2', sid: 'resumed', usage: { output: M15 / 2 } })],
  });
  fs.utimesSync(path.join(root, 'hub/original.jsonl'), new Date('2026-10-03T10:00:00Z'), new Date('2026-10-03T10:00:00Z'));
  fs.utimesSync(path.join(root, 'hub/resumed.jsonl'), new Date('2026-10-04T10:00:00Z'), new Date('2026-10-04T10:00:00Z'));
  const s = summarize({ now: L(2026, 10, 5), dirs: [root] });
  close(s.totalUsd, 22.5, 'the copy is not double counted');
  close(sess(s, 'original').usd, 15, 'the copied message belongs to the original session');
  close(sess(s, 'resumed').usd, 7.5, 'the resumed session only owns its new message');
});

test('month rollover regression: a session that crosses midnight on the 1st keeps its whole cost, the month total starts again from zero', () => {
  const root = tmpdir();
  writeProjects(root, {
    'hub/x.jsonl': [
      asst({ at: L(2026, 9, 30, 23, 58), sid: 'night', usage: { output: M15 } }),           // $15 in September
      asst({ at: L(2026, 10, 1, 0, 2), sid: 'night', usage: { output: M15 / 3 } }),         // $5 in October
    ],
  });
  const oct = summarize({ now: L(2026, 10, 1, 10), dirs: [root] });
  close(oct.totalUsd, 5, 'October starts from zero + only October usage');
  close(oct.history['2026-09'], 15);
  const n = sess(oct, 'night');
  close(n.usd, 20, 'this session $ is the whole session'); close(n.monthUsd, 5, 'its share of this month');
  assert.strictEqual(n.monthMessages, 1);
  const sep = summarize({ now: L(2026, 9, 30, 23, 59), dirs: [root] });
  close(sep.totalUsd, 15);
  assert.strictEqual(sep.sessions.length, 1);
  // by-branch only lists this month's work
  close(oct.byBranch.reduce((a, b) => a + b.usd, 0), 5);
});

test('records without a sessionId (older logs) fall back to the file / session folder name', () => {
  const root = tmpdir();
  writeProjects(root, {
    'proj/abc123.jsonl': [line({ at: L(2026, 10, 3, 9), out: 1000 })],
    'proj/def456/subagents/agent-1.jsonl': [line({ at: L(2026, 10, 3, 9, 5), out: 1000 })],
  });
  const s = summarize({ now: L(2026, 10, 4), dirs: [root] });
  assert.deepStrictEqual(s.sessions.map((x) => x.sid).sort(), ['abc123', 'def456']);
});

test('context size = input + cache read + cache write of the last MAIN-conversation request; subagent turns never count', () => {
  const root = tmpdir();
  writeProjects(root, {
    'hub/a.jsonl': [
      asst({ at: L(2026, 10, 3, 9, 0), sid: 's', usage: { input: 10, read: 40000, write5m: 2000, output: 100 } }),
      asst({ at: L(2026, 10, 3, 9, 10), sid: 's', usage: { input: 5, read: 120000, write5m: 8000, write1h: 2000, output: 100 } }),
      asst({ at: L(2026, 10, 3, 9, 20), sid: 's', side: true, usage: { input: 5, read: 190000, output: 100 } }), // subagent: ignored for ctx
    ],
  });
  const s = summarize({ now: L(2026, 10, 4), dirs: [root] });
  const x = sess(s, 's');
  assert.strictEqual(x.lastCtx, 5 + 120000 + 10000);
  assert.strictEqual(x.peakCtx, 130005);
  assert.strictEqual(ctxTokens({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }), 6);
  assert.strictEqual(x.messages, 3, 'subagent cost still belongs to the session');
});

test('pickActive: latest session, a workspace match wins (Windows paths compare case-insensitively), stale sessions are not active', () => {
  const now = L(2026, 10, 3, 12);
  const mk = (sid, cwd, minsAgo) => ({ sid, cwd, lastCtxAt: new Date(+now - minsAgo * 60000) });
  const list = [mk('latest', 'D:\\other\\thing', 5), mk('mine', 'C:\\Users\\Eli\\work\\hub', 30)];
  assert.strictEqual(pickActive(list, { now }).session.sid, 'latest');
  const p = pickActive(list, { now, workspaceDirs: ['c:\\users\\eli\\WORK\\hub\\'] });
  assert.strictEqual(p.session.sid, 'mine'); assert.ok(p.inWorkspace && p.active);
  assert.strictEqual(pickActive(list, { now, workspaceDirs: ['/nowhere'] }).session.sid, 'latest', 'no match falls back to the latest');
  assert.strictEqual(pickActive([mk('old', 'C:\\a', 61)], { now }).active, false);
  assert.strictEqual(pickActive([], { now }), null);
  assert.ok(within('C:\\Users\\Eli\\work\\hub\\sub', 'c:/users/eli/work/hub'));
  assert.ok(!within('/home/a/hub2', '/home/a/hub'), 'a sibling folder with a longer name is not inside');
});

test('context advice states the concrete per-request cost (Sonnet 4.5: $0.30/M cached read, $3.75/M cache write)', () => {
  const info = ctxInfo({ lastCtx: 142000, lastModel: 'claude-sonnet-4-5-20250929' }, { window: 200000 });
  close(info.pct, 71);
  close(info.warmPerRequest, 142000 * 0.3 / 1e6);
  close(info.coldPerRequest, 142000 * 3.75 / 1e6);
  const t = adviceText(info);
  for (const want of ['142k', '$0.043', '$0.53', 'Sonnet 4.5', '/compact', '/clear', 'per request']) assert.ok(t.includes(want), want + ' in: ' + t);
  // window setting and pricing overrides are honoured
  assert.strictEqual(Math.floor(ctxInfo({ lastCtx: 100000, lastModel: 'x' }, { window: 1000000 }).pct), 10);
  close(ctxInfo({ lastCtx: 1e6, lastModel: 'opus-9' }, { window: 2e6, pricingOverrides: { 'opus-9': { input: 10, output: 1 } } }).warmPerRequest, 1e6 * 1 / 1e6);
  assert.strictEqual(f.tokensK(142000), '142k'); assert.strictEqual(f.tokensK(1250000), '1.3M'); assert.strictEqual(f.tokensK(999), '999');
});

test('branch labels: detached HEAD and missing branches are named, not blank', () => {
  assert.strictEqual(branchLabel(''), '(no branch)');
  assert.strictEqual(branchLabel('HEAD'), '(detached HEAD)');
  assert.strictEqual(branchLabel('feature/x'), 'feature/x');
});

test('incremental parse: appended lines are picked up, a half-written last line waits, a rewritten file is re-read', () => {
  const root = tmpdir();
  const file = path.join(root, 'hub', 's.jsonl');
  const A = asst({ at: L(2026, 10, 3, 9), sid: 's', id: 'A', usage: { output: M15 } });
  const B = asst({ at: L(2026, 10, 3, 10), sid: 's', id: 'B', usage: { output: M15 } });
  const C = asst({ at: L(2026, 10, 3, 11), sid: 's', id: 'C', usage: { output: M15 } });
  writeProjects(root, { 'hub/s.jsonl': [A] });
  const now = L(2026, 10, 4);
  close(summarize({ now, dirs: [root] }).totalUsd, 15);
  fs.appendFileSync(file, B + '\n');
  close(summarize({ now, dirs: [root] }).totalUsd, 30, 'appended message counted');
  fs.appendFileSync(file, C.slice(0, 120)); // Claude Code is mid-write
  close(summarize({ now, dirs: [root] }).totalUsd, 30, 'partial line ignored');
  fs.appendFileSync(file, C.slice(120) + '\n');
  close(summarize({ now, dirs: [root] }).totalUsd, 45, 'completed line counted exactly once');
  // rewritten with different content (same or bigger size): must not keep stale data
  fs.writeFileSync(file, asst({ at: L(2026, 10, 3, 9), sid: 's', id: 'Z', usage: { output: M15 / 3 } }) + '\n' + 'x'.repeat(5000) + '\n');
  close(summarize({ now, dirs: [root] }).totalUsd, 5, 'rewritten file is re-read from the start');
});

test('same-size / same-prefix rewrites and replacements are re-read, not trusted as appends (reviewer r1)', () => {
  const root = tmpdir();
  const file = path.join(root, 'hub', 's.jsonl');
  const now = L(2026, 10, 4);
  const A = asst({ at: L(2026, 10, 3, 9), sid: 's', id: 'A', usage: { output: 1000 } });
  const B = asst({ at: L(2026, 10, 3, 10), sid: 's', id: 'B', usage: { output: 1000 } });
  writeProjects(root, { 'hub/s.jsonl': [A, B] });
  close(summarize({ now, dirs: [root] }).totalUsd, 0.03);
  // second message rewritten in place: identical size, identical first bytes, new mtime
  const B9 = B.replace('"output_tokens":1000', '"output_tokens":9000');
  assert.strictEqual(B9.length, B.length); assert.notStrictEqual(B9, B);
  fs.writeFileSync(file, A + '\n' + B9 + '\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  close(summarize({ now, dirs: [root] }).totalUsd, 0.15, 'same-size rewrite re-read');
  // rewritten AND grown, still starting with the very same first line
  const C = asst({ at: L(2026, 10, 3, 11), sid: 's', id: 'C', usage: { output: 2000 } });
  fs.writeFileSync(file, A + '\n' + B + '\n' + C + '\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
  close(summarize({ now, dirs: [root] }).totalUsd, 0.06, 'grown file whose earlier bytes changed is parsed from the start');
  // replaced by a different, longer file that shares only the first line
  const D = asst({ at: L(2026, 10, 3, 12), sid: 's', id: 'D', usage: { output: 4000 } });
  fs.writeFileSync(file, A + '\n' + D + '\n' + D.replace('"id":"msD"', '"id":"msE"').replace('rqD', 'rqE') + '\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 15000));
  close(summarize({ now, dirs: [root] }).totalUsd, 0.015 + 0.06 + 0.06, 'replacement parsed from the start');
  // a genuine append after all that is still picked up incrementally and counted once
  fs.appendFileSync(file, asst({ at: L(2026, 10, 3, 13), sid: 's', id: 'F', usage: { output: 1000 } }) + '\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 20000));
  close(summarize({ now, dirs: [root] }).totalUsd, 0.015 + 0.06 + 0.06 + 0.015, 'append still counted');
  // truncated below what was consumed
  fs.writeFileSync(file, A + '\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 25000));
  close(summarize({ now, dirs: [root] }).totalUsd, 0.015, 'shrunk file re-read');
});

test('a final line without a trailing newline still counts when it is complete JSON (CRLF files too)', () => {
  const root = tmpdir();
  const A = asst({ at: L(2026, 10, 3, 9), sid: 's', id: 'A', usage: { output: M15 } });
  fs.mkdirSync(path.join(root, 'hub'));
  fs.writeFileSync(path.join(root, 'hub', 's.jsonl'), A.replace(/$/, '') + '\r\n' + asst({ at: L(2026, 10, 3, 9, 5), sid: 's', id: 'B', usage: { output: M15 } }));
  close(summarize({ now: L(2026, 10, 4), dirs: [root] }).totalUsd, 30);
});

test('tool details are only parsed for files touched this month; their cost is still counted', () => {
  const root = tmpdir();
  writeProjects(root, {
    'hub/old.jsonl': [asst({ at: L(2026, 9, 10, 9), sid: 'o', usage: { output: M15 }, tools: [{ id: 'oldtool', name: 'Read', input: { file_path: 'C:\\a.ts' } }] })],
    'hub/new.jsonl': [asst({ at: L(2026, 10, 2, 9), sid: 'n', usage: { output: M15 }, tools: [{ id: 'newtool', name: 'Read', input: { file_path: 'C:\\b.ts' } }] })],
  });
  fs.utimesSync(path.join(root, 'hub/old.jsonl'), new Date('2026-09-10T10:00:00Z'), new Date('2026-09-10T10:00:00Z'));
  const s = summarize({ now: L(2026, 10, 4), dirs: [root] });
  assert.ok(s.detail.toolUses.has('newtool') && !s.detail.toolUses.has('oldtool'));
  close(s.history['2026-09'], 15);
  // monthOnly (used by the hooks) skips last month's files entirely and is much cheaper
  const m = summarize({ now: L(2026, 10, 4), dirs: [root], monthOnly: true });
  close(m.totalUsd, 15); assert.deepStrictEqual(m.history, {});
});

test('parseFileText exposes tool results and titles for detail files', () => {
  const st = parseFileText([
    asst({ at: L(2026, 10, 3, 9), sid: 's', usage: { output: 1 }, tools: [{ id: 'T9', name: 'Bash', input: { command: 'npm test' } }] }),
    toolResult({ at: L(2026, 10, 3, 9, 1), sid: 's', toolUseId: 'T9', chars: 12345 }),
    titleLine('s', 'My title'),
  ].join('\n'), true);
  assert.strictEqual(st.results.get('T9').chars, 12345);
  assert.strictEqual(st.toolUses.get('T9').cmd, 'npm test');
  assert.strictEqual(st.titles.get('s'), 'My title');
  assert.strictEqual(parseFileText(toolResult({ at: L(2026, 10, 3), sid: 's', toolUseId: 'Q', chars: 10 }), false).results.size, 0);
});
