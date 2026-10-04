'use strict';
const assert = require('assert');
const { test } = require('./harness');
const { costOf, rateFor } = require('../lib/pricing');

test('pricing: model families', () => {
  assert.deepStrictEqual(rateFor('claude-opus-4-20250514'), { input: 15, output: 75 });
  assert.deepStrictEqual(rateFor('claude-opus-4-1-20250805'), { input: 15, output: 75 });
  assert.deepStrictEqual(rateFor('claude-opus-4-5-20251101'), { input: 5, output: 25 });
  assert.strictEqual(rateFor('claude-sonnet-4-5').output, 15);
  assert.strictEqual(rateFor('claude-haiku-4-5').input, 1);
  assert.strictEqual(rateFor('mystery-model').assumed, true);
  assert.strictEqual(rateFor('claude-opus-9', { 'opus-9': { input: 1, output: 2 } }).output, 2);
});

test('pricing: token math', () => {
  assert.ok(Math.abs(costOf({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-sonnet-4-5').usd - 18) < 1e-9);
  assert.ok(Math.abs(costOf({ cache_creation: { ephemeral_1h_input_tokens: 1e6 } }, 'sonnet').usd - 6) < 1e-9);
  assert.ok(Math.abs(costOf({ cache_read_input_tokens: 1e6 }, 'sonnet').usd - 0.3) < 1e-9);
});
