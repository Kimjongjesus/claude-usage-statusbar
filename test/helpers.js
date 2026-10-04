'use strict';
// Builds fake ~/.claude/projects trees for tests.
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpdir(prefix) { return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix || 'cu-')); }

let seq = 0;
// One assistant message line. `at` is a Date (local time); output tokens drive the cost.
function line({ at, model, out, input, cacheRead, cwd, id, req }) {
  seq++;
  const n = id || 'm' + seq;
  const rec = {
    type: 'assistant', timestamp: at.toISOString(), requestId: req || 'r' + n, uuid: 'u' + n,
    message: { id: n, model: model || 'claude-sonnet-4-5', usage: { input_tokens: input || 0, output_tokens: out || 0, cache_read_input_tokens: cacheRead || 0 } },
  };
  if (cwd) rec.cwd = cwd;
  return JSON.stringify(rec);
}

// files: { 'projA/s1.jsonl': [line, line], ... }
function writeProjects(root, files) {
  for (const [rel, lines] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, lines.join('\n') + '\n');
  }
}

// 1M sonnet output tokens = $15 exactly.
const M15 = 1000000;

module.exports = { tmpdir, line, writeProjects, M15 };
