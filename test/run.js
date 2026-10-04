'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { costOf, rateFor } = require('../lib/pricing');

// pricing
assert.deepStrictEqual(rateFor('claude-opus-4-20250514'), { input: 15, output: 75 });
assert.deepStrictEqual(rateFor('claude-opus-4-1-20250805'), { input: 15, output: 75 });
assert.deepStrictEqual(rateFor('claude-opus-4-5-20251101'), { input: 5, output: 25 });
assert.strictEqual(rateFor('claude-sonnet-4-5').output, 15);
assert.strictEqual(rateFor('claude-haiku-4-5').input, 1);
assert.strictEqual(rateFor('mystery-model').assumed, true);
assert.strictEqual(rateFor('claude-opus-9', { 'opus-9': { input: 1, output: 2 } }).output, 2);
// 1M input + 1M output on sonnet = $18
const c = costOf({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-sonnet-4-5');
assert.ok(Math.abs(c.usd - 18) < 1e-9);
// 1h cache write 1M on sonnet = $6; cache read 1M = $0.30
assert.ok(Math.abs(costOf({ cache_creation: { ephemeral_1h_input_tokens: 1e6 } }, 'sonnet').usd - 6) < 1e-9);
assert.ok(Math.abs(costOf({ cache_read_input_tokens: 1e6 }, 'sonnet').usd - 0.3) < 1e-9);

// usage scan: dedupe streamed duplicates + cross-file duplicates, month filter
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-'));
const proj = path.join(tmp, 'projA'); fs.mkdirSync(proj);
const now = new Date(2026, 9, 15, 12);
const ts = (d) => new Date(2026, d.m, d.d, 10).toISOString();
const line = (id, when, out) => JSON.stringify({ type: 'assistant', timestamp: when, requestId: 'r' + id, uuid: 'u' + Math.random(),
  message: { id: 'm' + id, model: 'claude-sonnet-4-5', usage: { input_tokens: 0, output_tokens: out } } });
const a = [line(1, ts({ m: 9, d: 2 }), 100), line(1, ts({ m: 9, d: 2 }), 1000000), // streamed dup: last wins => $15
  line(2, ts({ m: 8, d: 30 }), 1000000)].join('\n'); // previous month, ignored
fs.writeFileSync(path.join(proj, 's1.jsonl'), a);
fs.writeFileSync(path.join(proj, 's2.jsonl'), line(1, ts({ m: 9, d: 2 }), 1000000)); // resumed copy
fs.writeFileSync(path.join(proj, 'bad.jsonl'), 'not json\n{"usage":1}\n');
process.env.HOME = tmp; process.env.USERPROFILE = tmp; process.env.CLAUDE_CONFIG_DIR = '';
const { summarize } = require('../lib/usage');
const s = summarize({ now, dataDirs: [tmp] });
assert.strictEqual(s.month, '2026-10');
assert.strictEqual(s.messages, 1);
assert.ok(Math.abs(s.totalUsd - 15) < 1e-9, 'total ' + s.totalUsd);
console.log('all tests passed');
