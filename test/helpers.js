'use strict';
// Builds fake ~/.claude/projects trees for tests.
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpdir(prefix) {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix || 'cu-'));
  made.push(d);
  return d;
}
const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

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

// Richer transcript lines (v0.3): session id, branch, tool calls, tool results, titles, full usage shape.
// usage: { input, output, read, write5m, write1h }. Sonnet 4.5: input $3/M, output $15/M, cache read $0.30/M,
// 5m write $3.75/M, 1h write $6/M.
let rseq = 0;
function asst({ at, sid, branch, cwd, model, usage, tools, side, id, content, stop }) {
  rseq++;
  const n = id || 'x' + rseq;
  const u = usage || {};
  const w5 = u.write5m || 0, w1 = u.write1h || 0;
  const blocks = content || (tools || []).map((t, i) => ({ type: 'tool_use', id: t.id || `tu${n}_${i}`, name: t.name, input: t.input || {} }));
  const rec = {
    type: 'assistant', timestamp: at.toISOString(), requestId: 'rq' + n, uuid: 'au' + n, sessionId: sid, isSidechain: !!side,
    cwd: cwd || 'C:\\Users\\Alex\\work\\hub', gitBranch: branch === undefined ? 'main' : branch,
    message: {
      id: 'ms' + n, model: model || 'claude-sonnet-4-5', content: blocks, stop_reason: stop === undefined ? null : stop,
      usage: { input_tokens: u.input || 0, output_tokens: u.output || 0, cache_read_input_tokens: u.read || 0,
        cache_creation_input_tokens: w5 + w1, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 } },
    },
  };
  return JSON.stringify(rec);
}
// A plain user prompt line (no usage), as Claude Code writes it.
function userLine({ at, sid, cwd, side, text }) {
  rseq++;
  return JSON.stringify({ type: 'user', timestamp: at.toISOString(), uuid: 'up' + rseq, sessionId: sid, isSidechain: !!side, cwd: cwd || 'C:\\Users\\Alex\\work\\hub', message: { role: 'user', content: text || 'go on' } });
}
function toolResult({ at, sid, toolUseId, chars, cwd, branch }) {
  rseq++;
  return JSON.stringify({
    type: 'user', timestamp: at.toISOString(), uuid: 'ur' + rseq, sessionId: sid, cwd: cwd || 'C:\\Users\\Alex\\work\\hub', gitBranch: branch === undefined ? 'main' : branch,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'x'.repeat(chars) }] },
  });
}
const titleLine = (sid, title) => JSON.stringify({ type: 'ai-title', sessionId: sid, aiTitle: title });

module.exports = { tmpdir, line, writeProjects, M15, asst, toolResult, titleLine, userLine };
