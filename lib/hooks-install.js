'use strict';
// Token-Saver hooks installer. This is the ONLY module in the extension that writes files, and it is only
// reached after the user confirms in a modal dialog (see extension.js). It never touches ~/.claude/projects.
//
//   plan()  - works out exactly what would be written (reads the settings file, writes nothing); shown to the user first
//   apply() - copies the hook scripts, backs up the settings file, merges the hooks in, writes it back
//
// Settings handling is deliberately conservative: the file must already parse as JSON (otherwise nothing is
// written), the original is copied to <name>.bak-<timestamp> first, every hook/permission that is not ours is
// kept, and our own entries are recognised by their path so a second install replaces instead of duplicating.
const fs = require('fs');
const path = require('path');

const HOOK_FILES = ['_common.js', 'guard-reads.js', 'budget-guard.js', 'trim-output.js'];
const LIB_FILES = ['usage.js', 'pricing.js', 'paths.js'];
const DIR_NAME = 'token-saver-hooks';
const DENY_RULES = [
  'Read(**/node_modules/**)', 'Read(**/dist/**)', 'Read(**/build/**)', 'Read(**/.next/**)', 'Read(**/coverage/**)',
  'Read(**/package-lock.json)', 'Read(**/yarn.lock)', 'Read(**/pnpm-lock.yaml)', 'Read(**/*.min.js)', 'Read(**/*.min.css)', 'Read(**/*.map)',
];

function hooksDir(home, pathMod) { return (pathMod || path).join(home, '.claude', DIR_NAME); }

function settingsPath(scope, o) {
  const pm = (o && o.pathMod) || path;
  if (scope === 'project') return pm.join(o.workspaceDir, '.claude', 'settings.local.json');
  return pm.join(o.home, '.claude', 'settings.json');
}

// picks: { guard, budget, trim, deny } booleans. Returns the settings fragment to merge.
function buildSnippet(o) {
  const pm = o.pathMod || path;
  const dir = o.dir;
  const picks = o.picks || { guard: true, budget: true, trim: true };
  const cmd = (script, args, timeout) => ({ type: 'command', command: 'node', args: [pm.join(dir, script)].concat(args || []), timeout });
  const hooks = {};
  if (picks.guard) hooks.PreToolUse = [{ matcher: 'Read|Grep|Glob', hooks: [cmd('guard-reads.js', ['--mode', 'deny'], 10)] }];
  if (picks.budget) hooks.UserPromptSubmit = [{ hooks: [cmd('budget-guard.js', ['--budget', String(o.budget > 0 ? o.budget : 1000)], 20)] }];
  if (picks.trim) hooks.PostToolUse = [{ matcher: 'Bash|PowerShell|mcp__.*', hooks: [cmd('trim-output.js', [], 10)] }];
  const out = {};
  if (Object.keys(hooks).length) out.hooks = hooks;
  if (picks.deny) out.permissions = { deny: DENY_RULES.slice() };
  return out;
}

const isOurs = (h) => {
  const text = [h && h.command].concat((h && h.args) || []).filter((x) => typeof x === 'string').join(' ').replace(/\\/g, '/');
  return text.includes('/' + DIR_NAME + '/');
};

// Pure merge. Throws on a settings shape we do not understand (caller then writes nothing).
function mergeSettings(existing, snippet) {
  const base = existing === undefined || existing === null ? {} : existing;
  if (typeof base !== 'object' || Array.isArray(base)) throw new Error('settings file is not a JSON object');
  const out = Object.assign({}, base);
  if (snippet.hooks) {
    if (out.hooks !== undefined && (typeof out.hooks !== 'object' || out.hooks === null || Array.isArray(out.hooks))) throw new Error('"hooks" in the settings file is not an object');
    const hooks = Object.assign({}, out.hooks || {});
    // Drop earlier Token-Saver entries for every event, keep everything else.
    for (const ev of Object.keys(hooks)) {
      if (!Array.isArray(hooks[ev])) throw new Error(`"hooks.${ev}" in the settings file is not a list`);
      const kept = hooks[ev].map((g) => (g && Array.isArray(g.hooks) ? Object.assign({}, g, { hooks: g.hooks.filter((h) => !isOurs(h)) }) : g))
        .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
      if (kept.length) hooks[ev] = kept; else delete hooks[ev];
    }
    for (const [ev, groups] of Object.entries(snippet.hooks)) hooks[ev] = (hooks[ev] || []).concat(groups);
    out.hooks = hooks;
  }
  if (snippet.permissions) {
    if (out.permissions !== undefined && (typeof out.permissions !== 'object' || out.permissions === null || Array.isArray(out.permissions))) throw new Error('"permissions" in the settings file is not an object');
    const perms = Object.assign({}, out.permissions || {});
    if (perms.deny !== undefined && !Array.isArray(perms.deny)) throw new Error('"permissions.deny" in the settings file is not a list');
    const deny = (perms.deny || []).slice();
    for (const r of snippet.permissions.deny) if (!deny.includes(r)) deny.push(r);
    perms.deny = deny;
    out.permissions = perms;
  }
  return out;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// Works out what apply() would do. Reads the settings file (read-only) but writes nothing.
function plan(o) {
  const pm = o.pathMod || path;
  const dir = hooksDir(o.home, pm);
  const snippet = buildSnippet({ dir, budget: o.budget, picks: o.picks, pathMod: pm });
  const file = settingsPath(o.scope || 'user', { home: o.home, workspaceDir: o.workspaceDir, pathMod: pm });
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { /* no settings file yet */ }
  const res = { dir, file, snippet, existed: raw !== null, backup: null, text: null, error: null, scripts: [], libs: [] };
  if (snippet.hooks) {
    res.scripts = HOOK_FILES.map((f) => pm.join(dir, f));
    res.libs = LIB_FILES.map((f) => pm.join(dir, 'lib', f));
  }
  try {
    let current;
    if (raw !== null && raw.trim() !== '') current = JSON.parse(raw.replace(/^\uFEFF/, ''));
    res.text = JSON.stringify(mergeSettings(current, snippet), null, 2) + '\n';
  } catch (e) {
    res.error = `Could not safely merge into ${file}: ${e.message}. Nothing will be written; use the copy option and merge by hand.`;
  }
  if (raw !== null && !res.error) res.backup = file + '.bak-' + stamp(o.now || new Date());
  return res;
}

// Performs the plan. `srcRoot` is the extension folder holding hooks/ and lib/.
function apply(p, srcRoot) {
  if (p.error) throw new Error(p.error);
  const written = [];
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); written.push(to); };
  for (const to of p.scripts) copy(path.join(srcRoot, 'hooks', path.basename(to)), to);
  for (const to of p.libs) copy(path.join(srcRoot, 'lib', path.basename(to)), to);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  if (p.backup) { fs.copyFileSync(p.file, p.backup); written.push(p.backup); }
  const tmp = p.file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, p.text);
  fs.renameSync(tmp, p.file);
  written.push(p.file);
  return { written };
}

module.exports = { HOOK_FILES, LIB_FILES, DENY_RULES, DIR_NAME, hooksDir, settingsPath, buildSnippet, mergeSettings, plan, apply };
