'use strict';
// Plan handoffs written by hooks/save-plan.js into <project>/.claude/handoffs/<time>.md. Read-only: this module
// lists and parses those files; it never writes, moves or deletes them. Which ones were already offered is kept
// in VS Code's global state by the extension, not on disk.
const fs = require('fs');
const path = require('path');
const f = require('./format');

const FRESH_MS = 60 * 60 * 1000;  // only plans saved in the last hour are offered (no flood of old ones on startup)
const MAX_BYTES = 512 * 1024;
const NAME_RE = /^\d{8}-\d{6}(?:-\d{1,2})?\.md$/;

function handoffDir(root, pm) { return (pm || path).join(root, '.claude', 'handoffs'); }

// Newest first. roots: folders to look in (the workspace folders). Missing folders are skipped quietly.
function list(roots, o) {
  const opt = o || {};
  const out = [];
  for (const root of roots || []) {
    const dir = handoffDir(root);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!NAME_RE.test(name)) continue;
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      out.push({ file, name, root, relPath: '.claude/handoffs/' + name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? 1 : -1));
  return opt.limit ? out.slice(0, opt.limit) : out;
}

// "---\nkey: value\n---\n\n<plan>" -> { meta, plan, title }
function parse(text) {
  const s = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const meta = {};
  let plan = s;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    plan = s.slice(m[0].length);
  }
  plan = plan.replace(/^\n+/, '');
  const heading = /^#{1,3}\s+(.+)$/m.exec(plan);
  const firstLine = plan.split('\n').find((l) => l.trim()) || '';
  const title = f.ellipsize((heading ? heading[1] : firstLine).replace(/^(plan|implementation plan)\s*[:\-–]\s*/i, '').replace(/[`*_]/g, '').trim() || 'Untitled plan', 80);
  return { meta, plan, title };
}

function read(entry) {
  try { return Object.assign({}, entry, parse(fs.readFileSync(entry.file, 'utf8'))); } catch { return null; }
}

const keyOf = (e) => e.file + '|' + Math.round(e.mtimeMs);

// The handoffs to offer now: saved within FRESH_MS of `now` and not offered before (by file + mtime).
function pending(entries, seen, now) {
  const done = new Set(seen || []);
  const t = +(now || new Date());
  return entries.filter((e) => !done.has(keyOf(e)) && t - e.mtimeMs <= FRESH_MS && e.mtimeMs - t <= 60000);
}

module.exports = { list, parse, read, pending, keyOf, handoffDir, FRESH_MS, NAME_RE };
