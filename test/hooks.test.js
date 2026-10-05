'use strict';
// Hook scripts, tested the way Claude Code runs them: JSON on stdin, JSON on stdout, exit code 0.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { test } = require('./harness');
const { tmpdir, writeProjects, asst, M15 } = require('./helpers');

const HOOKS = path.join(__dirname, '..', 'hooks');
const guard = require('../hooks/guard-reads');
const trim = require('../hooks/trim-output');
const budget = require('../hooks/budget-guard');

function run(script, event, args, env) {
  const input = typeof event === 'string' ? event : JSON.stringify(event);
  const r = spawnSync(process.execPath, [path.join(HOOKS, script)].concat(args || []), { input, encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* leave null */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const pre = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name, tool_input, tool_use_id: 'toolu_1' });
const denied = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'deny';
const reasonOf = (r) => r.json.hookSpecificOutput.permissionDecisionReason;

// ---------------------------------------------------------------- guard-reads
test('guard-reads: node_modules / dist / build folders are denied, with Windows backslash paths and with POSIX paths', () => {
  for (const p of ['C:\\proj\\node_modules\\left-pad\\index.js', '/home/u/app/node_modules/x/y.js', 'C:\\proj\\apps\\web\\dist\\main.js', '/srv/app/build/out.txt', 'D:\\a\\.next\\cache\\x', 'C:\\P\\Node_Modules\\x.js']) {
    const r = run('guard-reads.js', pre('Read', { file_path: p }));
    assert.strictEqual(r.status, 0, p);
    assert.ok(denied(r), 'should deny ' + p + ' got ' + r.stdout);
    assert.ok(reasonOf(r).startsWith('Token-Saver: '));
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  }
  for (const p of ['C:\\proj\\src\\dist-utils.ts', '/home/u/app/src/builder/index.ts', 'C:\\proj\\src\\index.ts', '/home/u/app/README.md']) {
    const r = run('guard-reads.js', pre('Read', { file_path: p }));
    assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, '', 'should allow ' + p);
  }
});

test('guard-reads: lockfiles and minified bundles / source maps are denied, manifests and normal js are allowed', () => {
  for (const p of ['C:\\p\\package-lock.json', '/p/yarn.lock', '/p/pnpm-lock.yaml', '/p/Cargo.lock', '/p/poetry.lock', '/p/app.min.js', 'C:\\p\\site.min.css', '/p/vendor.js.map', '/p/main.bundle.js']) {
    assert.ok(denied(run('guard-reads.js', pre('Read', { file_path: p }))), p);
  }
  for (const p of ['/p/package.json', '/p/admin.js', '/p/min.js', '/p/lockfile-notes.md']) assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: p })).stdout, '', p);
});

test('guard-reads: binary files are denied by extension and by content; images and PDFs pass unless huge', () => {
  const d = tmpdir('hk-');
  const exe = path.join(d, 'tool.exe'); fs.writeFileSync(exe, 'MZ');
  assert.ok(denied(run('guard-reads.js', pre('Read', { file_path: exe }))));
  assert.ok(denied(run('guard-reads.js', pre('Read', { file_path: 'C:\\x\\data.sqlite' }))), 'extension alone is enough even if the file is missing here');
  const odd = path.join(d, 'blob.xyz'); fs.writeFileSync(odd, Buffer.from([65, 66, 0, 67, 68]));
  const r = run('guard-reads.js', pre('Read', { file_path: odd }));
  assert.ok(denied(r) && /binary/.test(reasonOf(r)));
  const png = path.join(d, 'shot.png'); fs.writeFileSync(png, Buffer.alloc(2048, 1));
  assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: png })).stdout, '', 'a screenshot is fine');
  const big = run('guard-reads.js', pre('Read', { file_path: png }), ['--max-binary-kb', '1']);
  assert.ok(denied(big) && /2 KB/.test(reasonOf(big)));
  assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: path.join(d, 'nope.txt') })).stdout, '', 'a missing file is left for Read to report');
  assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: d })).stdout, '', 'a directory is not our business');
});

test('guard-reads: huge text files are denied unless read with offset/limit, or raised with --max-kb', () => {
  const d = tmpdir('hk-');
  const big = path.join(d, 'huge.log'); fs.writeFileSync(big, 'line of text\n'.repeat(25000)); // ~325 KB
  const small = path.join(d, 'small.ts'); fs.writeFileSync(small, 'export const a = 1;\n');
  const r = run('guard-reads.js', pre('Read', { file_path: big }));
  assert.ok(denied(r)); assert.ok(/huge\.log is 3\d\d KB/.test(reasonOf(r)), reasonOf(r)); assert.ok(/Grep/.test(reasonOf(r)) && /offset and limit/.test(reasonOf(r)));
  assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: big, limit: 200 })).stdout, '', 'bounded read allowed');
  assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: big, offset: 1000 })).stdout, '');
  assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: big }), ['--max-kb', '1000']).stdout, '', 'limit raised');
  assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: small })).stdout, '');
});

test('guard-reads: Grep and Glob are checked by their path; Bash and other tools are never touched', () => {
  assert.ok(denied(run('guard-reads.js', pre('Grep', { pattern: 'x', path: 'C:\\proj\\node_modules' }))));
  assert.ok(denied(run('guard-reads.js', pre('Glob', { pattern: '**/*.js', path: '/p/build' }))));
  assert.strictEqual(run('guard-reads.js', pre('Grep', { pattern: 'x' })).stdout, '');
  assert.strictEqual(run('guard-reads.js', pre('Grep', { pattern: 'x', path: '/p/src' })).stdout, '');
  assert.strictEqual(run('guard-reads.js', pre('Bash', { command: 'cat node_modules/x/index.js' })).stdout, '', 'documented limit: Bash is not guarded');
  assert.strictEqual(run('guard-reads.js', pre('Edit', { file_path: '/p/node_modules/x.js' })).stdout, '');
  assert.strictEqual(run('guard-reads.js', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/p/node_modules/x.js' } }).stdout, '', 'wrong event');
});

test('guard-reads: --mode ask / warn, and --allow carve-outs', () => {
  const p = { file_path: '/p/node_modules/my-fork/index.js' };
  const ask = run('guard-reads.js', pre('Read', p), ['--mode', 'ask']);
  assert.strictEqual(ask.json.hookSpecificOutput.permissionDecision, 'ask');
  const warn = run('guard-reads.js', pre('Read', p), ['--mode', 'warn']);
  assert.ok(warn.json.hookSpecificOutput.additionalContext.startsWith('Token-Saver:'));
  assert.strictEqual(warn.json.hookSpecificOutput.permissionDecision, undefined, 'warn never blocks');
  assert.strictEqual(run('guard-reads.js', pre('Read', p), ['--allow', 'node_modules/my-fork']).stdout, '');
  assert.strictEqual(run('guard-reads.js', pre('Read', { file_path: 'C:\\P\\node_modules\\My-Fork\\a.js' }), ['--allow', 'node_modules/my-fork']).stdout, '', 'allow matches across separators and case');
  assert.ok(denied(run('guard-reads.js', pre('Read', { file_path: '/p/node_modules/other/a.js' }), ['--allow', 'node_modules/my-fork'])));
});

test('guard-reads: fails open on garbage, empty input, missing fields; never exits non-zero', () => {
  for (const input of ['', 'not json', '{"hook_event_name":"PreToolUse"}', '{"hook_event_name":"PreToolUse","tool_name":"Read"}', '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":42}}', 'null', '[]']) {
    const r = run('guard-reads.js', input);
    assert.strictEqual(r.status, 0, JSON.stringify(input)); assert.strictEqual(r.stdout, '');
  }
});

// ---------------------------------------------------------------- trim-output
const post = (tool_name, tool_response, extra) => Object.assign({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name, tool_input: {}, tool_response, tool_use_id: 'toolu_2' }, extra || {});

test('trim-output: Bash output over the limit is shortened in the documented Bash shape (every other field kept), head and tail preserved', () => {
  const head = 'START-' + 'a'.repeat(9000), tail = 'z'.repeat(9000) + '-END';
  const stdout = head + 'm'.repeat(40000) + tail;
  const r = run('trim-output.js', post('Bash', { stdout, stderr: '', interrupted: false, isImage: false }));
  assert.strictEqual(r.status, 0);
  const out = r.json.hookSpecificOutput;
  assert.strictEqual(out.hookEventName, 'PostToolUse');
  assert.deepStrictEqual(Object.keys(out.updatedToolOutput).sort(), ['interrupted', 'isImage', 'stderr', 'stdout']);
  assert.strictEqual(out.updatedToolOutput.interrupted, false); assert.strictEqual(out.updatedToolOutput.isImage, false);
  const t = out.updatedToolOutput.stdout;
  assert.ok(t.length < stdout.length / 3 && t.length < 13000, 'much shorter: ' + t.length);
  assert.ok(t.startsWith('START-') && t.endsWith('-END'), 'start and end are kept (errors and summaries live there)');
  assert.ok(/Token-Saver trimmed [\d,]+ of 58,\d{3} characters/.test(t), t.slice(5990, 6300));
});

test('trim-output: small output, Read/Grep/Glob output and other events are left alone', () => {
  assert.strictEqual(run('trim-output.js', post('Bash', { stdout: 'ok', stderr: '', interrupted: false, isImage: false })).stdout, '');
  const huge = { stdout: 'x'.repeat(100000), stderr: '' };
  for (const tool of ['Read', 'Grep', 'Glob', 'Edit']) assert.strictEqual(run('trim-output.js', post(tool, huge)).stdout, '', tool + ' is not trimmed (output shape undocumented)');
  assert.strictEqual(run('trim-output.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_response: huge }).stdout, '');
  assert.strictEqual(run('trim-output.js', post('Bash', undefined)).stdout, '');
});

test('trim-output: stderr is trimmed too; --max-chars and --keep are honoured; MCP results keep the shape they arrived in', () => {
  const r = run('trim-output.js', post('Bash', { stdout: 'ok', stderr: 'e'.repeat(5000), interrupted: false, isImage: false }), ['--max-chars', '2000', '--keep', '500']);
  assert.ok(r.json.hookSpecificOutput.updatedToolOutput.stderr.length < 1300);
  const mcpString = run('trim-output.js', post('mcp__db__query', 'r'.repeat(30000)));
  assert.strictEqual(typeof mcpString.json.hookSpecificOutput.updatedToolOutput, 'string');
  const blocks = [{ type: 'text', text: 't'.repeat(30000) }, { type: 'image', source: { data: 'AAAA' } }];
  const mcpArr = run('trim-output.js', post('mcp__db__query', blocks)).json.hookSpecificOutput.updatedToolOutput;
  assert.ok(Array.isArray(mcpArr) && mcpArr.length === 2 && mcpArr[0].type === 'text' && mcpArr[0].text.length < 14000);
  assert.deepStrictEqual(mcpArr[1], blocks[1], 'non-text blocks untouched');
  const mcpObj = run('trim-output.js', post('mcp__db__query', { content: [{ type: 'text', text: 'q'.repeat(30000) }], isError: false })).json.hookSpecificOutput.updatedToolOutput;
  assert.strictEqual(mcpObj.isError, false); assert.ok(mcpObj.content[0].text.length < 14000);
  assert.strictEqual(run('trim-output.js', 'garbage').status, 0);
});

// ---------------------------------------------------------------- budget-guard
const cfg = (o) => Object.assign({ budget: 1000, warn: 75, crit: 90, blockOver: 0, noContext: false }, o || {});
const prompt = (sid) => ({ hook_event_name: 'UserPromptSubmit', session_id: sid || 's1', prompt: 'hi' });
const NOW = new Date(2026, 9, 15, 12);

test('budget-guard: silent below the warning threshold; warns once per session at 75%, again once at 90%', () => {
  let st = {};
  let r = budget.decide(prompt(), cfg(), 500, st, NOW); assert.strictEqual(r.output, null); st = r.state;
  r = budget.decide(prompt(), cfg(), 760, st, NOW); st = r.state;
  assert.ok(/Warning: Claude Code spend is \$760 of \$1,000 this month \(76%\)/.test(r.output.systemMessage), r.output.systemMessage);
  assert.ok(/resets on the 1st/i.test(r.output.systemMessage));
  assert.strictEqual(r.output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(/Be economical/.test(r.output.hookSpecificOutput.additionalContext));
  r = budget.decide(prompt(), cfg(), 770, st, NOW); assert.strictEqual(r.output, null, 'never nags the same session at the same level'); st = r.state;
  r = budget.decide(prompt(), cfg(), 920, st, NOW); st = r.state;
  assert.ok(/Critical: .*\(92%\)/.test(r.output.systemMessage), 'critical is its own, second, notice');
  r = budget.decide(prompt(), cfg(), 950, st, NOW); assert.strictEqual(r.output, null);
  r = budget.decide(prompt('other'), cfg(), 950, st, NOW); assert.ok(r.output, 'a new session hears about it once');
});

test('budget-guard: a new month starts clean; --block-over refuses prompts; --no-context keeps Claude\'s context unchanged', () => {
  let r = budget.decide(prompt(), cfg(), 800, {}, NOW);
  const nov = new Date(2026, 10, 2, 9);
  const again = budget.decide(prompt(), cfg(), 800, r.state, nov);
  assert.ok(again.output, 'October warnings do not silence November');
  assert.strictEqual(again.state.month, '2026-11');
  const blocked = budget.decide(prompt(), cfg({ blockOver: 100 }), 1010, {}, NOW);
  assert.strictEqual(blocked.output.decision, 'block'); assert.ok(/\$1,010 of \$1,000/.test(blocked.output.reason));
  assert.strictEqual(budget.decide(prompt(), cfg({ blockOver: 100 }), 990, {}, NOW).output.decision, undefined, 'under the limit is not blocked');
  const quiet = budget.decide(prompt(), cfg({ noContext: true }), 800, {}, NOW);
  assert.ok(quiet.output.systemMessage && quiet.output.hookSpecificOutput === undefined);
  assert.strictEqual(budget.decide({ hook_event_name: 'PreToolUse' }, cfg(), 999, {}, NOW).output, null, 'only UserPromptSubmit');
  const c = budget.configFrom({ budget: '250', warn: '50', crit: '60', 'block-over': '95', 'no-context': 'true', 'data-dir': ['/x'] }, {});
  assert.deepStrictEqual([c.budget, c.warn, c.crit, c.blockOver, c.noContext, c.dataDirs], [250, 50, 60, 95, true, ['/x']]);
  assert.strictEqual(budget.configFrom({}, { CLAUDE_USAGE_BUDGET_USD: '400' }).budget, 400);
  assert.strictEqual(budget.configFrom({}, {}).budget, 1000);
});

test('budget-guard end to end: reads the real log format read-only, warns once, remembers it, and honours the 1st-of-month reset', () => {
  const home = tmpdir('bg-');
  const projects = path.join(home, '.claude', 'projects');
  const now = new Date();
  const at = new Date(+now - 5 * 60000);
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);
  writeProjects(projects, {
    'hub/a.jsonl': [asst({ at, sid: 'live', usage: { output: M15 * 50 } })],      // $750 this month
    'hub/old.jsonl': [asst({ at: lastMonth, sid: 'prev', usage: { output: M15 * 200 } })], // $3,000 last month: must NOT count
  });
  const logFile = path.join(projects, 'hub', 'a.jsonl');
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const before = sha(logFile);
  const state = path.join(home, 'state.json');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' };
  const first = run('budget-guard.js', prompt('live'), ['--budget', '1000', '--state', state], env);
  assert.strictEqual(first.status, 0);
  assert.ok(/Warning: Claude Code spend is \$750 of \$1,000 this month \(75%\)/.test(first.json.systemMessage), first.stdout + first.stderr);
  const second = run('budget-guard.js', prompt('live'), ['--budget', '1000', '--state', state], env);
  assert.strictEqual(second.stdout, '', 'same session: no repeat');
  assert.ok(JSON.parse(fs.readFileSync(state, 'utf8')).warned.live.warn);
  assert.strictEqual(run('budget-guard.js', prompt('x'), ['--budget', '100000', '--state', state], env).stdout, '', 'well under budget');
  assert.strictEqual(sha(logFile), before, 'the Claude log was not modified');
  assert.strictEqual(fs.readdirSync(path.join(projects, 'hub')).length, 2, 'no files added next to the logs');
  assert.strictEqual(run('budget-guard.js', 'not json', ['--state', state], env).status, 0);
});
