'use strict';
// Plan handoff: the model/effort heuristic, savings, the launch command, the handoff folder reader and the hook.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('./harness');
const { tmpdir } = require('./helpers');
const advice = require('../lib/plan-advice');
const handoffs = require('../lib/handoffs');
const savePlan = require('../hooks/save-plan');

const ROOT = path.join(__dirname, '..');

const ROUTINE = `# Fix the date format on the invoice page

- Change formatDate in src/utils/date.ts to use the user's locale
- Update the snapshot in src/utils/date.test.ts
- Run npm test`;

const MULTI = `# Plan: refund approvals with an audit trail

1. Add an approvals table component in src/dashboards/refunds/Approvals.tsx
2. Extend the API client in src/shared/api/client.ts with approve/reject calls
3. Register the view in src/hub/registry.ts
4. Add server route in server/routes/refunds.ts
5. Tests in test/refunds.test.ts`;

const SECURITY = `# Rotate session handling

Replace the cookie-based session with signed JWT access tokens and add CSRF protection to the form posts.
Touch only lib/session.ts.`;

const HUGE = `# Platform rewrite

` + Array.from({ length: 24 }, (_, i) => `- Update module${i}/index.ts and module${i}/service.ts`).join('\n') + `

Open questions: TBD which queue to use. Unclear whether the old API stays. Investigate the cache. Not sure about rollout?`;

test('suggest: routine -> Sonnet medium, multi-module -> Opus high, huge/ambiguous -> Opus max, with a one-line reason', () => {
  const r = advice.suggest(ROUTINE);
  assert.deepStrictEqual([r.model, r.effort, r.tier], ['sonnet', 'medium', 'routine']);
  assert.ok(/^Routine: 2 files in 1 area/.test(r.reason), r.reason);
  const m = advice.suggest(MULTI);
  assert.deepStrictEqual([m.model, m.effort, m.tier], ['opus', 'high', 'multi']);
  assert.ok(/^Multi-module: 5 files in [45] areas/.test(m.reason), m.reason);
  const s = advice.suggest(SECURITY);
  assert.deepStrictEqual([s.model, s.effort], ['opus', 'high']);
  assert.ok(/Risky change: 1 file in 1 area; mentions security/.test(s.reason), s.reason);
  const h = advice.suggest(HUGE);
  assert.deepStrictEqual([h.model, h.effort, h.tier], ['opus', 'max', 'huge']);
  assert.ok(/^Large or open-ended: .*48 files .*open questions/.test(h.reason), h.reason);
  assert.ok(advice.suggest('# Migrate users\nMove auth to a new database schema.').effort === 'max', 'security AND migration -> max');
  assert.ok(advice.suggest(MULTI).reason.length < 160 && !advice.suggest(MULTI).reason.includes('\n'), 'one line');
  // deterministic: same text, same answer
  assert.deepStrictEqual(advice.suggest(MULTI), advice.suggest(MULTI));
});

test('features: counts files and areas from paths (both separators), ignores URLs, version numbers and and/or phrases', () => {
  const x = advice.features('Edit src\\hub\\a.ts and src/hub/b.ts, then lib/c.js. See https://example.com/docs/page.html. Bump to 1.2.3. Read and/or write. Also README.md');
  assert.deepStrictEqual(x.files.sort(), ['README.md', 'lib/c.js', 'src/hub/a.ts', 'src/hub/b.ts']);
  assert.deepStrictEqual(x.areas.sort(), ['(root)', 'lib', 'src/hub']);
  assert.strictEqual(advice.features('No files here, just words?').open, 1);
});

test('savings: fresh session = median first-request context of this project + the plan, compared with the current context', () => {
  const sessions = [
    { sid: 'cur', cwd: '/w/shop', firstCtx: 18000, lastCtx: 142000, lastModel: 'claude-sonnet-4-5' },
    { sid: 'b', cwd: '/w/shop', firstCtx: 22000, lastCtx: 30000 },
    { sid: 'c', cwd: '/w/shop', firstCtx: 20000, lastCtx: 30000 },
    { sid: 'd', cwd: '/w/other', firstCtx: 90000, lastCtx: 90000 },
  ];
  const r = advice.savings({ sessions, sid: 'cur', cwd: '/w/shop', planChars: 8000 });
  assert.strictEqual(r.base, 20000); assert.strictEqual(r.planTokens, 2000); assert.strictEqual(r.fresh, 22000);
  assert.strictEqual(r.current, 142000); assert.ok(r.saves);
  // Sonnet 4.5 cache read $0.30/M: 120k tokens * 0.3e-6 = $0.036 per warm request; cache write $3.75/M -> $0.45
  assert.ok(Math.abs(r.perRequestWarm - 0.036) < 1e-9 && Math.abs(r.perRequestCold - 0.45) < 1e-9);
  assert.strictEqual(r.text, 'A fresh session starts at about 22k tokens instead of re-sending 142k: about $0.036 less per request ($0.45 after a cache expiry).');
  const unknown = advice.savings({ sessions: [], planChars: 4000 });
  assert.strictEqual(unknown.basis, 'assumed'); assert.strictEqual(unknown.fresh, advice.FRESH_FALLBACK + 1000);
  assert.ok(/^A fresh session starts at about 21k tokens\.$/.test(unknown.text));
  const small = advice.savings({ sessions, sid: 'b', cwd: '/w/shop', planChars: 40000 });
  assert.ok(!small.saves && /saves little/.test(small.text));
});

test('launch command: verified flags (--model, --effort), plan file as an @-mention first prompt, nothing unchecked reaches the shell', () => {
  const L = advice.launchCommand({ model: 'opus', effort: 'high', relPath: '.claude/handoffs/20261006-150834.md' });
  assert.deepStrictEqual(L.args.slice(0, 4), ['--model', 'opus', '--effort', 'high']);
  assert.strictEqual(L.line, 'claude --model opus --effort high "@.claude/handoffs/20261006-150834.md Implement this plan. It was written in an earlier session, so read the files it names before changing them."');
  assert.ok(!/[`$;&|<>]/.test(L.line.replace(/^claude /, '')), 'no shell metacharacters');
  assert.deepStrictEqual(advice.EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'], 'the levels `claude --help` lists');
  assert.ok(advice.launchCommand({ model: 'claude-opus-4-5-20251101', effort: 'max', relPath: '.claude/handoffs/a.md' }));
  for (const bad of [{ model: 'opus; rm -rf ~', effort: 'high' }, { model: '$(id)', effort: 'high' }, { model: 'opus', effort: 'ultra' }, { model: 'opus', effort: 'high', relPath: '../x.md' }, { model: 'opus', effort: 'high', relPath: '.claude/handoffs/a b.md' }, { model: 'opus', effort: 'high', relPath: '.claude/handoffs/"x".md' }]) {
    assert.throws(() => advice.launchCommand(Object.assign({ relPath: '.claude/handoffs/a.md' }, bad)), /Unsupported|Unexpected/, JSON.stringify(bad));
  }
});

function writePlan(root, name, body, mtime) {
  const dir = path.join(root, '.claude', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

test('handoff reader: lists only <time>.md files newest first, parses front matter and title, offers each new plan once', () => {
  const a = tmpdir('ho-'), b = tmpdir('ho-');
  const now = new Date(2026, 9, 6, 15, 30);
  writePlan(a, '20261006-150000.md', '---\nsource: ExitPlanMode\nsession_id: s-1\ncwd: /w/a\ncreated: x\n---\n\n# Plan: Refund approvals\n\nbody', new Date(2026, 9, 6, 15, 0));
  writePlan(a, '20261006-152000.md', 'No front matter\nsecond line', new Date(2026, 9, 6, 15, 20));
  writePlan(b, '20261006-120000.md', '# Old plan', new Date(2026, 9, 6, 12, 0));
  writePlan(a, 'notes.md', '# not a handoff');
  fs.writeFileSync(path.join(a, '.claude', 'handoffs', '.gitignore'), '*\n');
  const list = handoffs.list([a, b, path.join(a, 'missing')]);
  assert.deepStrictEqual(list.map((e) => e.name), ['20261006-152000.md', '20261006-150000.md', '20261006-120000.md']);
  assert.strictEqual(list[0].relPath, '.claude/handoffs/20261006-152000.md');
  const h = handoffs.read(list[1]);
  assert.strictEqual(h.title, 'Refund approvals'); assert.strictEqual(h.meta.session_id, 's-1'); assert.ok(h.plan.startsWith('# Plan'));
  assert.strictEqual(handoffs.read(list[0]).title, 'No front matter');
  const p1 = handoffs.pending(list, [], now);
  assert.deepStrictEqual(p1.map((e) => e.name), ['20261006-152000.md', '20261006-150000.md'], 'the 12:00 plan is older than an hour: not offered');
  const seen = p1.map(handoffs.keyOf);
  assert.deepStrictEqual(handoffs.pending(list, seen, now), [], 'never offered twice');
  // the same file rewritten (new mtime) counts as a new plan
  fs.utimesSync(list[0].file, new Date(2026, 9, 6, 15, 25), new Date(2026, 9, 6, 15, 25));
  assert.deepStrictEqual(handoffs.pending(handoffs.list([a]), seen, now).map((e) => e.name), ['20261006-152000.md']);
});

function runHook(input, env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'save-plan.js')], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '' }, env || {}) });
}

test('save-plan hook: saves tool_input.plan to <project>/.claude/handoffs/<time>.md with a .gitignore, prints nothing, never blocks', () => {
  const proj = tmpdir('proj-');
  const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', session_id: 'abc-123', cwd: proj, tool_input: { plan: '# Plan\n\n- step one' } });
  assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); assert.strictEqual(r.stderr, '');
  const dir = path.join(proj, '.claude', 'handoffs');
  const files = fs.readdirSync(dir).sort();
  assert.strictEqual(files.length, 2); assert.strictEqual(files[0], '.gitignore'); assert.ok(handoffs.NAME_RE.test(files[1]), files[1]);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
  const h = handoffs.parse(fs.readFileSync(path.join(dir, files[1]), 'utf8'));
  assert.strictEqual(h.meta.source, 'ExitPlanMode'); assert.strictEqual(h.meta.session_id, 'abc-123'); assert.strictEqual(h.meta.cwd, proj);
  assert.strictEqual(h.plan.trim(), '# Plan\n\n- step one');
  // the reader the extension uses finds it
  assert.strictEqual(handoffs.list([proj]).length, 1);
});

test('save-plan hook: reads planFilePath when the plan is not inline, prefers $CLAUDE_PROJECT_DIR, never overwrites, ignores other tools and bad input', () => {
  const proj = tmpdir('proj-'), sub = path.join(proj, 'packages', 'web');
  fs.mkdirSync(sub, { recursive: true });
  const planFile = path.join(tmpdir('plans-'), 'calm-river.md');
  fs.writeFileSync(planFile, '# From the plan file\n');
  const r = runHook({ tool_name: 'ExitPlanMode', session_id: 's', cwd: sub, tool_input: { planFilePath: planFile } }, { CLAUDE_PROJECT_DIR: proj });
  assert.strictEqual(r.status, 0);
  const saved = handoffs.list([proj]);
  assert.strictEqual(saved.length, 1, 'saved at the project root, not the subfolder');
  assert.ok(handoffs.read(saved[0]).plan.includes('# From the plan file'));
  assert.ok(!fs.existsSync(path.join(sub, '.claude')));
  // same second twice -> a second file, the first one untouched
  const now = new Date(2026, 9, 6, 15, 8, 34);
  const p1 = savePlan.save({ tool_name: 'ExitPlanMode', cwd: proj, tool_input: { plan: 'one' } }, {}, now);
  const p2 = savePlan.save({ tool_name: 'ExitPlanMode', cwd: proj, tool_input: { plan: 'two' } }, {}, now);
  assert.strictEqual(path.basename(p1), '20261006-150834.md'); assert.strictEqual(path.basename(p2), '20261006-150834-2.md');
  assert.ok(fs.readFileSync(p1, 'utf8').includes('\none\n'));
  // nothing for other tools, empty plans, garbage input; always exit 0 with no output
  const before = fs.readdirSync(path.join(proj, '.claude', 'handoffs')).length;
  for (const inp of [{ tool_name: 'Read', cwd: proj, tool_input: { plan: 'x' } }, { tool_name: 'ExitPlanMode', cwd: proj, tool_input: { plan: '   ' } }, { tool_name: 'ExitPlanMode', cwd: proj, tool_input: { planFilePath: '/etc/passwd' } }, 'not json', '']) {
    const x = runHook(inp);
    assert.strictEqual(x.status, 0); assert.strictEqual(x.stdout, '');
  }
  assert.strictEqual(fs.readdirSync(path.join(proj, '.claude', 'handoffs')).length, before);
  // newlines in the session id cannot inject front matter keys
  const p3 = savePlan.save({ tool_name: 'ExitPlanMode', cwd: proj, session_id: 'a\ncwd: /evil', tool_input: { plan: 'p' } }, {}, new Date(2026, 9, 6, 16, 0, 0));
  assert.strictEqual(handoffs.parse(fs.readFileSync(p3, 'utf8')).meta.cwd, proj);
});
