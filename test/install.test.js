'use strict';
// Install Token-Saver Hooks: nothing is written without explicit confirmation, settings are backed up and merged, never clobbered.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('./harness');
const { tmpdir, writeProjects, asst, M15 } = require('./helpers');
const hi = require('../lib/hooks-install');
const { withExtension, L } = require('./extension.test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));
function listAll(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } })(dir);
  return out.sort();
}
const ALL = { guard: true, budget: true, trim: true };

test('settings snippet shipped in hooks/ matches what the installer generates, and uses only supported hook fields', () => {
  const shipped = readJson(path.join(ROOT, 'hooks', 'settings.snippet.json'));
  const gen = hi.buildSnippet({ dir: '<HOOKS_DIR>', budget: 1000, picks: ALL, pathMod: path.posix });
  assert.deepStrictEqual(shipped, gen);
  assert.deepStrictEqual(readJson(path.join(ROOT, 'hooks', 'permissions-deny.snippet.json')), { permissions: { deny: hi.DENY_RULES } });
  for (const [ev, groups] of Object.entries(shipped.hooks)) {
    assert.ok(['PreToolUse', 'PostToolUse', 'UserPromptSubmit'].includes(ev), ev);
    for (const g of groups) for (const h of g.hooks) {
      assert.strictEqual(h.type, 'command'); assert.strictEqual(h.command, 'node', 'Node only: no bash or PowerShell scripts');
      assert.ok(Array.isArray(h.args) && h.args[0].endsWith('.js') && h.timeout > 0);
    }
  }
  assert.strictEqual(shipped.hooks.PreToolUse[0].matcher, 'Read|Grep|Glob');
  assert.strictEqual(shipped.hooks.PostToolUse[0].matcher, 'Bash|PowerShell|mcp__.*');
  assert.strictEqual(shipped.hooks.UserPromptSubmit[0].matcher, undefined);
  // every script the snippet points at exists in hooks/ and is part of the installed set
  for (const g of Object.values(shipped.hooks).flat()) for (const h of g.hooks) assert.ok(hi.HOOK_FILES.includes(path.basename(h.args[0])) && fs.existsSync(path.join(ROOT, 'hooks', path.basename(h.args[0]))));
  for (const lib of hi.LIB_FILES) assert.ok(fs.existsSync(path.join(ROOT, 'lib', lib)));
});

test('Windows paths: script paths, settings files and hook dir use backslashes (path.win32)', () => {
  const home = 'C:\\Users\\Eli';
  const dir = hi.hooksDir(home, path.win32);
  assert.strictEqual(dir, 'C:\\Users\\Eli\\.claude\\token-saver-hooks');
  const snip = hi.buildSnippet({ dir, budget: 750, picks: ALL, pathMod: path.win32 });
  assert.strictEqual(snip.hooks.PreToolUse[0].hooks[0].args[0], 'C:\\Users\\Eli\\.claude\\token-saver-hooks\\guard-reads.js');
  assert.deepStrictEqual(snip.hooks.UserPromptSubmit[0].hooks[0].args, ['C:\\Users\\Eli\\.claude\\token-saver-hooks\\budget-guard.js', '--budget', '750']);
  assert.strictEqual(hi.settingsPath('user', { home, pathMod: path.win32 }), 'C:\\Users\\Eli\\.claude\\settings.json');
  assert.strictEqual(hi.settingsPath('project', { workspaceDir: 'C:\\work\\hub', pathMod: path.win32 }), 'C:\\work\\hub\\.claude\\settings.local.json');
  const p = hi.plan({ home, budget: 750, picks: ALL, scope: 'user', pathMod: path.win32 });
  assert.ok(p.scripts.every((s) => s.startsWith('C:\\Users\\Eli\\.claude\\token-saver-hooks\\')) && p.libs[0] === 'C:\\Users\\Eli\\.claude\\token-saver-hooks\\lib\\usage.js');
  // our own entries are recognised even though the path has backslashes (so a re-install replaces, not duplicates)
  const merged = hi.mergeSettings(hi.mergeSettings({}, snip), snip);
  assert.strictEqual(merged.hooks.PreToolUse.length, 1);
});

test('mergeSettings keeps everything that is not ours, is idempotent, and replaces older Token-Saver entries', () => {
  const dir = path.join(os.tmpdir(), 'x', '.claude', 'token-saver-hooks');
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['/opt/my-audit.js'] }] };
  const existing = {
    model: 'sonnet', env: { FOO: '1' }, permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] },
    hooks: { PreToolUse: [mine, { matcher: 'Read', hooks: [{ type: 'command', command: 'node', args: [dir + '/guard-reads.js', '--mode', 'warn'] }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
  };
  const a = hi.mergeSettings(existing, hi.buildSnippet({ dir, budget: 500, picks: Object.assign({ deny: true }, ALL) }));
  assert.strictEqual(a.model, 'sonnet'); assert.deepStrictEqual(a.env, { FOO: '1' });
  assert.deepStrictEqual(a.hooks.Stop, existing.hooks.Stop);
  assert.deepStrictEqual(a.hooks.PreToolUse[0], mine, 'user hook untouched and first');
  assert.strictEqual(a.hooks.PreToolUse.length, 2, 'the old Token-Saver entry was replaced, not duplicated');
  assert.deepStrictEqual(a.hooks.PreToolUse[1].hooks[0].args.slice(1), ['--mode', 'deny']);
  assert.deepStrictEqual(a.permissions.allow, ['Bash(npm test)']);
  assert.strictEqual(a.permissions.deny[0], 'Read(./.env)'); assert.ok(a.permissions.deny.includes('Read(**/node_modules/**)'));
  const snip2 = hi.buildSnippet({ dir, budget: 500, picks: Object.assign({ deny: true }, ALL) });
  assert.deepStrictEqual(hi.mergeSettings(a, snip2), a, 'second merge changes nothing');
  assert.strictEqual(a.permissions.deny.length, new Set(a.permissions.deny).size, 'no duplicate rules');
  // the input object is never mutated
  assert.strictEqual(existing.hooks.PreToolUse.length, 2); assert.deepStrictEqual(existing.permissions.deny, ['Read(./.env)']);
  // picking fewer parts only touches those events
  const only = hi.mergeSettings({}, hi.buildSnippet({ dir, picks: { guard: true } }));
  assert.deepStrictEqual(Object.keys(only.hooks), ['PreToolUse']);
  for (const bad of [[], 'x', { hooks: [] }, { hooks: { PreToolUse: {} } }, { permissions: [] }, { permissions: { deny: 'x' } }]) {
    assert.throws(() => hi.mergeSettings(bad, hi.buildSnippet({ dir, picks: Object.assign({ deny: true }, ALL) })), /not a/, JSON.stringify(bad));
  }
});

test('plan() writes nothing; apply() copies scripts, backs the settings up, merges, and a second run does not duplicate or lose anything', () => {
  const home = tmpdir('inst-');
  const settings = path.join(home, '.claude', 'settings.json');
  const logs = path.join(home, '.claude', 'projects', 'hub', 'a.jsonl');
  writeProjects(path.join(home, '.claude', 'projects'), { 'hub/a.jsonl': [asst({ at: new Date(), sid: 's', usage: { output: M15 } })] });
  const original = JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }, null, 4);
  fs.writeFileSync(settings, original);
  const before = listAll(home);
  const logBefore = read(logs);
  const p = hi.plan({ home, budget: 1000, picks: ALL, scope: 'user', now: new Date(2026, 9, 5, 14, 3, 9) });
  assert.deepStrictEqual(listAll(home), before, 'plan() wrote nothing');
  assert.strictEqual(p.error, null); assert.strictEqual(p.backup, settings + '.bak-20261005-140309');
  const res = hi.apply(p, ROOT);
  const dir = hi.hooksDir(home);
  for (const f of hi.HOOK_FILES) assert.strictEqual(read(path.join(dir, f)), read(path.join(ROOT, 'hooks', f)), f + ' copied byte for byte');
  for (const f of hi.LIB_FILES) assert.strictEqual(read(path.join(dir, 'lib', f)), read(path.join(ROOT, 'lib', f)), 'lib/' + f);
  assert.strictEqual(read(p.backup), original, 'backup is the untouched original');
  const now1 = readJson(settings);
  assert.strictEqual(now1.model, 'opus'); assert.deepStrictEqual(now1.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo bye' }] }]);
  assert.deepStrictEqual(Object.keys(now1.hooks).sort(), ['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.ok(res.written.includes(settings) && res.written.includes(p.backup));
  assert.strictEqual(read(logs), logBefore, 'Claude logs untouched'); assert.strictEqual(fs.readdirSync(path.dirname(logs)).length, 1);
  assert.ok(!fs.readdirSync(path.dirname(settings)).some((n) => n.includes('.tmp-')), 'no temp file left behind');
  // run it again (as if the user chose Install twice, with a different budget)
  const p2 = hi.plan({ home, budget: 800, picks: ALL, scope: 'user', now: new Date(2026, 9, 5, 14, 4, 0) });
  hi.apply(p2, ROOT);
  const now2 = readJson(settings);
  assert.strictEqual(now2.hooks.PreToolUse.length, 1); assert.strictEqual(now2.hooks.UserPromptSubmit.length, 1);
  assert.deepStrictEqual(now2.hooks.UserPromptSubmit[0].hooks[0].args.slice(1), ['--budget', '800']);
  assert.strictEqual(now2.hooks.Stop.length, 1);
  assert.strictEqual(fs.readdirSync(path.dirname(settings)).filter((n) => n.includes('.bak-')).length, 2, 'every write was preceded by its own backup');
});

test('a settings file that is not valid JSON is never touched: plan reports why, apply refuses, nothing is created', () => {
  const home = tmpdir('inst-');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{ "hooks": { oops this is // not json');
  const before = listAll(home);
  const p = hi.plan({ home, budget: 1000, picks: ALL, scope: 'user' });
  assert.ok(p.error && /Nothing will be written/.test(p.error));
  assert.throws(() => hi.apply(p, ROOT), /Could not safely merge/);
  assert.deepStrictEqual(listAll(home), before);
  assert.strictEqual(read(settings), '{ "hooks": { oops this is // not json');
});

test('no existing settings: created fresh (no backup); empty file and BOM are fine', () => {
  const home = tmpdir('inst-');
  const p = hi.plan({ home, budget: 1000, picks: ALL, scope: 'user' });
  assert.strictEqual(p.existed, false); assert.strictEqual(p.backup, null);
  hi.apply(p, ROOT);
  assert.ok(readJson(path.join(home, '.claude', 'settings.json')).hooks.PreToolUse);
  const home2 = tmpdir('inst-');
  fs.mkdirSync(path.join(home2, '.claude')); fs.writeFileSync(path.join(home2, '.claude', 'settings.json'), '\uFEFF{"model":"x"}');
  hi.apply(hi.plan({ home: home2, budget: 1000, picks: ALL, scope: 'user' }), ROOT);
  assert.strictEqual(readJson(path.join(home2, '.claude', 'settings.json')).model, 'x');
});

test('the installed copy works on its own: scripts run from ~/.claude/token-saver-hooks with the copied helper files', () => {
  const home = tmpdir('inst-');
  hi.apply(hi.plan({ home, budget: 1000, picks: ALL, scope: 'user' }), ROOT);
  const dir = hi.hooksDir(home);
  writeProjects(path.join(home, '.claude', 'projects'), { 'hub/a.jsonl': [asst({ at: new Date(Date.now() - 60000), sid: 'z', usage: { output: M15 * 55 } })] }); // $825
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' });
  const r = spawnSync(process.execPath, [path.join(dir, 'budget-guard.js'), '--budget', '1000'], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'z', prompt: 'x' }), encoding: 'utf8', env });
  assert.strictEqual(r.status, 0);
  assert.ok(/\$825 of \$1,000/.test(JSON.parse(r.stdout).systemMessage), r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'token-saver-state.json')), 'state file lives under ~/.claude');
  const g = spawnSync(process.execPath, [path.join(dir, 'guard-reads.js')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:\\a\\node_modules\\b.js' } }), encoding: 'utf8', env });
  assert.strictEqual(JSON.parse(g.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

// ---- the command inside the extension --------------------------------------------------------------------------
const pickId = (id) => (items) => items.find((i) => i.id === id);

// ---- plan -> confirm -> apply races (reviewer r1) ---------------------------------------------------------------
test('settings edited while the confirmation was open: nothing is written, the user\'s newer edits and deny rules survive', () => {
  const home = tmpdir('inst-');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet' }));
  const p = hi.plan({ home, budget: 1000, picks: ALL, scope: 'user' });
  const edited = JSON.stringify({ model: 'opus', permissions: { deny: ['Read(./private/**)'] } });
  fs.writeFileSync(settings, edited); // the user edits settings.json while the modal is up
  const before = listAll(home);
  assert.throws(() => hi.apply(p, ROOT), /changed while the confirmation was open/);
  assert.strictEqual(read(settings), edited, 'newer edits and the deny rule are intact');
  assert.deepStrictEqual(listAll(home), before, 'no scripts, backup or temp file were written');
  // a fresh plan sees the new content and keeps it
  hi.apply(hi.plan({ home, budget: 1000, picks: ALL, scope: 'user' }), ROOT);
  const now = readJson(settings);
  assert.strictEqual(now.model, 'opus'); assert.ok(now.permissions.deny.includes('Read(./private/**)')); assert.ok(now.hooks.PreToolUse);
});

test('settings created while the confirmation was open (none existed at plan time): never overwritten', () => {
  const home = tmpdir('inst-');
  const settings = path.join(home, '.claude', 'settings.json');
  const p = hi.plan({ home, budget: 1000, picks: ALL, scope: 'user' });
  assert.strictEqual(p.existed, false);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const theirs = JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } });
  fs.writeFileSync(settings, theirs);
  const before = listAll(home);
  assert.throws(() => hi.apply(p, ROOT), /changed while the confirmation was open/);
  assert.strictEqual(read(settings), theirs); assert.deepStrictEqual(listAll(home), before);
  // exclusive create is the second line of defence if the file appears between the re-check and the write
  const fired0 = false; let fired = fired0;
  const p2 = hi.plan({ home: tmpdir('inst-'), budget: 1000, picks: ALL, scope: 'user' });
  fs.mkdirSync(path.dirname(p2.file), { recursive: true });
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = function (f, d, o) { if (f === p2.file && !fired) { fired = true; origWrite.call(fs, f, theirs); } return origWrite.call(fs, f, d, o); };
  try { assert.throws(() => hi.apply(p2, ROOT), /was created while the confirmation was open/); } finally { fs.writeFileSync = origWrite; }
  assert.strictEqual(read(p2.file), theirs, 'a file that appeared at the last moment is kept');
});

test('settings removed while the confirmation was open: aborts instead of recreating from a stale plan', () => {
  const home = tmpdir('inst-');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet' }));
  const p = hi.plan({ home, budget: 1000, picks: ALL, scope: 'user' });
  fs.unlinkSync(settings);
  assert.throws(() => hi.apply(p, ROOT), /changed while the confirmation was open/);
  assert.ok(!fs.existsSync(settings));
});

test('a settings path that cannot be read (not ENOENT) is an error, never treated as "no file"', () => {
  const home = tmpdir('inst-');
  fs.mkdirSync(path.join(home, '.claude', 'settings.json'), { recursive: true }); // a directory where the file should be
  const p = hi.plan({ home, budget: 1000, picks: ALL, scope: 'user' });
  assert.ok(p.error && /Could not read/.test(p.error) && /Nothing will be written/.test(p.error), String(p.error));
  assert.strictEqual(p.existed, false);
  const before = listAll(home);
  assert.throws(() => hi.apply(p, ROOT), /Could not read/);
  assert.deepStrictEqual(listAll(home), before);
});

test('backups never overwrite an earlier backup, even with the same timestamp', () => {
  const home = tmpdir('inst-');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const first = JSON.stringify({ model: 'one' });
  fs.writeFileSync(settings, first);
  const now = new Date(2026, 9, 5, 14, 3, 9);
  const p1 = hi.plan({ home, budget: 1000, picks: ALL, scope: 'user', now });
  const r1 = hi.apply(p1, ROOT);
  const p2 = hi.plan({ home, budget: 900, picks: ALL, scope: 'user', now }); // same second -> same wanted backup name
  assert.strictEqual(p2.backup, p1.backup);
  const r2 = hi.apply(p2, ROOT);
  assert.notStrictEqual(r2.backup, r1.backup);
  assert.strictEqual(read(r1.backup), first, 'the first backup still holds the original file');
  assert.deepStrictEqual(readJson(r2.backup).hooks.UserPromptSubmit[0].hooks[0].args.slice(1), ['--budget', '1000'], 'second backup holds the first install');
});
const pickedAll = (items) => items.filter((i) => i.picked);

test('command: shows a preview, writes NOTHING until the user confirms (cancel at every step leaves the disk unchanged)', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    ext.activate(ctx);
    const home = process.env.HOME;
    const snapshot = () => listAll(home).map((p) => p + ':' + fs.statSync(p).size);
    const before = snapshot();
    // 1. dismiss the first menu
    vs.pickQueue = [undefined];
    await vs.cmds['claudeUsage.installHooks']();
    assert.strictEqual(vs.docs.length, 1, 'preview opened');
    assert.ok(vs.docs[0].content.includes('nothing has been written') && vs.docs[0].content.includes('guard-reads.js') && /"PreToolUse"/.test(vs.docs[0].content));
    assert.deepStrictEqual(snapshot(), before);
    // 2. choose install, pick parts, then say no in the modal
    vs.pickQueue = [pickId('user'), pickedAll];
    vs.nextWarn = undefined;
    await vs.cmds['claudeUsage.installHooks']();
    const modal = vs.messages.filter((m) => m.level === 'warn').pop();
    assert.ok(modal && modal.rest[0].modal === true && /token-saver-hooks/.test(modal.rest[0].detail) && modal.rest[1] === 'Write files');
    assert.deepStrictEqual(snapshot(), before, 'declined: still nothing written');
    // 3. the parts menu is cancelled
    vs.pickQueue = [pickId('user'), undefined];
    await vs.cmds['claudeUsage.installHooks']();
    assert.deepStrictEqual(snapshot(), before);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')));
  });
});

test('command: copy options go to the clipboard and write nothing', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 640; }, async ({ vs, ext, ctx }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    ext.activate(ctx);
    const home = process.env.HOME;
    const before = listAll(home);
    vs.pickQueue = [pickId('copy')];
    await vs.cmds['claudeUsage.installHooks']();
    const snip = JSON.parse(vs.clipboard[0]);
    assert.deepStrictEqual(Object.keys(snip.hooks).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptSubmit']);
    assert.deepStrictEqual(snip.hooks.UserPromptSubmit[0].hooks[0].args.slice(1), ['--budget', '640'], 'uses your configured budget');
    vs.pickQueue = [pickId('copyDeny')];
    await vs.cmds['claudeUsage.installHooks']();
    assert.deepStrictEqual(JSON.parse(vs.clipboard[1]).permissions.deny, hi.DENY_RULES);
    assert.deepStrictEqual(listAll(home), before);
  });
});

test('command: after "Write files" it installs, with a backup of the existing settings', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    const home = process.env.HOME;
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet' }));
    ext.activate(ctx);
    vs.pickQueue = [pickId('user'), (items) => items.filter((i) => i.id !== 'trim' && i.id !== 'deny')]; // user unticks the trimmer
    vs.nextWarn = 'Write files';
    await vs.cmds['claudeUsage.installHooks']();
    const now = readJson(settings);
    assert.strictEqual(now.model, 'sonnet'); assert.deepStrictEqual(Object.keys(now.hooks).sort(), ['PreToolUse', 'UserPromptSubmit']);
    assert.strictEqual(now.permissions, undefined, 'permissions.deny was not ticked');
    const baks = fs.readdirSync(path.join(home, '.claude')).filter((n) => n.startsWith('settings.json.bak-'));
    assert.strictEqual(baks.length, 1); assert.strictEqual(read(path.join(home, '.claude', baks[0])), JSON.stringify({ model: 'sonnet' }));
    assert.ok(fs.existsSync(path.join(home, '.claude', 'token-saver-hooks', 'guard-reads.js')));
    assert.ok(vs.infos.some((i) => /installed/.test(i.m)));
  });
});

test('command: project install needs an open folder and writes only .claude/settings.local.json there; a broken settings file aborts', async () => {
  await withExtension((vs) => { vs.settings.monthlyBudgetUsd = 1000; }, async ({ vs, ext, ctx }) => {
    ext._test.setClock(() => L(2026, 10, 10, 12));
    ext.activate(ctx);
    const home = process.env.HOME;
    const before = listAll(home);
    vs.pickQueue = [pickId('project')];
    await vs.cmds['claudeUsage.installHooks']();
    assert.ok(vs.messages.some((m) => /Open a folder first/.test(m.m)));
    assert.deepStrictEqual(listAll(home), before);
    const ws = tmpdir('ws-');
    vs.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
    vs.pickQueue = [pickId('project'), pickedAll];
    vs.nextWarn = 'Write files';
    await vs.cmds['claudeUsage.installHooks']();
    assert.ok(readJson(path.join(ws, '.claude', 'settings.local.json')).hooks.PreToolUse);
    assert.ok(!fs.existsSync(path.join(ws, '.claude', 'settings.json')), 'shared project settings are never touched');
    // broken file in the user location
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ nope');
    const snap = listAll(home).length;
    vs.pickQueue = [pickId('user'), pickedAll];
    vs.nextWarn = 'Write files';
    await vs.cmds['claudeUsage.installHooks']();
    assert.ok(vs.messages.some((m) => m.level === 'crit' && /Nothing will be written/.test(m.m)));
    assert.strictEqual(listAll(home).length, snap, 'nothing new on disk');
    assert.strictEqual(read(path.join(home, '.claude', 'settings.json')), '{ nope');
  });
});

// ---- templates --------------------------------------------------------------------------------------------------
test('templates: CLAUDE.md starter and /new-dashboard command are generic, short, and use clear placeholders', () => {
  const md = read(path.join(ROOT, 'templates', 'CLAUDE.template.md'));
  for (const section of ['## Architecture', '## How a dashboard registers with the hub', '## Conventions', '## Commands', '## Do not read']) assert.ok(md.includes(section), section);
  const ph = md.match(/\{\{[A-Z_]+/g) || [];
  assert.ok(ph.length >= 12, 'placeholders: ' + ph.length);
  for (const p of ['{{HUB_NAME', '{{DASHBOARD_DIR', '{{REGISTRY_FILE', '{{INSTALL_CMD', '{{DEV_CMD', '{{TEST_CMD', '{{BUILD_CMD']) assert.ok(md.includes(p), p);
  assert.ok(md.includes('node_modules') && md.includes('package-lock.json'));
  assert.ok(md.split('\n').length < 60 && md.length < 3500, 'a CLAUDE.md is re-sent every request, so the template stays small');
  const cmd = read(path.join(ROOT, 'templates', '.claude', 'commands', 'new-dashboard.md'));
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(cmd);
  assert.ok(fm, 'frontmatter');
  for (const key of ['description:', 'argument-hint:', 'allowed-tools:']) assert.ok(fm[1].includes(key), key);
  assert.ok(/\$0/.test(cmd) && /\$ARGUMENTS/.test(cmd), 'uses the documented argument placeholders');
  assert.ok(/\{\{REGISTRY_FILE\}\}/.test(cmd) && /\{\{PATTERN_DIR\}\}/.test(cmd));
  assert.ok(!/Bash/.test(fm[1]), 'no shell access needed to scaffold');
  for (const text of [md, cmd]) assert.ok(!/(eli|kimjong|\\Users\\|\/home\/)/i.test(text), 'nothing personal baked in');
});

test('hooks README states plainly what the API cannot do', () => {
  const r = read(path.join(ROOT, 'hooks', 'README.md'));
  assert.ok(/Trim huge \*\*Read \/ Grep \/ Glob\*\* output \| \*\*No\*\*/.test(r));
  assert.ok(/Hard-enforce[^|]*\| \*\*Not with hooks\*\*/.test(r));
  assert.ok(/fails open/i.test(r) && /permissions\.deny/.test(r));
});
