'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');
const { tmpdir, line, writeProjects, M15 } = require('./helpers');
const { summarize, parseText } = require('../lib/usage');
const { derive } = require('../lib/metrics');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ` expected ${b}, got ${a}`);
const L = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h || 0, mi || 0, s || 0); // local time

test('dedupes streamed duplicates and resumed copies; ignores junk lines', () => {
  const root = tmpdir();
  const at = L(2026, 10, 2, 10);
  writeProjects(root, {
    'projA/s1.jsonl': [line({ at, out: 100, id: 'm1', req: 'r1' }), line({ at, out: M15, id: 'm1', req: 'r1' })], // last wins => $15
    'projA/s2.jsonl': [line({ at, out: M15, id: 'm1', req: 'r1' })], // resumed copy of the same message
    'projA/bad.jsonl': ['not json', '{"usage":1}', '{"message":{"usage":{"output_tokens":5}}}'],
  });
  const s = summarize({ now: L(2026, 10, 15, 12), dirs: [root] });
  assert.strictEqual(s.messages, 1);
  close(s.totalUsd, 15);
});

test('CRLF logs and the Windows fixture parse correctly', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'windows-session.jsonl'), 'utf8').replace(/\n/g, '\r\n');
  const recs = parseText(text);
  assert.strictEqual(recs.size, 2); // user line has no usage; <synthetic> skipped
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'C--Users-Alex-work-payments-api'));
  fs.writeFileSync(path.join(root, 'C--Users-Alex-work-payments-api', 'a.jsonl'), text);
  const s = summarize({ now: L(2026, 10, 20, 9), dirs: [root] });
  close(s.totalUsd, 5 + 25); // $5 input + $25 output on Opus 4.5
  assert.deepStrictEqual(Object.keys(s.byProject), ['payments-api']); // from the Windows cwd, not the encoded dir
});

test('project falls back to the first folder under projects/ (subagent logs stay in their project)', () => {
  const root = tmpdir();
  writeProjects(root, { 'C--Users-Alex-app/sess/subagents/agent-1.jsonl': [line({ at: L(2026, 10, 3, 9), out: 1000 })] });
  const s = summarize({ now: L(2026, 10, 4, 9), dirs: [root] });
  assert.deepStrictEqual(Object.keys(s.byProject), ['C--Users-Alex-app']);
});

test('same folder name in two places gets disambiguated', () => {
  const root = tmpdir();
  writeProjects(root, {
    'a/s.jsonl': [line({ at: L(2026, 10, 3, 9), out: 1000, cwd: 'C:\\work\\app' })],
    'b/s.jsonl': [line({ at: L(2026, 10, 3, 9), out: 1000, cwd: 'D:\\play\\app' })],
  });
  const keys = Object.keys(summarize({ now: L(2026, 10, 4), dirs: [root] }).byProject).sort();
  assert.deepStrictEqual(keys, ['play/app', 'work/app']);
});

// ---- The core promise: month-to-date, reset on the 1st (local time) ----

function rolloverFixture() {
  const root = tmpdir();
  writeProjects(root, {
    'proj/s.jsonl': [
      line({ at: L(2026, 9, 12, 10), out: M15 }),            // Sep: $15
      line({ at: L(2026, 9, 30, 23, 58, 0), out: M15 }),     // Sep: $15, two minutes before the boundary
      line({ at: L(2026, 10, 1, 0, 0, 30), out: M15 * 2 }),  // Oct: $30, thirty seconds after
    ],
  });
  return root;
}

test('month boundary: Sep 30 23:59 counts September only', () => {
  const s = summarize({ now: L(2026, 9, 30, 23, 59), dirs: [rolloverFixture()] });
  assert.strictEqual(s.month, '2026-09');
  close(s.totalUsd, 30);
  assert.strictEqual(s.messages, 2);
});

test('month boundary: Oct 1 00:01 starts again from zero for October', () => {
  const s = summarize({ now: L(2026, 10, 1, 0, 1), dirs: [rolloverFixture()] });
  assert.strictEqual(s.month, '2026-10');
  close(s.totalUsd, 30, 'only the Oct message'); // NOT 60
  assert.strictEqual(s.messages, 1);
  close(s.history['2026-09'], 30); // September lives only in the small history map
  close(s.daily[0], 30); // Oct 1 bucket
  assert.strictEqual(s.dayOfMonth, 1);
});

test('month boundary: nothing carries over when October has no usage yet', () => {
  const root = tmpdir();
  writeProjects(root, { 'p/s.jsonl': [line({ at: L(2026, 9, 30, 23, 58), out: M15 })] });
  const s = summarize({ now: L(2026, 10, 1, 0, 1), dirs: [root] });
  assert.strictEqual(s.totalUsd, 0);
  assert.strictEqual(s.messages, 0);
  const d = derive(s, { budget: 1000, warn: 75, crit: 90 });
  assert.strictEqual(d.pct, 0);
  assert.strictEqual(d.level, 'ok');
  close(d.remaining, 1000);
});

test('month is decided in LOCAL time, not UTC', () => {
  // 23:30 local on the last day of the month is already the next month in UTC for UTC-offset zones,
  // and 00:30 local on the 1st is still the previous month in UTC for UTC+ zones. Either way local wins.
  const root = tmpdir();
  writeProjects(root, { 'p/s.jsonl': [
    line({ at: L(2026, 9, 30, 23, 30), out: M15 }),
    line({ at: L(2026, 10, 1, 0, 30), out: M15 * 3 }),
  ] });
  close(summarize({ now: L(2026, 9, 30, 23, 45), dirs: [root] }).totalUsd, 15);
  close(summarize({ now: L(2026, 10, 1, 0, 45), dirs: [root] }).totalUsd, 45);
});

test('year rollover Dec 31 -> Jan 1, and leap-year February length', () => {
  const root = tmpdir();
  writeProjects(root, { 'p/s.jsonl': [line({ at: L(2026, 12, 31, 23, 50), out: M15 }), line({ at: L(2027, 1, 1, 0, 10), out: M15 })] });
  const dec = summarize({ now: L(2026, 12, 31, 23, 55), dirs: [root] });
  const jan = summarize({ now: L(2027, 1, 1, 0, 20), dirs: [root] });
  assert.strictEqual(dec.month, '2026-12'); close(dec.totalUsd, 15);
  assert.strictEqual(jan.month, '2027-01'); close(jan.totalUsd, 15);
  assert.strictEqual(summarize({ now: L(2028, 2, 10), dirs: [root] }).daysInMonth, 29);
  assert.strictEqual(summarize({ now: L(2027, 2, 10), dirs: [root] }).daysInMonth, 28);
});

test('past months never leak into this month, and stay out of the projection', () => {
  const root = tmpdir();
  writeProjects(root, { 'p/s.jsonl': [
    line({ at: L(2026, 8, 20, 10), out: M15 * 10 }), line({ at: L(2026, 9, 20, 10), out: M15 * 10 }),
    line({ at: L(2026, 10, 2, 10), out: M15 }),
  ] });
  const s = summarize({ now: L(2026, 10, 11, 0, 0), dirs: [root] });
  close(s.totalUsd, 15);
  assert.deepStrictEqual(Object.keys(s.history).sort(), ['2026-08', '2026-09']);
  const d = derive(s, { budget: 1000, warn: 75, crit: 90 });
  close(d.projected, 15 / 10 * 31); // 10 elapsed days, 31 days in October
  close(d.safeDaily, 985 / 21); // days left includes today: 31 - 11 + 1
});

test('derive: thresholds, over budget, and no projection before a full day', () => {
  const base = { daysInMonth: 30, dayOfMonth: 1, elapsedDays: 0.4, year: 2026, monthIndex: 9, totalUsd: 760 };
  const c = { budget: 1000, warn: 75, crit: 90 };
  assert.strictEqual(derive(base, c).level, 'warn');
  assert.strictEqual(derive(Object.assign({}, base, { totalUsd: 900 }), c).level, 'crit');
  assert.strictEqual(derive(Object.assign({}, base, { totalUsd: 100 }), c).level, 'ok');
  assert.strictEqual(derive(base, c).projected, null);
  const over = derive(Object.assign({}, base, { totalUsd: 1200, elapsedDays: 5 }), c);
  assert.strictEqual(over.overBudget, true); assert.strictEqual(over.remaining, 0); assert.strictEqual(over.safeDaily, 0);
});
