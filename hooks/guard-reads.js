#!/usr/bin/env node
'use strict';
// PreToolUse guard: stops Claude from spending tokens on files that are almost never worth reading.
//
//   matcher: Read|Grep|Glob       (Read uses tool_input.file_path; Grep and Glob use tool_input.path)
//   denies:  node_modules/dist/build/... folders, lockfiles, minified bundles and source maps,
//            binary files (executables, archives, databases, media, fonts), and text files larger than
//            --max-kb that would be read in full (no offset/limit given).
//   allows:  everything else; images and PDFs unless larger than --max-binary-kb.
//
// What this is NOT: a security boundary. Claude can still reach a file through a Bash command (cat, type).
// For a hard rule use the permissions.deny snippet (hooks/permissions-deny.snippet.json) as well.
//
// Options (hook "args"): --mode deny|ask|warn  (default deny)
//                        --max-kb 200          (largest text file read in full)
//                        --max-binary-kb 4096  (largest image/PDF)
//                        --allow <text>        (repeatable; a path containing <text> is never blocked)
const fs = require('fs');
const { readInput, parseArgs, num, emit, segments, baseName } = require('./_common');

const DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'coverage', '.git',
  '__pycache__', '.venv', '.gradle', 'bower_components', '.angular', '.svelte-kit']);
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'pubspec.lock', 'packages.lock.json', 'gradle.lockfile']);
const MINIFIED = /(\.min\.(js|mjs|cjs|css)|[.-]min\.(js|css)|\.(js|css|mjs)\.map|\.bundle\.js|\.chunk\.js)$/i;
const BINARY_EXT = new Set(['exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'o', 'obj', 'a', 'lib', 'pdb', 'class', 'pyc', 'pyo', 'jar', 'war', 'wasm',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'iso', 'dmg', 'msi', 'nupkg', 'whl',
  'db', 'sqlite', 'sqlite3', 'mdb', 'parquet', 'pkl', 'npy', 'npz', 'h5', 'onnx', 'pt', 'safetensors',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'psd', 'ai', 'xlsx', 'xls', 'docx', 'pptx']);
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf']); // Claude Code reads these natively

const ext = (p) => { const b = baseName(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
const kb = (n) => Math.round(n / 1024);

function looksBinary(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch { return false; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

// Returns null (allow) or { reason }.
function check(toolName, input, opts) {
  const o = opts || {};
  const target = toolName === 'Read' ? input.file_path : input.path;
  if (!target || typeof target !== 'string') return null;
  const low = target.replace(/\\/g, '/').toLowerCase();
  if ((o.allow || []).some((a) => a && low.includes(String(a).replace(/\\/g, '/').toLowerCase()))) return null;

  const segs = segments(target).map((s) => s.toLowerCase());
  const hit = segs.find((s) => DIRS.has(s));
  if (hit) return { reason: `${hit}/ holds generated or third-party files that rarely help and cost many tokens. Search the project's own source instead (Grep with a narrower path). If you truly need this, ask the user to allow it.` };
  if (toolName !== 'Read') return null; // Grep/Glob: only the folder rule applies

  const name = baseName(target).toLowerCase();
  if (LOCKFILES.has(name)) return { reason: `${baseName(target)} is a lockfile: very large, machine-generated, and almost never the answer. Read package.json (or the manifest) instead, or Grep for the one entry you need.` };
  if (MINIFIED.test(name)) return { reason: `${baseName(target)} is minified or a source map (one giant line). Read the original source file instead.` };

  const e = ext(target);
  let st = null;
  try { st = fs.statSync(target); } catch { /* missing file: let Read report it */ }
  if (st && st.isDirectory()) return null;
  if (BINARY_EXT.has(e)) return { reason: `${baseName(target)} is a binary file (.${e}); its bytes are not useful as text. Use a tool that extracts what you need, or ask the user.` };
  if (MEDIA_EXT.has(e)) {
    const lim = num(o['max-binary-kb'], 4096);
    if (st && st.size > lim * 1024) return { reason: `${baseName(target)} is ${kb(st.size)} KB (limit ${lim} KB). Ask the user for a smaller or cropped version.` };
    return null;
  }
  if (!st) return null;
  if (st.size > 0 && looksBinary(target)) return { reason: `${baseName(target)} looks like a binary file. Reading it as text wastes tokens.` };
  const bounded = Number.isFinite(input.limit) || Number.isFinite(input.offset);
  const max = num(o['max-kb'], 200);
  if (!bounded && st.size > max * 1024) {
    return { reason: `${baseName(target)} is ${kb(st.size)} KB (about ${Math.round(st.size / 4000)}k tokens; limit ${max} KB). Use Grep to find the part you need, then Read with offset and limit.` };
  }
  return null;
}

// Pure decision: hook input -> hook output object (or null to stay silent).
function decide(event, opts) {
  if (!event || event.hook_event_name !== 'PreToolUse') return null;
  const tool = event.tool_name;
  if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob') return null;
  const res = check(tool, event.tool_input || {}, opts);
  if (!res) return null;
  const mode = (opts && opts.mode) || 'deny';
  const why = 'Token-Saver: ' + res.reason;
  if (mode === 'warn') return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: why } };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: mode === 'ask' ? 'ask' : 'deny', permissionDecisionReason: why } };
}

async function main() {
  try {
    const event = await readInput();
    const opts = parseArgs(process.argv.slice(2), ['allow']);
    const out = decide(event, opts);
    if (out) emit(out);
  } catch { /* fail open */ }
  process.exitCode = 0;
}

if (require.main === module) main();
module.exports = { decide, check };
