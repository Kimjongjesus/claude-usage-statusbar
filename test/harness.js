'use strict';
// Tiny zero-dependency test harness.
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function runAll() {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok   ' + t.name); }
    catch (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n       ')); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  return failed;
}

module.exports = { test, runAll };
