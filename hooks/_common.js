'use strict';
// Shared helpers for the Token-Saver hook scripts. Node built-ins only, no network, no child processes.
//
// Contract with Claude Code (https://code.claude.com/docs/en/hooks): a command hook receives the event as
// JSON on stdin and answers with exit code 0 plus a JSON object on stdout (exit 2 = block). Every script here
// FAILS OPEN: if its input is unreadable or anything throws, it prints nothing and exits 0, so a bug in a
// token-saving hook can never stop you from working.

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; } // run by hand: do not wait for input
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

async function readInput() {
  try { return JSON.parse(await readStdin()); } catch { return null; }
}

// "--mode deny --max-kb 200 --allow a --allow b"  ->  { mode: 'deny', 'max-kb': '200', allow: ['a', 'b'] }
function parseArgs(argv, multi) {
  const out = {};
  const list = new Set(multi || []);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : 'true';
    if (list.has(key)) (out[key] = out[key] || []).push(val); else out[key] = val;
  }
  return out;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// Windows paths arrive with backslashes (hooks docs); compare on '/' and case-insensitively.
function segments(p) { return String(p || '').split(/[\\/]+/).filter(Boolean); }
function baseName(p) { const s = segments(p); return s.length ? s[s.length - 1] : ''; }

module.exports = { readInput, parseArgs, num, emit, segments, baseName };
