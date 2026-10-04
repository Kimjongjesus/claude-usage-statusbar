'use strict';
// Where Claude Code keeps its transcripts, resolved with an injectable path module so the
// Windows rules (path.win32) can be unit-tested on any OS. No fs access in here.
const path = require('path');

function envGet(env, key, caseInsensitive) {
  if (!env) return undefined;
  if (env[key] !== undefined) return env[key];
  if (caseInsensitive) {
    const want = key.toLowerCase();
    for (const k of Object.keys(env)) if (k.toLowerCase() === want) return env[k];
  }
  return undefined;
}

function stripQuotes(s) {
  return String(s).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

function expand(raw, { env, home, pathMod, isWin }) {
  let s = stripQuotes(raw);
  if (isWin) {
    // %USERPROFILE%\.claude  (unknown variables are left as-is)
    s = s.replace(/%([^%]+)%/g, (m, k) => { const v = envGet(env, k, true); return v === undefined ? m : v; });
  } else {
    s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (m, a, b) => { const v = envGet(env, a || b, false); return v === undefined ? m : v; });
  }
  if (home && (s === '~' || s.startsWith('~/') || s.startsWith('~\\'))) s = pathMod.join(home, s.slice(1));
  return s;
}

function normalizeDir(raw, ctx) {
  let s = expand(raw, ctx);
  if (!s) return null;
  const { pathMod, home } = ctx;
  if (!pathMod.isAbsolute(s)) {
    if (!home) return null; // a relative path has no stable meaning without a home dir
    s = pathMod.join(home, s);
  }
  s = pathMod.normalize(s);
  // Drop trailing separators but keep roots like C:\ or /.
  while (s.length > 1 && /[\\/]$/.test(s) && pathMod.parse(s).root !== s) s = s.slice(0, -1);
  return s;
}

// Candidate `projects` directories, in priority order, de-duplicated (case-insensitive on Windows).
function resolveDirs(opts) {
  const o = opts || {};
  const pathMod = o.pathMod || path;
  const env = o.env || {};
  const isWin = o.isWin !== undefined ? o.isWin : pathMod === path.win32;
  const home = o.homedir || envGet(env, 'USERPROFILE', true) || envGet(env, 'HOME', false) || '';
  const ctx = { env, home, pathMod, isWin };
  const found = [];
  const add = (p) => { const n = normalizeDir(p, ctx); if (n) found.push(n); };

  if (home) {
    add(pathMod.join(home, '.claude', 'projects'));
    add(pathMod.join(home, '.config', 'claude', 'projects'));
  }
  const xdg = envGet(env, 'XDG_CONFIG_HOME', isWin);
  if (xdg && !isWin) add(pathMod.join(xdg, 'claude', 'projects'));
  const cfg = envGet(env, 'CLAUDE_CONFIG_DIR', isWin);
  if (cfg) {
    // pathMod.delimiter is ';' on Windows (C:\a;D:\b) and ':' on POSIX.
    for (const d of String(cfg).split(pathMod.delimiter)) {
      if (stripQuotes(d)) add(pathMod.join(expand(d, ctx), 'projects'));
    }
  }
  // User-provided directories are taken as the `projects` dir itself.
  for (const d of o.extra || []) if (d && stripQuotes(d)) add(d);

  const seen = new Set();
  const out = [];
  for (const p of found) {
    const key = isWin ? p.toLowerCase() : p;
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }
  return out;
}

// Last path segment of a Windows or POSIX path, whichever separators it uses.
function lastSegment(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
function lastSegments(p, n) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.slice(-n).join('/');
}

module.exports = { resolveDirs, lastSegment, lastSegments, envGet };
