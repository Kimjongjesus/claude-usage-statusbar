#!/usr/bin/env node
'use strict';
// PostToolUse trimmer: shortens huge Bash / PowerShell / MCP tool output BEFORE Claude sees it, keeping the
// start and the end (where errors and summaries usually are) and dropping the middle.
//
//   matcher: Bash|PowerShell|mcp__.*
//
// What the hooks API allows (https://code.claude.com/docs/en/hooks, PostToolUse): `updatedToolOutput` replaces the
// tool's result, but for built-in tools the replacement must match the tool's own output shape or Claude Code
// ignores it. That shape is documented only for Bash (stdout, stderr, interrupted, isImage). So this hook:
//   - trims Bash and PowerShell results by shortening their stdout/stderr strings and keeping every other field,
//   - trims MCP results by shortening text strings in the shape it received (MCP output is not schema-checked),
//   - does NOT touch Read, Grep or Glob (their output shape is not documented, a wrong guess would be ignored).
//     Use guard-reads.js to keep those from returning huge results in the first place.
// Honest limits: it only changes what Claude sees afterwards. The command has already run, and Claude Code's
// own transcript still records the original output. Claude Code already caps Bash output at ~30,000 characters
// (BASH_MAX_OUTPUT_LENGTH), so this hook mainly matters if you want a tighter cap than that.
//
// Options (hook "args"): --max-chars 15000   (trim any single text field longer than this)
//                        --keep 6000         (characters kept from the start AND from the end)
const { readInput, parseArgs, num, emit } = require('./_common');

function trimText(s, max, keep) {
  if (typeof s !== 'string' || s.length <= max) return { text: s, trimmed: 0 };
  const k = Math.min(keep, Math.floor(max / 2));
  const cut = s.length - 2 * k;
  const marker = `\n… [Token-Saver trimmed ${cut.toLocaleString('en-US')} of ${s.length.toLocaleString('en-US')} characters from the middle. Re-run with head, tail or grep if you need the omitted part.] …\n`;
  return { text: s.slice(0, k) + marker + s.slice(s.length - k), trimmed: cut };
}

// Returns { value, trimmed } where value has the SAME shape as `resp` with long strings shortened.
function trimValue(resp, max, keep) {
  if (typeof resp === 'string') { const r = trimText(resp, max, keep); return { value: r.text, trimmed: r.trimmed }; }
  if (Array.isArray(resp)) {
    let trimmed = 0;
    const value = resp.map((b) => {
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
        const r = trimText(b.text, max, keep); trimmed += r.trimmed; return Object.assign({}, b, { text: r.text });
      }
      return b;
    });
    return { value, trimmed };
  }
  if (resp && typeof resp === 'object') {
    let trimmed = 0;
    const value = Object.assign({}, resp);
    for (const key of ['stdout', 'stderr']) {
      if (typeof value[key] === 'string') { const r = trimText(value[key], max, keep); value[key] = r.text; trimmed += r.trimmed; }
    }
    if (Array.isArray(value.content)) { const r = trimValue(value.content, max, keep); value.content = r.value; trimmed += r.trimmed; }
    return { value, trimmed };
  }
  return { value: resp, trimmed: 0 };
}

function decide(event, opts) {
  if (!event || event.hook_event_name !== 'PostToolUse') return null;
  const tool = String(event.tool_name || '');
  if (!(tool === 'Bash' || tool === 'PowerShell' || tool.startsWith('mcp__'))) return null;
  if (event.tool_response === undefined || event.tool_response === null) return null;
  const max = Math.max(1000, num(opts && opts['max-chars'], 15000));
  const keep = Math.max(200, num(opts && opts.keep, 6000));
  const { value, trimmed } = trimValue(event.tool_response, max, keep);
  if (!trimmed) return null;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: value } };
}

async function main() {
  try {
    const event = await readInput();
    const out = decide(event, parseArgs(process.argv.slice(2)));
    if (out) emit(out);
  } catch { /* fail open */ }
  process.exitCode = 0;
}

if (require.main === module) main();
module.exports = { decide, trimText, trimValue };
