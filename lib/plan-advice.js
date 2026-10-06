'use strict';
// Plan handoff advice: which model and effort to suggest for a plan, and what a fresh session saves.
// Deterministic and local: plain text rules over the plan (no model call, no network). Pure functions.
//
// Rules (also in the README):
//   Opus · max    huge or open-ended: > 2,000 words, 20+ files, 6+ areas, 4+ open questions, or security AND migration
//   Opus · high   multi-module or risky: 5+ files, 2+ areas, 10+ steps, > 700 words, or security / migration / refactor
//   Sonnet · medium  everything else (routine)
const f = require('./format');
const { rateFor } = require('./pricing');

// Model aliases and effort levels as listed by `claude --help` (Claude Code 2.1):
//   --model <model>   "an alias for the latest model (e.g. 'opus' or 'sonnet') or a model's full name"
//   --effort <level>  "low, medium, high, xhigh, max"
const MODELS = ['opus', 'sonnet'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,80}$/;

const EXT = 'ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|c|h|cpp|hpp|sql|json|ya?ml|toml|ini|md|css|scss|less|html|vue|svelte|sh|ps1|psm1|bat|tf|proto|graphql|gradle|xml|csproj|sln|lock';
const PATH_RE = new RegExp(String.raw`(?:[A-Za-z]:)?(?:[\w.@~-]+[\\/])+[\w.@-]+(?:\.(?:${EXT}))?(?![\w/\\])|\b[\w.-]+\.(?:${EXT})\b`, 'g');
const GROUP_DIRS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'services', 'pkg', 'internal', 'modules', 'components', 'server', 'client']);
const KW = {
  security: /\b(auth(?:entication|orization|z|n)?|security|secure|permissions?|credentials?|secrets?|passwords?|oauth|sso|saml|csrf|xss|injection|encrypt\w*|decrypt\w*|rbac|acl|vulnerab\w*|sanitiz\w*|api[ -]?keys?|jwt|access tokens?|session tokens?)\b/i,
  migration: /\b(migrat\w*|schema|backfill\w*|data ?model|database|alter table|upgrade path|breaking changes?)\b/i,
  refactor: /\b(refactor\w*|restructur\w*|rewrit\w*|re-?architect\w*|consolidat\w*|decoupl\w*)\b/i,
};
const OPEN_RE = /\b(TBD|TBC|unclear|unknown|unsure|not sure|investigate|figure out|open questions?|to be decided|undecided|spike)\b/gi;

function stripNoise(text) {
  return String(text || '').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/https?:\/\/\S+/g, ' ');
}

function areaOf(p) {
  const segs = p.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '').replace(/^\.?\//, '').split('/').filter(Boolean);
  if (segs.length < 2) return '(root)';
  if (GROUP_DIRS.has(segs[0].toLowerCase()) && segs.length > 2) return segs[0] + '/' + segs[1];
  return segs[0];
}

function features(planText) {
  const text = stripNoise(planText);
  const words = (text.match(/\S+/g) || []).length;
  const files = new Set();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0].replace(/[.,:;)]+$/, '');
    if (!/[\\/]/.test(p) && !new RegExp(String.raw`\.(?:${EXT})$`).test(p)) continue;
    if (/^\d+(\.\d+)+$/.test(p) || /^(e\.g|i\.e)\b/i.test(p)) continue;
    // a slash-separated phrase like "and/or" or "read/write" is not a file
    if (!/\.(?:\w{1,6})$/.test(p) && p.split(/[\\/]/).filter(Boolean).length < 3 && !/^[.~]?[\\/]/.test(p)) continue;
    files.add(p.replace(/\\/g, '/'));
  }
  const areas = new Set([...files].map(areaOf));
  const steps = (text.match(/^\s*(?:[-*+]|\d+[.)])\s+\S/gm) || []).length;
  const open = (text.match(OPEN_RE) || []).length + (text.match(/\?\s*$/gm) || []).length;
  const kw = {};
  for (const [k, re] of Object.entries(KW)) kw[k] = re.test(text);
  return { words, chars: text.length, files: [...files], fileCount: files.size, areas: [...areas], areaCount: areas.size, steps, open, kw };
}

function plural(n, one, many) { return `${f.count(n)} ${n === 1 ? one : many || one + 's'}`; }

// -> { model, effort, tier, reason, features }
function suggest(planText) {
  const x = features(planText);
  const risky = ['security', 'migration', 'refactor'].filter((k) => x.kw[k]);
  const filesTxt = x.fileCount ? `${plural(x.fileCount, 'file')} in ${plural(x.areaCount, 'area')}` : 'no files named';
  const mentions = risky.length ? `; mentions ${risky.join(', ')}` : '';
  if (x.words > 2000 || x.fileCount >= 20 || x.areaCount >= 6 || x.open >= 4 || (x.kw.security && x.kw.migration)) {
    const why = [];
    if (x.words > 2000) why.push(`${f.count(x.words)} words`);
    if (x.fileCount >= 20 || x.areaCount >= 6) why.push(filesTxt);
    if (x.open >= 4) why.push(plural(x.open, 'open question'));
    if (x.kw.security && x.kw.migration) why.push('security and migration');
    return { model: 'opus', effort: 'max', tier: 'huge', reason: `Large or open-ended: ${why.join(', ')}.`, features: x };
  }
  if (x.fileCount >= 5 || x.areaCount >= 2 || x.steps >= 10 || x.words > 700 || risky.length) {
    const lead = x.areaCount >= 2 || x.fileCount >= 5 ? 'Multi-module' : risky.length ? 'Risky change' : 'Sizeable plan';
    const extra = x.steps >= 10 ? `, ${plural(x.steps, 'step')}` : x.words > 700 ? `, ${f.count(x.words)} words` : '';
    return { model: 'opus', effort: 'high', tier: 'multi', reason: `${lead}: ${filesTxt}${extra}${mentions}.`, features: x };
  }
  return { model: 'sonnet', effort: 'medium', tier: 'routine', reason: `Routine: ${filesTxt}, ${plural(x.words, 'word')}, no risky keywords.`, features: x };
}

function median(nums) {
  const a = nums.filter((n) => n > 0).sort((p, q) => p - q);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// What a fresh session would start at vs what the current session re-sends on every request.
// Fresh = the median first-request context of this project's sessions (system prompt, tools, CLAUDE.md, first prompt)
// plus the plan itself (characters / 4). Falls back to all sessions, then to FRESH_FALLBACK when there is no history.
const FRESH_FALLBACK = 20000;
function savings(o) {
  const opt = o || {};
  const sessions = opt.sessions || [];
  const planTokens = Math.round((opt.planChars || 0) / 4);
  const inProject = sessions.filter((x) => opt.cwd && x.cwd && x.cwd === opt.cwd).map((x) => x.firstCtx);
  let base = median(inProject), basis = 'this project\'s sessions';
  if (!base) { base = median(sessions.map((x) => x.firstCtx)); basis = 'your sessions'; }
  if (!base) { base = FRESH_FALLBACK; basis = 'assumed'; }
  const fresh = base + planTokens;
  const src = opt.sid ? sessions.find((x) => x.sid === opt.sid) : null;
  const out = { fresh, base, basis, planTokens, current: 0, model: '', perRequestWarm: 0, perRequestCold: 0, saves: false, text: '' };
  if (!src || !src.lastCtx) {
    out.text = `A fresh session starts at about ${f.tokensK(fresh)} tokens.`;
    return out;
  }
  const r = rateFor(src.lastModel, opt.pricingOverrides);
  const read = (r.cacheRead != null ? r.cacheRead : r.input * 0.1) / 1e6;
  const write = (r.cacheWrite5m != null ? r.cacheWrite5m : r.input * 1.25) / 1e6;
  out.current = src.lastCtx; out.model = src.lastModel;
  const diff = src.lastCtx - fresh;
  out.perRequestWarm = diff * read; out.perRequestCold = diff * write;
  out.saves = diff > 0;
  out.text = diff > 0
    ? `A fresh session starts at about ${f.tokensK(fresh)} tokens instead of re-sending ${f.tokensK(src.lastCtx)}: about ${f.usdSmall(out.perRequestWarm)} less per request (${f.usdSmall(out.perRequestCold)} after a cache expiry).`
    : `A fresh session starts at about ${f.tokensK(fresh)} tokens; this session is at ${f.tokensK(src.lastCtx)}, so a new one saves little on context.`;
  return out;
}

function validModel(m) { return SAFE_MODEL.test(String(m || '')); }
function validEffort(e) { return EFFORTS.includes(e); }

// The command typed into the new terminal. The plan goes in as the first prompt through an @-mention of the saved
// file (Claude Code expands it into the prompt). Only checked values reach the command line: a model alias/name
// from SAFE_MODEL, an effort from EFFORTS and a relative path made of safe characters.
function launchCommand(o) {
  if (!validModel(o.model)) throw new Error('Unsupported model name: ' + o.model);
  if (!validEffort(o.effort)) throw new Error('Unsupported effort level: ' + o.effort);
  const rel = String(o.relPath || '').replace(/\\/g, '/');
  if (!/^[A-Za-z0-9._/-]+\.md$/.test(rel) || rel.includes('..')) throw new Error('Unexpected plan file name: ' + rel);
  const prompt = `@${rel} Implement this plan. It was written in an earlier session, so read the files it names before changing them.`;
  return { cmd: o.command || 'claude', args: ['--model', o.model, '--effort', o.effort, prompt], line: `${o.command || 'claude'} --model ${o.model} --effort ${o.effort} "${prompt}"` };
}

function label(model, effort) {
  const m = { opus: 'Opus', sonnet: 'Sonnet' }[model] || model;
  return `${m} · ${effort}`;
}

module.exports = { suggest, features, savings, launchCommand, label, validModel, validEffort, median, MODELS, EFFORTS, FRESH_FALLBACK };
