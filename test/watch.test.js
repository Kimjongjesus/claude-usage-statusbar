'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');
const { tmpdir } = require('./helpers');
const { watchDirs, throttle } = require('../lib/watch');

test('watcher fires soon after a Claude log is written, throttled, and stops on dispose', async () => {
  const root = tmpdir('cu-watch-');
  fs.mkdirSync(path.join(root, 'projA'));
  let calls = 0;
  const w = watchDirs([root], () => { calls++; }, 60);
  assert.ok(w.count >= 1, 'at least one watcher attached');
  await new Promise((r) => setTimeout(r, 50));
  const file = path.join(root, 'projA', 's.jsonl');
  for (let i = 0; i < 5; i++) fs.appendFileSync(file, '{"x":' + i + '}\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(calls >= 1 && calls <= 3, 'throttled burst => ' + calls + ' call(s)');
  const before = calls;
  w.dispose();
  fs.appendFileSync(file, '{"x":9}\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(calls, before, 'no calls after dispose');
});

test('watcher tolerates missing directories', () => {
  const w = watchDirs([path.join(tmpdir(), 'nope')], () => {}, 10);
  assert.strictEqual(w.count, 0);
  w.dispose();
});

test('throttle collapses bursts into one trailing call', async () => {
  let n = 0; const t = throttle(() => { n++; }, 30);
  t(); t(); t();
  await new Promise((r) => setTimeout(r, 90));
  assert.strictEqual(n, 1);
});
