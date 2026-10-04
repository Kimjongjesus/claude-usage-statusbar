'use strict';
// The "safe to run at work" promises, enforced by tests instead of by README prose.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('./harness');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function runtimeFiles() {
  const out = [path.join(ROOT, 'extension.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) out.push(path.join(ROOT, 'lib', f));
  return out;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('no runtime dependencies', () => {
  assert.strictEqual(pkg.dependencies, undefined);
  assert.strictEqual(pkg.optionalDependencies, undefined);
  assert.strictEqual(pkg.scripts.postinstall, undefined);
});

test('runtime code only requires an allow-list of local/builtin modules (no network, no processes)', () => {
  const allowed = new Set(['vscode', 'fs', 'os', 'path', 'crypto']);
  for (const file of runtimeFiles()) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const name = m[1];
      assert.ok(name.startsWith('./') || allowed.has(name), `${path.basename(file)} requires "${name}"`);
    }
    assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|child_process|node:http|vscode\.env\.openExternal)\b/.test(src), path.basename(file) + ' uses a network/process API');
    assert.ok(!/https?:\/\//.test(src), path.basename(file) + ' contains a URL');
  }
});

test('read-only on Claude logs: runtime code never writes, deletes or renames files', () => {
  for (const file of runtimeFiles()) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    assert.ok(!/\bfs\.(write|append|unlink|rm|rename|mkdir|copy|truncate|chmod|createWriteStream)\w*/.test(src), path.basename(file) + ' mutates the filesystem');
  }
});

test('manifest: no telemetry-ish contributions and the "estimate" disclosure is in the README', () => {
  const props = Object.keys(pkg.contributes.configuration.properties);
  assert.ok(!props.some((p) => /telemetry|analytics|endpoint|url|apikey|token/i.test(p)), props.join(','));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(/estimate/i.test(readme) && /1st/.test(readme) && /Install from VSIX/i.test(readme));
});

test('manifest declares the commands the code registers', () => {
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  assert.deepStrictEqual(declared, ['claudeUsage.refresh', 'claudeUsage.setBudget', 'claudeUsage.showDetails']);
  const src = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  for (const c of declared) assert.ok(src.includes(`'${c}'`), c);
  assert.strictEqual(pkg.version, '0.2.0');
});
