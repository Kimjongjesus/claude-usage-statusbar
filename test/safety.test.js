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
// Scripts that run inside Claude Code (not inside VS Code): same network/process rules apply to them.
function hookFiles() {
  return fs.readdirSync(path.join(ROOT, 'hooks')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'hooks', f));
}
const FS_WRITE = /\bfs\.(write|append|unlink|rm|rename|mkdir|copy|truncate|chmod|createWriteStream)\w*/;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('no runtime dependencies', () => {
  assert.strictEqual(pkg.dependencies, undefined);
  assert.strictEqual(pkg.optionalDependencies, undefined);
  assert.strictEqual(pkg.scripts.postinstall, undefined);
});

test('runtime code only requires an allow-list of local/builtin modules (no network, no processes)', () => {
  const allowed = new Set(['vscode', 'fs', 'os', 'path', 'crypto']);
  for (const file of runtimeFiles().concat(hookFiles())) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const name = m[1];
      assert.ok(name.startsWith('./') || allowed.has(name), `${path.basename(file)} requires "${name}"`);
    }
    assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|child_process|node:http|vscode\.env\.openExternal)\b/.test(src), path.basename(file) + ' uses a network/process API');
    assert.ok(!/https?:\/\//.test(src), path.basename(file) + ' contains a URL');
  }
});

// The installer is the one module allowed to write, and extension.js only reaches it after a modal confirmation
// (tested in install.test.js). Everything else, and every hook script but the budget guard's state file, is read-only.
const WRITERS = new Set(['hooks-install.js', 'budget-guard.js']);
test('read-only on Claude logs: runtime code never writes, deletes or renames files (installer and budget-guard state excepted)', () => {
  for (const file of runtimeFiles().concat(hookFiles())) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (WRITERS.has(path.basename(file))) continue;
    assert.ok(!FS_WRITE.test(src), path.basename(file) + ' mutates the filesystem');
  }
  const only = runtimeFiles().concat(hookFiles()).filter((f) => FS_WRITE.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.basename(f)).sort();
  assert.deepStrictEqual(only, ['budget-guard.js', 'hooks-install.js'], 'unexpected writers: ' + only.join(','));
});

test('manifest: no telemetry-ish contributions and the "estimate" disclosure is in the README', () => {
  const props = Object.keys(pkg.contributes.configuration.properties);
  assert.ok(!props.some((p) => /telemetry|analytics|endpoint|url|apikey|token/i.test(p)), props.join(','));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(/estimate/i.test(readme) && /1st/.test(readme) && /Install from VSIX/i.test(readme));
});

test('manifest declares the commands the code registers', () => {
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  assert.deepStrictEqual(declared, ['claudeUsage.installHooks', 'claudeUsage.refresh', 'claudeUsage.setBudget', 'claudeUsage.showDetails', 'claudeUsage.wasteReport']);
  const src = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  for (const c of declared) assert.ok(src.includes(`'${c}'`), c);
  assert.strictEqual(pkg.version, '0.3.0');
  const titles = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
  assert.strictEqual(titles['claudeUsage.wasteReport'], 'Claude Usage: Waste Report');
  assert.strictEqual(titles['claudeUsage.installHooks'], 'Claude Usage: Install Token-Saver Hooks');
});

test('hooks and templates ship in the .vsix (not excluded by .vscodeignore)', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const shipped of ['hooks', 'templates', 'lib']) {
    assert.ok(!ignore.some((l) => l === shipped || l.startsWith(shipped + '/')), shipped + ' is ignored by .vscodeignore');
    assert.ok(fs.existsSync(path.join(ROOT, shipped)), shipped + ' exists');
  }
  for (const f of ['hooks/guard-reads.js', 'hooks/budget-guard.js', 'hooks/trim-output.js', 'hooks/README.md', 'templates/CLAUDE.template.md', 'templates/.claude/commands/new-dashboard.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  }
  // dot-folders are packaged by vsce unless ignored; make sure the commands template is not
  assert.ok(!ignore.some((l) => /\.claude/.test(l)), '.claude is ignored');
});

