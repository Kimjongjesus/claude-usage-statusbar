'use strict';
// USD per million tokens. Estimates only: edit via the claudeUsage.pricingOverrides setting.
// Cache write: 5m = 1.25x input, 1h = 2x input. Cache read = 0.1x input.
const FAMILIES = [
  // [regex on model id, {input, output}]
  [/opus-4(-1)?(-\d{8})?$/, { input: 15, output: 75 }], // Opus 4 / 4.1
  [/opus/, { input: 5, output: 25 }],                              // Opus 4.5+ and newer
  [/sonnet/, { input: 3, output: 15 }],
  [/haiku-3-5|haiku-3\.5/, { input: 0.8, output: 4 }],
  [/haiku-3(?!-5)/, { input: 0.25, output: 1.25 }],
  [/haiku/, { input: 1, output: 5 }],
];
const FALLBACK = { input: 3, output: 15, assumed: true };

function rateFor(model, overrides) {
  const id = String(model || '').toLowerCase();
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      if (id.includes(k.toLowerCase())) return Object.assign({}, overrides[k]);
    }
  }
  for (const [re, r] of FAMILIES) if (re.test(id)) return Object.assign({}, r);
  return Object.assign({}, FALLBACK);
}

function costOf(usage, model, overrides) {
  const r = rateFor(model, overrides);
  const inp = r.input, out = r.output;
  const w5 = r.cacheWrite5m != null ? r.cacheWrite5m : inp * 1.25;
  const w1 = r.cacheWrite1h != null ? r.cacheWrite1h : inp * 2;
  const rd = r.cacheRead != null ? r.cacheRead : inp * 0.1;
  const cc = usage.cache_creation || {};
  let c5 = cc.ephemeral_5m_input_tokens || 0;
  const c1 = cc.ephemeral_1h_input_tokens || 0;
  // Older logs only have the aggregate field: treat as 5m.
  if (!c5 && !c1) c5 = usage.cache_creation_input_tokens || 0;
  const usd = ((usage.input_tokens || 0) * inp + (usage.output_tokens || 0) * out +
    c5 * w5 + c1 * w1 + (usage.cache_read_input_tokens || 0) * rd) / 1e6;
  return { usd, assumed: !!r.assumed };
}

module.exports = { rateFor, costOf };
